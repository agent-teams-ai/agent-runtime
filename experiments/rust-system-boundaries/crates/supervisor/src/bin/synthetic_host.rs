//! Disposable long-lived Host fixture for Supervisor evidence tests.
//!
//! This is not a production runtime Host. It only writes a generation-bound
//! readiness witness and a monotonic heartbeat in a temporary test directory.

use atomic_state_file::replace_file_atomically;
use std::env;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

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

fn main() {
    let generation = argument("--generation");
    let ready_path = PathBuf::from(argument("--ready-path"));
    let heartbeat_path = PathBuf::from(argument("--heartbeat-path"));
    let pid = std::process::id();
    replace_file_atomically(&ready_path, format!("{generation}\n{pid}\n").as_bytes())
        .expect("synthetic Host readiness witness writes");

    let mut sequence = 0_u64;
    loop {
        sequence = sequence
            .checked_add(1)
            .expect("heartbeat sequence overflow");
        replace_file_atomically(
            &heartbeat_path,
            format!("{generation}\n{pid}\n{sequence}\n").as_bytes(),
        )
        .expect("synthetic Host heartbeat writes");
        thread::sleep(Duration::from_millis(20));
    }
}
