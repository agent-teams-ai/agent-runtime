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
            // SAFETY: the synthetic escapee is intentionally not a process
            // group leader, so setsid creates a private session for the test.
            if unsafe { libc::setsid() } < 0 {
                panic!(
                    "synthetic escapee could not call setsid: {}",
                    std::io::Error::last_os_error()
                );
            }
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
        _ => panic!("unsupported synthetic fixture mode {mode}"),
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("fixture-setsid-escape is Unix-only evidence");
    std::process::exit(78);
}
