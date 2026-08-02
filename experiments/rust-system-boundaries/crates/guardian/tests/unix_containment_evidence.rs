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

#[cfg(target_os = "linux")]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
#[cfg(target_os = "macos")]
use unix_containment::UnixContainmentGate;
#[cfg(target_os = "linux")]
use unix_containment::{
    LinuxCgroupV2Blocker, LinuxCgroupV2Child, LinuxCgroupV2Tree, LinuxPidFd, LinuxWorkloadIdentity,
    UnixContainmentGate,
};

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

#[cfg(target_os = "linux")]
struct IsolatedCgroupLeaf {
    path: PathBuf,
    tree: Option<LinuxCgroupV2Tree>,
}

#[cfg(target_os = "linux")]
impl IsolatedCgroupLeaf {
    fn create() -> Self {
        let root = isolated_cgroup_test_root();
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("wall clock is after Unix epoch")
            .as_nanos();
        let path = root.join(format!(
            "guardian-e2e-{}-{unique_suffix}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("Host creates a fresh dedicated cgroup leaf");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("Host makes the dedicated leaf private before it launches a workload");
        assert_root_owned_private_cgroup_directory(&path, "dedicated cgroup leaf");
        let tree = match LinuxCgroupV2Tree::open_new_host_owned_leaf(&path) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = fs::remove_dir(&path);
                panic!("fresh Host-created cgroup leaf must be admissible: {error}");
            }
        };
        assert!(
            tree.member_process_ids()
                .expect("fresh cgroup member scan succeeds")
                .is_empty(),
            "a fresh test leaf must not adopt another process"
        );
        Self {
            path,
            tree: Some(tree),
        }
    }

    fn tree(&self) -> &LinuxCgroupV2Tree {
        self.tree.as_ref().expect("test leaf remains owned")
    }

    fn remove_empty(&mut self) {
        let tree = self.tree.take().expect("test leaf remains owned");
        assert!(
            tree.wait_until_empty(Duration::from_secs(5))
                .expect("final cgroup empty check succeeds"),
            "the final orphan scan must find no cgroup members"
        );
        drop(tree);
        fs::remove_dir(&self.path).expect("empty Host-owned cgroup leaf removes");
    }
}

#[cfg(target_os = "linux")]
struct CgroupWorkload {
    leaf: IsolatedCgroupLeaf,
    root: Option<LinuxCgroupV2Child>,
}

#[cfg(target_os = "linux")]
impl CgroupWorkload {
    fn spawn(
        fixture: &Path,
        arguments: &[&std::ffi::OsStr],
        identity: LinuxWorkloadIdentity,
    ) -> Self {
        let leaf = IsolatedCgroupLeaf::create();
        let root = leaf
            .tree()
            .spawn_exec_atomically_as_workload(fixture, arguments, identity)
            .expect(
                "trusted clone3 launcher must place the workload before dropping credentials and exec",
            );
        Self {
            leaf,
            root: Some(root),
        }
    }

    fn tree(&self) -> &LinuxCgroupV2Tree {
        self.leaf.tree()
    }

    fn leaf_path(&self) -> &Path {
        &self.leaf.path
    }

    fn root_process_id(&self) -> u32 {
        self.root
            .as_ref()
            .expect("workload root remains under test custody")
            .process_id()
    }

    fn kill_and_reap(&mut self) -> std::io::Result<()> {
        self.tree().kill_tree()?;
        let Some(root) = self.root.as_mut() else {
            return Ok(());
        };
        if !root.wait_for_exit(Duration::from_secs(5))? {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "cgroup.kill did not allow the direct workload child to be reaped",
            ));
        }
        self.root = None;
        Ok(())
    }

    fn remove_empty(&mut self) {
        assert!(
            self.root.is_none(),
            "the direct workload child must be explicitly reaped before leaf removal"
        );
        self.leaf.remove_empty();
    }
}

