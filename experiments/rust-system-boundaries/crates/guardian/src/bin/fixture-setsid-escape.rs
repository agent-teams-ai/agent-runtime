//! Synthetic fixture used only by Unix containment evidence tests.
//!
//! The wrapper starts in a dedicated process group. Its child calls `setsid`,
//! starts a leaf, and writes its process IDs. This demonstrates that a process
//! group cannot contain an adversarial descendant that creates a new session.

#[cfg(unix)]
use std::env;
#[cfg(unix)]
use std::fs;
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

#[cfg(unix)]
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
        "cgroup-root" => {
            start_private_session();
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
                    "root_pid={}\nroot_pgid={}\nroot_sid={}\ndescendant_pid={descendant_pid}\ndescendant_pgid={descendant_pgid}\ndescendant_sid={descendant_sid}\n",
                    std::process::id(),
                    unsafe { libc::getpgrp() },
                    unsafe { libc::getsid(0) },
                ),
            );
            wait_for_stop(&stop_path);
            let _ = descendant.wait();
        }
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
        _ => panic!("unsupported synthetic fixture mode {mode}"),
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("fixture-setsid-escape is Unix-only evidence");
    std::process::exit(78);
}
