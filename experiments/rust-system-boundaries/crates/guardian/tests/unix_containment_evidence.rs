#![cfg(unix)]

#[path = "../src/unix_containment.rs"]
mod unix_containment;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use unix_containment::{is_process_alive, process_group_id, session_id, signal_process_group};

#[cfg(target_os = "macos")]
use unix_containment::UnixContainmentGate;
#[cfg(target_os = "linux")]
use unix_containment::{LinuxCgroupV2Blocker, LinuxCgroupV2Tree, LinuxPidFd, UnixContainmentGate};

fn escape_fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fixture-setsid-escape"))
}

fn wait_until(timeout: Duration, predicate: impl Fn() -> bool) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if predicate() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert!(predicate(), "condition did not become true before timeout");
}

fn read_status(path: &Path) -> BTreeMap<String, u32> {
    let mut values = BTreeMap::new();
    for line in fs::read_to_string(path)
        .expect("escape status reads")
        .lines()
    {
        let (name, value) = line.split_once('=').expect("name=value line");
        values.insert(
            name.to_owned(),
            value.parse::<u32>().expect("numeric process identity"),
        );
    }
    values
}

struct EscapeTree {
    wrapper: Option<Child>,
    stop_path: PathBuf,
    escapee_pid: u32,
    leaf_pid: u32,
}