#[cfg(target_os = "linux")]
impl Drop for CgroupWorkload {
    fn drop(&mut self) {
        if self.root.is_none() {
            return;
        }
        // A failed assertion must not leave an escaped fixture behind. The
        // cgroup descriptor selects the exact fresh leaf; the direct child is
        // then reaped before `IsolatedCgroupLeaf` performs its final scan.
        let _ = self.leaf.tree().kill_tree();
        if let Some(root) = self.root.as_mut() {
            let _ = root.wait_for_exit(Duration::from_secs(5));
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for IsolatedCgroupLeaf {
    fn drop(&mut self) {
        let Some(tree) = self.tree.take() else {
            return;
        };
        // This is a last-resort test-only cleanup path. The environment root
        // is accepted only after strict validation below, and this descriptor
        // belongs to a fresh direct child of that root.
        let _ = tree.kill_tree();
        let _ = tree.wait_until_empty(Duration::from_secs(5));
        drop(tree);
        let _ = fs::remove_dir(&self.path);
    }
}

#[cfg(target_os = "linux")]
fn isolated_cgroup_test_root() -> PathBuf {
    let root = std::env::var_os("AGENT_RUNTIME_CGROUP_V2_E2E_ROOT")
        .map(PathBuf::from)
        .expect("ignored cgroup v2 evidence requires AGENT_RUNTIME_CGROUP_V2_E2E_ROOT");
    assert!(root.is_absolute(), "E2E root must be an absolute path");
    let supplied_metadata = fs::symlink_metadata(&root)
        .expect("explicit E2E root must already exist and must not be a symlink");
    assert!(
        supplied_metadata.file_type().is_dir() && !supplied_metadata.file_type().is_symlink(),
        "E2E root must be a direct directory, never a symlink"
    );
    let canonical_cgroup_root = fs::canonicalize("/sys/fs/cgroup")
        .expect("Linux cgroup v2 mount must be available for this explicit E2E");
    let canonical_root = fs::canonicalize(&root)
        .expect("explicit E2E root must already exist and must not be a symlink");
    assert_eq!(
        root, canonical_root,
        "E2E root must be canonical so the Host and workload name the same cgroup namespace object"
    );
    assert_eq!(
        canonical_root.parent(),
        Some(canonical_cgroup_root.as_path()),
        "E2E root must be a direct child of /sys/fs/cgroup, never an inherited or shared cgroup"
    );
    let root_name = canonical_root
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .expect("E2E root name is valid UTF-8");
    assert_valid_e2e_root_name(root_name);
    assert_root_owned_private_cgroup_directory(&canonical_root, "E2E root");
    assert!(
        fs::read_dir(&canonical_root)
            .expect("E2E root directory reads")
            .map(|entry| entry.expect("E2E root entry reads"))
            .filter_map(|entry| entry.file_type().ok().filter(|kind| kind.is_dir()))
            .next()
            .is_none(),
        "E2E root must not contain pre-existing child cgroups"
    );

    let root_tree = LinuxCgroupV2Tree::open_new_host_owned_leaf(&canonical_root)
        .expect("workflow-created cgroup root must be a writable, empty v2 leaf");
    assert!(
        root_tree
            .member_process_ids()
            .expect("E2E root member scan succeeds")
            .is_empty(),
        "E2E root must be empty before the Host creates its leaf"
    );
    drop(root_tree);
    canonical_root
}

#[cfg(target_os = "linux")]
fn assert_valid_e2e_root_name(root_name: &str) {
    let Some(suffix) = root_name.strip_prefix("agent-runtime-e2e-") else {
        panic!("E2E root must use the dedicated agent-runtime-e2e-<run>-<attempt> namespace");
    };
    let mut parts = suffix.split('-');
    let Some(run_id) = parts.next() else {
        panic!("E2E root must contain a numeric workflow run ID");
    };
    let Some(attempt) = parts.next() else {
        panic!("E2E root must contain a numeric workflow attempt");
    };
    assert!(
        parts.next().is_none()
            && !run_id.is_empty()
            && !attempt.is_empty()
            && run_id.bytes().all(|byte| byte.is_ascii_digit())
            && attempt.bytes().all(|byte| byte.is_ascii_digit()),
        "E2E root must use exactly agent-runtime-e2e-<numeric-run>-<numeric-attempt>"
    );
}

#[cfg(target_os = "linux")]
fn assert_root_owned_private_cgroup_directory(path: &Path, description: &str) {
    let metadata = fs::symlink_metadata(path).expect("cgroup directory metadata reads");
    assert!(
        metadata.file_type().is_dir() && !metadata.file_type().is_symlink(),
        "{description} must be a direct directory, never a symlink"
    );
    assert_eq!(metadata.uid(), 0, "{description} must be owned by root");
    assert_eq!(
        metadata.gid(),
        0,
        "{description} must have root group ownership"
    );
    assert_eq!(
        metadata.mode() & 0o077,
        0,
        "{description} must not grant group or world access"
    );
}

#[cfg(target_os = "linux")]
fn workload_identity() -> LinuxWorkloadIdentity {
    // The CI step intentionally runs the trusted launcher as root. The target
    // identity is captured before sudo, so it proves the fixture did not keep
    // the launcher's user, group, or supplementary authority.
    assert_eq!(
        unsafe { libc::getuid() },
        0,
        "trusted launcher must run as root"
    );
    assert_eq!(
        unsafe { libc::geteuid() },
        0,
        "trusted launcher must be effective root"
    );
    let uid = required_u32_environment("AGENT_RUNTIME_CGROUP_V2_E2E_WORKLOAD_UID");
    let gid = required_u32_environment("AGENT_RUNTIME_CGROUP_V2_E2E_WORKLOAD_GID");
    assert_ne!(
        uid, 0,
        "workload UID must prove the fixture lost root authority"
    );
    assert_ne!(
        gid, 0,
        "workload GID must prove the fixture lost root authority"
    );
    LinuxWorkloadIdentity::new(uid, gid).expect("workflow UID and GID fit Linux credential types")
}

#[cfg(target_os = "linux")]
fn required_u32_environment(name: &str) -> u32 {
    std::env::var(name)
        .unwrap_or_else(|_| panic!("ignored cgroup evidence requires {name}"))
        .parse::<u32>()
        .unwrap_or_else(|_| panic!("{name} must be a decimal UID or GID"))
}

#[cfg(target_os = "linux")]
fn prepare_workload_observation_root(identity: LinuxWorkloadIdentity) -> TempDir {
    let observation_root = TempDir::new().expect("temporary fixture observation root");
    let path = observation_root.path();
    let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .expect("temporary fixture observation path contains no NUL");
    // SAFETY: the test owns this empty temporary directory and root is the
    // trusted launcher. The fixture needs one private, non-cgroup directory
    // where it can publish synthetic evidence after credentials are dropped.
    assert_eq!(
        unsafe { libc::chown(c_path.as_ptr(), identity.uid(), identity.gid()) },
        0,
        "fixture observation directory ownership changes"
    );
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .expect("fixture observation directory becomes private to the workload");
    let metadata = fs::metadata(path).expect("fixture observation metadata reads");
    assert_eq!(metadata.uid(), identity.uid());
    assert_eq!(metadata.gid(), identity.gid());
    assert_eq!(metadata.mode() & 0o777, 0o700);
    observation_root
}

#[cfg(target_os = "linux")]
fn namespace_identifier(namespace: &str) -> u32 {
    let target =
        fs::read_link(format!("/proc/self/ns/{namespace}")).expect("Linux namespace link reads");
    let target = target.to_str().expect("Linux namespace link is UTF-8");
    let expected_prefix = format!("{namespace}:[");
    let value = target
        .strip_prefix(&expected_prefix)
        .and_then(|value| value.strip_suffix(']'))
        .expect("Linux namespace link has expected name and inode format");
    value
        .parse::<u32>()
        .expect("Linux namespace inode fits the evidence format")
}

#[cfg(target_os = "linux")]
fn unified_cgroup_path(process_id: u32) -> String {
    fs::read_to_string(format!("/proc/{process_id}/cgroup"))
        .expect("fixture cgroup membership reads")
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .expect("fixture belongs to the unified cgroup hierarchy")
        .to_owned()
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
    // poll() becomes readable when the task exits, which can precede reaping.
    // A pidfd may still accept a no-op signal while its target is a zombie, so
    // wait for ESRCH rather than incorrectly treating the first readable poll
    // as proof that the kernel has released the task identity.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match pidfd.send_signal(libc::SIGKILL) {
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => break,
            Ok(()) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(()) => panic!(
                "a pidfd target remained unreaped; cannot prove post-reaping stable identity semantics"
            ),
            Err(error) => panic!("pidfd signal failed unexpectedly after exit: {error}"),
        }
    }
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

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires an explicit, isolated cgroup v2 test root"]
fn linux_cgroup_v2_e2e_proves_atomic_placement_privilege_drop_tree_kill_and_orphan_scan() {
    let identity = workload_identity();
    // A cgroup filesystem accepts only its kernel control files, so fixture
    // observation and stop paths must remain outside the dedicated leaf.
    let observation_root = prepare_workload_observation_root(identity);
    let ready_path = observation_root.path().join("fixture.ready");
    let stop_path = observation_root.path().join("fixture.stop");
    let fixture = escape_fixture();
    let root = isolated_cgroup_test_root();
    let parent_cgroup_procs_path = root.join("cgroup.procs");
    assert_eq!(
        fs::canonicalize(
            parent_cgroup_procs_path
                .parent()
                .expect("parent cgroup path")
        )
        .expect("parent cgroup path canonicalizes"),
        root,
        "the fixture receives only the validated parent cgroup namespace path"
    );
    let arguments = [
        std::ffi::OsString::from("--mode"),
        std::ffi::OsString::from("cgroup-root"),
        std::ffi::OsString::from("--ready-path"),
        ready_path.clone().into_os_string(),
        std::ffi::OsString::from("--stop-path"),
        stop_path.into_os_string(),
        std::ffi::OsString::from("--parent-cgroup-procs-path"),
        parent_cgroup_procs_path.into_os_string(),
    ];
    let argument_refs = arguments
        .iter()
        .map(std::ffi::OsString::as_os_str)
        .collect::<Vec<_>>();
    let mut workload = CgroupWorkload::spawn(&fixture, &argument_refs, identity);

    wait_until(Duration::from_secs(5), || ready_path.exists());
    let status = read_status(&ready_path);
    let root_pid = *status.get("root_pid").expect("root PID is published");
    let descendant_pid = *status
        .get("descendant_pid")
        .expect("setsid descendant PID is published");
    assert_eq!(workload.root_process_id(), root_pid);
    assert_eq!(status.get("root_pgid"), Some(&root_pid));
    assert_eq!(status.get("root_sid"), Some(&root_pid));
    assert_eq!(status.get("descendant_pgid"), Some(&descendant_pid));
    assert_eq!(status.get("descendant_sid"), Some(&descendant_pid));
    assert_eq!(status.get("root_uid"), Some(&identity.uid()));
    assert_eq!(status.get("root_euid"), Some(&identity.uid()));
    assert_eq!(status.get("root_gid"), Some(&identity.gid()));
    assert_eq!(status.get("root_egid"), Some(&identity.gid()));
    assert_eq!(
        status.get("root_supplementary_group_count"),
        Some(&0),
        "the trusted launcher must clear supplementary groups before exec"
    );
    assert_eq!(
        status.get("cgroup_namespace_inode"),
        Some(&namespace_identifier("cgroup")),
        "the workload must observe the Host's cgroup namespace"
    );
    assert_eq!(
        status.get("mount_namespace_inode"),
        Some(&namespace_identifier("mnt")),
        "the workload must observe the Host's cgroup mount namespace"
    );
    assert!(
        matches!(
            status.get("parent_cgroup_write_errno"),
            Some(error) if *error == libc::EACCES as u32 || *error == libc::EPERM as u32
        ),
        "the unprivileged workload must actively receive permission denied when it tries to move itself into the parent cgroup"
    );

    let mut members = workload
        .tree()
        .member_process_ids()
        .expect("cgroup member scan succeeds");
    members.sort_unstable();
    assert_eq!(members, vec![root_pid, descendant_pid]);

    let cgroup_root_name = workload
        .leaf_path()
        .parent()
        .and_then(Path::file_name)
        .and_then(std::ffi::OsStr::to_str)
        .expect("dedicated root name is available");
    let leaf_name = workload
        .leaf_path()
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .expect("dedicated leaf name is available");
    let expected_membership = format!("/{cgroup_root_name}/{leaf_name}");
    assert_eq!(unified_cgroup_path(root_pid), expected_membership);
    assert_eq!(unified_cgroup_path(descendant_pid), expected_membership);

    workload
        .kill_and_reap()
        .expect("cgroup.kill terminates and reaps the direct tree root");
    assert!(
        workload
            .tree()
            .wait_until_empty(Duration::from_secs(5))
            .expect("post-kill cgroup scan succeeds"),
        "cgroup.events and cgroup.procs must both become empty"
    );
    assert!(
        workload
            .tree()
            .member_process_ids()
            .expect("final orphan scan succeeds")
            .is_empty(),
        "a setsid descendant must not survive as an orphan in the cgroup"
    );
    wait_until(Duration::from_secs(5), || !is_process_alive(descendant_pid));
    workload.remove_empty();
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
