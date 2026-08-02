use execution_guardian::{ProcessBirthIdentity, current_process_birth_identity};
use serde::Serialize;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(unix)]
static TERMINATE_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn record_sigterm(_signal: i32) {
    TERMINATE_REQUESTED.store(true, Ordering::Relaxed);
}

#[derive(Serialize)]
struct IdentityProof<'a> {
    custody_id: &'a str,
    spawn_nonce: &'a str,
    pid: u32,
    birth_identity: ProcessBirthIdentity,
}

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

fn spawn_leaf() -> std::process::Child {
    Command::new(env::current_exe().expect("fixture executable path"))
        .args(["--mode", "leaf"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("synthetic leaf starts")
}

fn main() {
    let mode = argument("--mode");
    if mode == "leaf" {
        loop {
            thread::sleep(Duration::from_millis(50));
        }
    }
    assert_eq!(mode, "tree", "only the synthetic tree fixture is valid");
    let identity_path = PathBuf::from(argument("--identity-path"));
    let custody_id = argument("--custody-id");
    let spawn_nonce = argument("--spawn-nonce");
    let descendant_pid_path = PathBuf::from(argument("--descendant-pid-path"));
    #[cfg(unix)]
    let release_descendant_path = PathBuf::from(argument("--release-descendant-path"));
    let termination_marker_path = PathBuf::from(argument("--termination-marker-path"));
    let _ = &termination_marker_path;
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGTERM, record_sigterm as *const () as usize);
    }
    #[cfg(windows)]
    let child = {
        // The Windows Guardian resumes this root only after assigning it to a
        // Job Object. Creating the descendant before the root's identity
        // witness makes that ordering observable in the executable spike.
        let child = spawn_leaf();
        fs::write(&descendant_pid_path, child.id().to_string()).expect("descendant PID writes");
        child
    };
    fs::write(
        &identity_path,
        serde_json::to_vec(&IdentityProof {
            custody_id: &custody_id,
            spawn_nonce: &spawn_nonce,
            pid: std::process::id(),
            birth_identity: current_process_birth_identity()
                .expect("fixture obtains a re-readable process birth identity"),
        })
        .expect("identity serializes"),
    )
    .expect("identity proof writes");
    println!("fixture stdout: ready");
    eprintln!("fixture stderr: ready");
    #[cfg(unix)]
    let child = {
        while !release_descendant_path.exists() {
            thread::sleep(Duration::from_millis(10));
        }
        let child = spawn_leaf();
        fs::write(&descendant_pid_path, child.id().to_string()).expect("descendant PID writes");
        child
    };
    #[cfg(unix)]
    let mut child = child;
    #[cfg(windows)]
    let _child_waiter = thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    for index in 0..128 {
        println!("fixture stdout line {index}: bounded capture probe");
        eprintln!("fixture stderr line {index}: bounded capture probe");
    }
    loop {
        #[cfg(unix)]
        if TERMINATE_REQUESTED.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            fs::write(&termination_marker_path, b"terminated").expect("termination marker writes");
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
}
