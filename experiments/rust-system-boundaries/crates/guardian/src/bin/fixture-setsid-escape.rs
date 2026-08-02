//! Synthetic fixture used only by Unix containment evidence tests.
//!
//! The wrapper starts in a dedicated process group. Its child calls `setsid`,
//! starts a leaf, and writes its process IDs. This demonstrates that a process
//! group cannot contain an adversarial descendant that creates a new session.

#[cfg(unix)]
use std::env;
#[cfg(unix)]
use std::fs;
#[cfg(target_os = "linux")]
use std::fs::OpenOptions;
#[cfg(target_os = "linux")]
use std::io::Write;
#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::{Command, Stdio};
#[cfg(unix)]
use std::thread;
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
fn argument(name: &str) -> String {
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == name {
            return arguments
                .next()
                .unwrap_or_else(|| panic!("missing value for {name}"));
        }
    }
    panic!("missing {name}")
}

#[cfg(unix)]
fn wait_for_stop(stop_path: &Path) {
    while !stop_path.exists() {
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "linux")]
fn write_atomically(path: &Path, contents: String) {
    let temporary_path = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary_path, contents).expect("synthetic status writes");
    fs::rename(&temporary_path, path).expect("synthetic status publishes atomically");
}

#[cfg(unix)]
fn start_private_session() {
    // SAFETY: each synthetic process begins as a non-leader in its inherited
    // process group, so setsid creates the deliberate escape used by the
    // containment evidence.
    if unsafe { libc::setsid() } < 0 {
        panic!(
            "synthetic escapee could not call setsid: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(target_os = "linux")]
fn namespace_inode(namespace: &str) -> u32 {
    let target = fs::read_link(format!("/proc/self/ns/{namespace}"))
        .expect("synthetic namespace link reads");
    let target = target.to_str().expect("synthetic namespace link is UTF-8");
    let expected_prefix = format!("{namespace}:[");
    let value = target
        .strip_prefix(&expected_prefix)
        .and_then(|value| value.strip_suffix(']'))
        .expect("synthetic namespace link has expected name and inode format");
    value
        .parse::<u32>()
        .expect("synthetic namespace inode fits the evidence format")
}

#[cfg(target_os = "linux")]
fn supplementary_group_count() -> u32 {
    // SAFETY: a null list with size zero asks Linux for the group count only.
    let result = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    assert!(result >= 0, "synthetic supplementary group count reads");
    result as u32
}

#[cfg(target_os = "linux")]
fn no_new_privs() -> u32 {
    // SAFETY: PR_GET_NO_NEW_PRIVS reads a process-local kernel flag without
    // changing process state.
    let value = unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) };
    assert!(
        value >= 0,
        "synthetic no_new_privs reads: {}",
        std::io::Error::last_os_error()
    );
    value as u32
}

#[cfg(target_os = "linux")]
fn parent_cgroup_write_permission_errno(parent_cgroup_procs_path: &Path) -> i32 {
    let mut control = match OpenOptions::new()
        .write(true)
        .open(parent_cgroup_procs_path)
    {
        Ok(control) => control,
        Err(error) => return require_permission_denied(error),
    };
    match writeln!(control, "{}", std::process::id()) {
        Ok(()) => panic!(
            "untrusted workload unexpectedly moved itself into parent cgroup {}",
            parent_cgroup_procs_path.display()
        ),
        Err(error) => require_permission_denied(error),
    }
}

#[cfg(target_os = "linux")]
fn require_permission_denied(error: std::io::Error) -> i32 {
    match error.raw_os_error() {
        Some(code) if code == libc::EACCES || code == libc::EPERM => code,
        Some(code) => panic!("parent cgroup re-entry failed with unexpected errno {code}: {error}"),
        None => panic!("parent cgroup re-entry failed without an OS errno: {error}"),
    }
}

#[cfg(unix)]
fn main() {
    let mode = argument("--mode");
    let ready_path = PathBuf::from(argument("--ready-path"));
    let stop_path = PathBuf::from(argument("--stop-path"));

    match mode.as_str() {
        "wrapper" => {
            let child = Command::new(env::current_exe().expect("fixture executable path"))
                .args([
                    "--mode",
                    "escapee",
                    "--ready-path",
                    ready_path.to_str().expect("UTF-8 ready path"),
                    "--stop-path",
                    stop_path.to_str().expect("UTF-8 stop path"),
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("synthetic escapee starts");
            fs::write(
                ready_path.with_extension("wrapper-pid"),
                std::process::id().to_string(),
            )
            .expect("wrapper PID writes");
            let _ = child;
            wait_for_stop(&stop_path);
        }
        "escapee" => {
            start_private_session();
            let mut leaf = Command::new(env::current_exe().expect("fixture executable path"))
                .args([
                    "--mode",
                    "leaf",
                    "--ready-path",
                    ready_path.to_str().expect("UTF-8 ready path"),
                    "--stop-path",
                    stop_path.to_str().expect("UTF-8 stop path"),
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("synthetic leaf starts");
            fs::write(
                &ready_path,
                format!(
                    "escapee_pid={}\nleaf_pid={}\nescapee_pgid={}\nescapee_sid={}\n",
                    std::process::id(),
                    leaf.id(),
                    unsafe { libc::getpgrp() },
                    unsafe { libc::getsid(0) },
                ),
            )
            .expect("escape status writes");
            wait_for_stop(&stop_path);
            let _ = leaf.wait();
        }
        "leaf" => wait_for_stop(&stop_path),
        #[cfg(target_os = "linux")]
        "cgroup-root" => {
            start_private_session();
            let parent_cgroup_procs_path = PathBuf::from(argument("--parent-cgroup-procs-path"));
            let parent_cgroup_write_errno =
                parent_cgroup_write_permission_errno(&parent_cgroup_procs_path);
            let descendant_ready_path = ready_path.with_extension("descendant-ready");
            let mut descendant = Command::new(env::current_exe().expect("fixture executable path"))
                .args([
                    "--mode",
                    "cgroup-descendant",
                    "--ready-path",
                    descendant_ready_path
                        .to_str()
                        .expect("UTF-8 descendant ready path"),
                    "--stop-path",
                    stop_path.to_str().expect("UTF-8 stop path"),
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("synthetic cgroup descendant starts");
            while !descendant_ready_path.exists() {
                thread::sleep(Duration::from_millis(10));
            }
            let descendant_status = fs::read_to_string(&descendant_ready_path)
                .expect("synthetic descendant status reads");
            let mut descendant_fields = descendant_status.trim().split(',');
            let descendant_pid = descendant_fields.next().expect("descendant PID");
            let descendant_pgid = descendant_fields.next().expect("descendant process group");
            let descendant_sid = descendant_fields.next().expect("descendant session");
            assert!(
                descendant_fields.next().is_none(),
                "descendant status must contain exactly three fields"
            );
            write_atomically(
                &ready_path,
                format!(
                    "root_pid={}\nroot_pgid={}\nroot_sid={}\nroot_uid={}\nroot_euid={}\nroot_gid={}\nroot_egid={}\nroot_supplementary_group_count={}\nno_new_privs={}\nparent_cgroup_write_errno={parent_cgroup_write_errno}\ncgroup_namespace_inode={}\nmount_namespace_inode={}\ndescendant_pid={descendant_pid}\ndescendant_pgid={descendant_pgid}\ndescendant_sid={descendant_sid}\n",
                    std::process::id(),
                    unsafe { libc::getpgrp() },
                    unsafe { libc::getsid(0) },
                    unsafe { libc::getuid() },
                    unsafe { libc::geteuid() },
                    unsafe { libc::getgid() },
                    unsafe { libc::getegid() },
                    supplementary_group_count(),
                    no_new_privs(),
                    namespace_inode("cgroup"),
                    namespace_inode("mnt"),
                ),
            );
            wait_for_stop(&stop_path);
            let _ = descendant.wait();
        }
        #[cfg(target_os = "linux")]
        "cgroup-descendant" => {
            start_private_session();
            write_atomically(
                &ready_path,
                format!(
                    "{},{},{}",
                    std::process::id(),
                    unsafe { libc::getpgrp() },
                    unsafe { libc::getsid(0) },
                ),
            );
            wait_for_stop(&stop_path);
        }
        #[cfg(not(target_os = "linux"))]
        "cgroup-root" | "cgroup-descendant" => {
            panic!("synthetic cgroup evidence is Linux-only")
        }
        _ => panic!("unsupported synthetic fixture mode {mode}"),
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("fixture-setsid-escape is Unix-only evidence");
    std::process::exit(78);
}
