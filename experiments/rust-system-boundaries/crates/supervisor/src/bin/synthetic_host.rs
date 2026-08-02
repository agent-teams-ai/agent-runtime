//! Disposable Host fixture for the Supervisor health boundary spike.
//!
//! It publishes one local TCP witness after boot, then remains alive until a
//! test-only crash marker appears. Its modes deliberately produce invalid
//! witnesses so the Supervisor can prove rejection paths without a mock.

use boundary_supervisor::{
    HealthWitness, ProcessBirthIdentity, current_process_birth_identity, sha256_hex,
};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{Shutdown, TcpStream};
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

fn optional_argument(name: &str) -> Option<String> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    arguments
        .iter()
        .position(|argument| argument == name)
        .and_then(|position| arguments.get(position + 1))
        .cloned()
}

fn main() {
    let health_endpoint = argument("--health-endpoint");
    let mut witness = HealthWitness {
        generation_id: argument("--generation-id"),
        generation_digest: argument("--generation-digest"),
        executable_digest: sha256_hex(
            &fs::read(env::current_exe().expect("synthetic Host executable path"))
                .expect("synthetic Host executable reads"),
        ),
        launch_nonce: argument("--health-nonce"),
        pid: std::process::id(),
        birth_identity: current_process_birth_identity()
            .expect("synthetic Host obtains a re-readable process birth identity"),
    };
    let mode = optional_argument("--mode").unwrap_or_else(|| "ready".to_owned());
    let crash_path = optional_argument("--crash-path").map(PathBuf::from);
    if let Some(boot_log_path) = optional_argument("--boot-log-path") {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(boot_log_path)
            .expect("synthetic Host boot log opens")
            .write_all(format!("{}\n", witness.pid).as_bytes())
            .expect("synthetic Host boot log writes");
    }

    match mode.as_str() {
        "ready" => {}
        "stale-nonce" => witness.launch_nonce = format!("stale-{}", witness.launch_nonce),
        "wrong-generation" => {
            witness.generation_digest = format!("wrong-{}", witness.generation_digest)
        }
        "wrong-executable-digest" => {
            witness.executable_digest = format!("wrong-{}", witness.executable_digest)
        }
        "wrong-birth" => witness.birth_identity = changed_birth_identity(witness.birth_identity),
        "no-report" => loop_until_crash(crash_path.as_deref()),
        "exit-after-report" => {}
        value => panic!("unsupported synthetic Host mode: {value}"),
    }

    publish_health_witness(&health_endpoint, &witness);
    if mode == "exit-after-report" {
        thread::sleep(Duration::from_millis(100));
        return;
    }
    loop_until_crash(crash_path.as_deref());
}

fn publish_health_witness(endpoint: &str, witness: &HealthWitness) {
    let mut stream =
        TcpStream::connect(endpoint).expect("synthetic Host connects to health endpoint");
    let payload = serde_json::to_vec(witness).expect("health witness serializes");
    stream
        .write_all(&(payload.len() as u32).to_be_bytes())
        .expect("synthetic Host writes health witness length");
    stream
        .write_all(&payload)
        .expect("synthetic Host writes health witness");
    stream
        .shutdown(Shutdown::Write)
        .expect("synthetic Host half-closes health endpoint");
}

fn loop_until_crash(crash_path: Option<&std::path::Path>) -> ! {
    loop {
        if crash_path.is_some_and(std::path::Path::exists) {
            std::process::exit(0);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn changed_birth_identity(identity: ProcessBirthIdentity) -> ProcessBirthIdentity {
    match identity {
        ProcessBirthIdentity::LinuxProcStartTime {
            boot_id,
            start_time_ticks,
        } => ProcessBirthIdentity::LinuxProcStartTime {
            boot_id,
            start_time_ticks: start_time_ticks.saturating_add(1),
        },
        ProcessBirthIdentity::MacosProcStartTime {
            seconds,
            microseconds,
        } => ProcessBirthIdentity::MacosProcStartTime {
            seconds,
            microseconds: microseconds.saturating_add(1),
        },
        ProcessBirthIdentity::WindowsCreationTime { filetime_100ns } => {
            ProcessBirthIdentity::WindowsCreationTime {
                filetime_100ns: filetime_100ns.saturating_add(1),
            }
        }
    }
}