impl EscapeTree {
    fn start(temp: &TempDir) -> Self {
        use std::os::unix::process::CommandExt;

        let ready_path = temp.path().join("escape.ready");
        let stop_path = temp.path().join("escape.stop");
        let mut command = Command::new(escape_fixture());
        command
            .args([
                "--mode",
                "wrapper",
                "--ready-path",
                ready_path.to_str().expect("UTF-8 ready path"),
                "--stop-path",
                stop_path.to_str().expect("UTF-8 stop path"),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // The wrapper owns an initial dedicated process group. Its child
            // can then prove that setsid escapes from that exact group.
            .process_group(0);
        let wrapper = command.spawn().expect("synthetic wrapper starts");
        let wrapper_pid = wrapper.id();
        wait_until(Duration::from_secs(3), || ready_path.exists());
        let status = read_status(&ready_path);
        assert_eq!(
            status.get("escapee_pgid").copied(),
            status.get("escapee_pid").copied(),
            "setsid must make the escapee a new process-group leader"
        );
        assert_eq!(
            status.get("escapee_sid").copied(),
            status.get("escapee_pid").copied(),
            "setsid must make the escapee a new session leader"
        );
        assert_eq!(
            process_group_id(wrapper_pid).expect("wrapper process group"),
            wrapper_pid as i32,
            "the wrapper must begin in its own process group"
        );
        let escapee_pid = *status.get("escapee_pid").expect("escapee PID");
        let leaf_pid = *status.get("leaf_pid").expect("leaf PID");
        Self {
            wrapper: Some(wrapper),
            stop_path,
            escapee_pid,
            leaf_pid,
        }
    }

    fn wrapper_pid(&self) -> u32 {
        self.wrapper.as_ref().expect("wrapper still owned").id()
    }

    fn stop(&mut self) {
        let _ = fs::write(&self.stop_path, b"stop");
        if let Some(wrapper) = self.wrapper.as_mut() {
            let _ = wrapper.wait();
        }
        wait_until(Duration::from_secs(3), || {
            !is_process_alive(self.escapee_pid)
        });
        wait_until(Duration::from_secs(3), || !is_process_alive(self.leaf_pid));
    }
}

impl Drop for EscapeTree {
    fn drop(&mut self) {
        // The fixture observes this file itself. Do not issue a raw PID kill in
        // cleanup: the test is specifically proving that raw PID control is
        // not an acceptable recovered-custody primitive.
        let _ = fs::write(&self.stop_path, b"stop");
    }
}

#[test]
fn unix_process_group_fails_to_contain_a_sets_id_escape() {
    let temp = TempDir::new().expect("temporary root");
    let mut tree = EscapeTree::start(&temp);
    let wrapper_pid = tree.wrapper_pid();
    let escaped_process_group = process_group_id(tree.escapee_pid).expect("escapee process group");
    let escaped_session = session_id(tree.escapee_pid).expect("escapee session");
    assert_ne!(escaped_process_group, wrapper_pid as i32);
    assert_eq!(escaped_process_group, tree.escapee_pid as i32);
    assert_eq!(escaped_session, tree.escapee_pid as i32);

    signal_process_group(wrapper_pid as i32, libc::SIGTERM)
        .expect("fixture-owned wrapper group accepts SIGTERM");
    let exit = tree
        .wrapper
        .as_mut()
        .expect("wrapper still owned")
        .wait()
        .expect("wrapper wait succeeds");
    assert!(
        !exit.success(),
        "SIGTERM must terminate the original group leader"
    );
    assert!(
        is_process_alive(tree.escapee_pid),
        "setsid escapee must survive a signal sent to the original process group"
    );
    assert!(
        is_process_alive(tree.leaf_pid),
        "the escaped session's leaf must also survive the original group signal"
    );
    tree.stop();
}

#[cfg(target_os = "linux")]
#[test]
fn linux_pidfd_closes_the_identity_check_to_signal_race_but_not_tree_containment() {
    let temp = TempDir::new().expect("temporary root");
    let mut tree = EscapeTree::start(&temp);
    let pidfd = LinuxPidFd::open(tree.escapee_pid).expect(
        "Linux kernel must support pidfd_open for this evidence; a production Host must fail closed if it does not",
    );

    signal_process_group(tree.wrapper_pid() as i32, libc::SIGTERM)
        .expect("fixture-owned wrapper group accepts SIGTERM");
    let _ = tree
        .wrapper
        .as_mut()
        .expect("wrapper still owned")
        .wait()
        .expect("wrapper wait succeeds");
    assert!(is_process_alive(tree.escapee_pid));

    pidfd
        .send_signal(libc::SIGKILL)
        .expect("pidfd must signal the exact escapee without a second PID lookup");
    assert!(
        pidfd
            .wait_for_exit(Duration::from_secs(3))
            .expect("pidfd exit poll succeeds"),
        "pidfd must observe the exact target exit"
    );
    let after_exit = pidfd
        .send_signal(libc::SIGKILL)
        .expect_err("a pidfd for an exited process must never target a later reused PID");
    assert_eq!(after_exit.raw_os_error(), Some(libc::ESRCH));
    assert!(
        is_process_alive(tree.leaf_pid),
        "pidfd protects one process identity; it must not be misrepresented as process-tree containment"
    );
    tree.stop();
}

#[cfg(target_os = "linux")]
#[test]
fn linux_cgroup_v2_gate_fails_closed_without_a_host_owned_delegated_leaf() {
    // Keep the destructive cgroup.kill path compiled without ever applying it
    // to the host's shared cgroup hierarchy during a test.
    let _kill_tree_api: fn(&LinuxCgroupV2Tree) -> std::io::Result<()> =
        LinuxCgroupV2Tree::kill_tree;

    assert!(matches!(
        unix_containment::linux_containment_gate(None),
        UnixContainmentGate::LinuxRequiresDelegatedCgroupV2 {
            blocker: LinuxCgroupV2Blocker::MissingExplicitDelegatedRoot,
        }
    ));

    let temp = TempDir::new().expect("temporary root");
    assert!(matches!(
        unix_containment::linux_containment_gate(Some(temp.path())),
        UnixContainmentGate::LinuxRequiresDelegatedCgroupV2 {
            blocker: LinuxCgroupV2Blocker::NotCgroupV2Filesystem { .. },
        }
    ));
}

#[cfg(target_os = "macos")]
#[test]
fn macos_sets_id_escape_fails_closed_without_a_stable_tree_custody_primitive() {
    match unix_containment::macos_containment_gate() {
        UnixContainmentGate::MacosFailClosed { blocker } => {
            assert!(blocker.contains("pidfd"));
            assert!(blocker.contains("cgroup-v2"));
        }
    }
}
