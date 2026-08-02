use boundary_supervisor::{
    EnsureOptions, HealthWitnessRejection, HostLaunch, Supervisor, SupervisorError, TrustAnchor,
    write_fixture_release_with_artifact,
};
use ed25519_dalek::SigningKey;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const WITNESS_TIMEOUT: Duration = Duration::from_secs(2);

fn fixture_key() -> SigningKey {
    SigningKey::from_bytes(&[0x5a; 32])
}

fn synthetic_host_file_name() -> &'static str {
    if cfg!(windows) {
        "synthetic-host.exe"
    } else {
        "synthetic-host"
    }
}

fn release(root: &Path, version: &str, key: &SigningKey) {
    let binary = fs::read(env!("CARGO_BIN_EXE_synthetic_host"))
        .expect("compiled synthetic Host binary must be readable");
    write_fixture_release_with_artifact(root, version, synthetic_host_file_name(), &binary, key)
        .expect("synthetic Host fixture release must be writable");
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

#[test]
fn generation_bound_health_rejects_stale_and_wrong_witnesses_then_recovers_and_replaces() {
    let temp = TempDir::new().expect("temporary root");
    let supervisor_root = temp.path().join("supervisor");
    let initial_release = temp.path().join("initial");
    let update_release = temp.path().join("update");
    let crash_marker = temp.path().join("crash-current-host");
    let boot_log = temp.path().join("host-boots.log");
    let key = fixture_key();
    let anchor = TrustAnchor::from_signing_key(&key);
    release(&initial_release, "1.0.0", &key);
    release(&update_release, "2.0.0", &key);

    let supervisor = Arc::new(Supervisor::open(&supervisor_root).expect("supervisor opens"));
    let crash_marker = crash_marker.to_string_lossy().into_owned();
    let boot_log = boot_log.to_string_lossy().into_owned();
    let bootstrap_launch = HostLaunch::with_extra_args([
        "--crash-path",
        crash_marker.as_str(),
        "--boot-log-path",
        boot_log.as_str(),
    ]);
    let start = Arc::new(Barrier::new(8));
    let threads = (0..8)
        .map(|_| {
            let supervisor = Arc::clone(&supervisor);
            let release_root = initial_release.clone();
            let anchor = anchor.clone();
            let launch = bootstrap_launch.clone();
            let start = Arc::clone(&start);
            thread::spawn(move || {
                start.wait();
                supervisor
                    .ensure(&release_root, &anchor, &launch, EnsureOptions::default())
                    .expect("concurrent initial activation succeeds")
            })
        })
        .collect::<Vec<_>>();
    let generations = threads
        .into_iter()
        .map(|thread| thread.join().expect("concurrent activation must not panic"))
        .collect::<Vec<_>>();
    assert!(
        generations
            .windows(2)
            .all(|pair| pair[0].generation_id == pair[1].generation_id),
        "concurrent activation must converge on one generation"
    );
    let initial_host = supervisor
        .inspect_active_host()
        .expect("Host inspection succeeds")
        .expect("initial Host is live");
    assert_eq!(initial_host.generation_id, generations[0].generation_id);
    assert_eq!(
        initial_host.generation_digest, generations[0].artifact_sha256,
        "health witness must bind the active generation digest"
    );
    assert!(
        supervisor
            .observation_is_live(&initial_host)
            .expect("initial Host identity is readable"),
        "health witness PID and birth identity must identify a live process"
    );
    assert_eq!(
        fs::read_to_string(&boot_log)
            .expect("boot log reads")
            .lines()
            .count(),
        1,
        "eight concurrent bootstraps must launch exactly one Host"
    );

    fs::write(&crash_marker, b"crash").expect("crash marker writes");
    wait_until(WITNESS_TIMEOUT, || {
        supervisor
            .inspect_active_host()
            .expect("crashed Host inspection succeeds")
            .is_none()
    });
    let recovered_host = supervisor
        .ensure_active_host(&HostLaunch::default())
        .expect("crashed active generation restarts");
    assert_eq!(recovered_host.generation_id, initial_host.generation_id);
    assert_ne!(recovered_host.pid, initial_host.pid);

    let stale_nonce = supervisor.ensure(
        &update_release,
        &anchor,
        &HostLaunch::with_extra_args(["--mode", "stale-nonce"]),
        EnsureOptions::default(),
    );
    assert!(matches!(
        stale_nonce,
        Err(SupervisorError::HealthWitnessRejected(
            HealthWitnessRejection::NonceMismatch
        ))
    ));
    assert_eq!(
        supervisor
            .inspect_active()
            .expect("active generation inspection succeeds")
            .expect("previous generation remains active")
            .version,
        "1.0.0"
    );
    assert_eq!(
        supervisor
            .inspect_active_host()
            .expect("active Host inspection succeeds")
            .expect("previous Host remains live"),
        recovered_host,
        "a stale nonce must not replace the live Host"
    );

    let silent_candidate = supervisor.ensure(
        &update_release,
        &anchor,
        &HostLaunch {
            extra_args: vec!["--mode".to_owned(), "no-report".to_owned()],
            health_timeout: Duration::from_millis(150),
        },
        EnsureOptions::default(),
    );
    assert!(matches!(
        silent_candidate,
        Err(SupervisorError::HealthWitnessTimeout)
    ));
    assert_eq!(
        supervisor
            .inspect_active()
            .expect("active generation inspection succeeds after timeout")
            .expect("previous generation remains active after timeout")
            .version,
        "1.0.0"
    );

    let wrong_generation = supervisor.ensure(
        &update_release,
        &anchor,
        &HostLaunch::with_extra_args(["--mode", "wrong-generation"]),
        EnsureOptions::default(),
    );
    assert!(matches!(
        wrong_generation,
        Err(SupervisorError::HealthWitnessRejected(
            HealthWitnessRejection::GenerationDigestMismatch
        ))
    ));
    let wrong_executable_digest = supervisor.ensure(
        &update_release,
        &anchor,
        &HostLaunch::with_extra_args(["--mode", "wrong-executable-digest"]),
        EnsureOptions::default(),
    );
    assert!(matches!(
        wrong_executable_digest,
        Err(SupervisorError::HealthWitnessRejected(
            HealthWitnessRejection::ExecutableDigestMismatch
        ))
    ));
    let wrong_birth = supervisor.ensure(
        &update_release,
        &anchor,
        &HostLaunch::with_extra_args(["--mode", "wrong-birth"]),
        EnsureOptions::default(),
    );
    assert!(
        matches!(
            wrong_birth,
            Err(SupervisorError::HealthWitnessRejected(
                HealthWitnessRejection::BirthIdentityMismatch
            ))
        ),
        "wrong birth result: {wrong_birth:?}"
    );

    let updated_generation = supervisor
        .ensure(
            &update_release,
            &anchor,
            &HostLaunch::default(),
            EnsureOptions::default(),
        )
        .expect("healthy replacement activates");
    let updated_host = supervisor
        .inspect_active_host()
        .expect("updated Host inspection succeeds")
        .expect("updated Host is live");
    assert_eq!(updated_host.generation_id, updated_generation.generation_id);
    assert_eq!(
        updated_host.generation_digest,
        updated_generation.artifact_sha256
    );
    assert_ne!(updated_host.pid, recovered_host.pid);
    assert!(
        !supervisor
            .observation_is_live(&recovered_host)
            .expect("replaced Host identity inspection succeeds"),
        "successful replacement must stop the prior Host"
    );
}
