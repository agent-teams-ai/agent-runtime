use boundary_supervisor::{
    EnsureOptions, FaultPoint, HealthCheck, Supervisor, SupervisorError, TrustAnchor,
    write_fixture_release,
};
use ed25519_dalek::SigningKey;
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

fn fixture_key() -> SigningKey {
    SigningKey::from_bytes(&[0x5a; 32])
}

fn release(root: &Path, version: &str, body: &[u8], key: &SigningKey) {
    write_fixture_release(root, version, body, key).expect("fixture release must be writable");
}

#[test]
fn concurrent_separate_process_ensure_selects_exactly_one_generation() {
    let temp = TempDir::new().expect("temporary root");
    let release_root = temp.path().join("release");
    let supervisor_root = temp.path().join("supervisor");
    let key = fixture_key();
    release(&release_root, "1.0.0", b"fixture runtime bytes", &key);
    let anchor = TrustAnchor::from_signing_key(&key).to_base64();
    let driver = env!("CARGO_BIN_EXE_supervisor-driver");

    let children = (0..8)
        .map(|_| {
            Command::new(driver)
                .args([
                    "--root",
                    supervisor_root.to_str().expect("UTF-8 path"),
                    "--release",
                    release_root.to_str().expect("UTF-8 path"),
                    "--trust-anchor",
                    &anchor,
                ])
                .spawn()
                .expect("driver process must spawn")
        })
        .collect::<Vec<_>>();

    for mut child in children {
        assert!(child.wait().expect("driver must exit").success());
    }

    let supervisor = Supervisor::open(&supervisor_root).expect("supervisor opens");
    let active = supervisor
        .inspect_active()
        .expect("inspect succeeds")
        .expect("generation selected");
    assert_eq!(active.version, "1.0.0");
    assert_eq!(supervisor.generation_count().expect("count succeeds"), 1);
}

#[test]
fn fault_injection_recovers_without_promoting_an_interrupted_generation() {
    let temp = TempDir::new().expect("temporary root");
    let supervisor_root = temp.path().join("supervisor");
    let old_release = temp.path().join("old");
    let new_release = temp.path().join("new");
    let key = fixture_key();
    let anchor = TrustAnchor::from_signing_key(&key);
    release(&old_release, "1.0.0", b"old", &key);
    release(&new_release, "2.0.0", b"new", &key);
    let supervisor = Supervisor::open(&supervisor_root).expect("supervisor opens");
    supervisor
        .ensure(&old_release, &anchor, EnsureOptions::default())
        .expect("old generation activates");

    for fault_point in [
        FaultPoint::AfterStaged,
        FaultPoint::AfterActivePointerWriteBeforePhaseUpdate,
        FaultPoint::AfterPhaseUpdateBeforeCommit,
    ] {
        let result = supervisor.ensure(
            &new_release,
            &anchor,
            EnsureOptions {
                health_check: HealthCheck::Pass,
                fault_point: Some(fault_point),
                ..EnsureOptions::default()
            },
        );
        assert!(matches!(
            result,
            Err(SupervisorError::FaultInjected(actual_fault)) if actual_fault == fault_point
        ));

        let restarted = Supervisor::open(&supervisor_root).expect("restarted supervisor opens");
        restarted
            .recover()
            .expect("rollback-only recovery succeeds");
        assert_eq!(
            restarted
                .inspect_active()
                .expect("inspect succeeds")
                .expect("old remains active")
                .version,
            "1.0.0",
            "incomplete activation at {fault_point:?} must not promote the candidate"
        );
    }
}

#[test]
fn inspect_recovers_every_crashed_activation_phase_after_the_lock_is_released() {
    let temp = TempDir::new().expect("temporary root");
    let supervisor_root = temp.path().join("supervisor");
    let old_release = temp.path().join("old");
    let new_release = temp.path().join("new");
    let key = fixture_key();
    let anchor = TrustAnchor::from_signing_key(&key);
    release(&old_release, "1.0.0", b"old", &key);
    release(&new_release, "2.0.0", b"new", &key);
    let supervisor = Supervisor::open(&supervisor_root).expect("supervisor opens");
    supervisor
        .ensure(&old_release, &anchor, EnsureOptions::default())
        .expect("old generation activates");
    let driver = env!("CARGO_BIN_EXE_supervisor-driver");

    for phase in [
        "after_staged",
        "after_active_pointer_write_before_phase_update",
        "after_phase_update_before_commit",
    ] {
        let status = Command::new(driver)
            .args([
                "--root",
                supervisor_root.to_str().expect("UTF-8 path"),
                "--release",
                new_release.to_str().expect("UTF-8 path"),
                "--trust-anchor",
                &anchor.to_base64(),
                "--crash-at",
                phase,
            ])
            .status()
            .expect("fault driver starts");
        assert!(
            !status.success(),
            "fault driver must abort inside ensure while it still owns the lock at {phase}"
        );
        let recovered = Supervisor::open(&supervisor_root).expect("restarted supervisor opens");
        assert_eq!(
            recovered
                .inspect_active()
                .expect("inspect succeeds")
                .expect("old generation remains active")
                .version,
            "1.0.0"
        );
        assert!(
            !supervisor_root.join("activation-transaction.json").exists(),
            "inspect must finalize recovery for {phase}"
        );
    }
}

#[test]
fn health_failure_rolls_back_and_active_version_is_exactly_inspectable() {
    let temp = TempDir::new().expect("temporary root");
    let supervisor_root = temp.path().join("supervisor");
    let good_release = temp.path().join("good");
    let bad_release = temp.path().join("bad");
    let key = fixture_key();
    let anchor = TrustAnchor::from_signing_key(&key);
    release(&good_release, "1.0.0", b"good", &key);
    release(&bad_release, "2.0.0", b"bad", &key);
    let supervisor = Supervisor::open(&supervisor_root).expect("supervisor opens");
    supervisor
        .ensure(&good_release, &anchor, EnsureOptions::default())
        .expect("good generation activates");

    let result = supervisor.ensure(
        &bad_release,
        &anchor,
        EnsureOptions {
            health_check: HealthCheck::Fail,
            fault_point: None,
            ..EnsureOptions::default()
        },
    );
    assert!(matches!(result, Err(SupervisorError::HealthCheckFailed)));
    let active = supervisor
        .inspect_active()
        .expect("inspect succeeds")
        .expect("good remains active");
    assert_eq!(active.version, "1.0.0");
}

#[test]
fn signed_manifest_and_artifact_tampering_are_rejected() {
    let temp = TempDir::new().expect("temporary root");
    let release_root = temp.path().join("release");
    let key = fixture_key();
    let anchor = TrustAnchor::from_signing_key(&key);
    release(&release_root, "1.0.0", b"fixture bytes", &key);
    let supervisor = Supervisor::open(temp.path().join("supervisor")).expect("supervisor opens");

    fs::write(release_root.join("fixture-runtime.bin"), b"tampered bytes")
        .expect("tamper fixture artifact");
    let artifact_result = supervisor.ensure(&release_root, &anchor, EnsureOptions::default());
    assert!(matches!(
        artifact_result,
        Err(SupervisorError::ArtifactDigestMismatch { .. })
    ));

    release(&release_root, "1.0.0", b"fixture bytes", &key);
    let manifest_path = release_root.join("release-manifest.json");
    let tampered = fs::read_to_string(&manifest_path)
        .expect("manifest reads")
        .replace("1.0.0", "9.9.9");
    fs::write(manifest_path, tampered).expect("tamper manifest");
    let manifest_result = supervisor.ensure(&release_root, &anchor, EnsureOptions::default());
    assert!(matches!(
        manifest_result,
        Err(SupervisorError::InvalidSignature)
    ));
    assert!(
        supervisor
            .inspect_active()
            .expect("inspect succeeds")
            .is_none()
    );
}

#[test]
fn unsafe_manifest_components_and_malformed_digests_are_rejected_before_staging() {
    let temp = TempDir::new().expect("temporary root");
    let release_root = temp.path().join("release");
    let key = fixture_key();
    let anchor = TrustAnchor::from_signing_key(&key);
    release(&release_root, "1.0.0", b"fixture bytes", &key);
    let supervisor = Supervisor::open(temp.path().join("supervisor")).expect("supervisor opens");
    let manifest_path = release_root.join("release-manifest.json");
    let original = fs::read(&manifest_path).expect("fixture manifest reads");

    for value in [
        "../outside.bin",
        "/absolute.bin",
        "nested/fixture-runtime.bin",
        r"nested\fixture-runtime.bin",
        "CON",
        "nul.bin",
    ] {
        let error = manifest_value_error(
            &supervisor,
            &release_root,
            &anchor,
            &original,
            "/artifact/file_name",
            serde_json::Value::String(value.to_owned()),
        );
        assert!(matches!(error, SupervisorError::UnsafeArtifactFileName));
        assert_eq!(
            supervisor.generation_count().expect("count succeeds"),
            0,
            "unsafe artifact names must fail before a staging path exists"
        );
    }

    for value in [
        "../2.0.0",
        "2.0.0/next",
        r"2.0.0\next",
        ".hidden",
        "1.0.0.",
        "COM1",
    ] {
        let error = manifest_value_error(
            &supervisor,
            &release_root,
            &anchor,
            &original,
            "/version",
            serde_json::Value::String(value.to_owned()),
        );
        assert!(matches!(error, SupervisorError::UnsafeVersion));
        assert_eq!(
            supervisor.generation_count().expect("count succeeds"),
            0,
            "unsafe versions must fail before a generation path exists"
        );
    }

    for value in ["f".repeat(63), "z".repeat(64), "F".repeat(64)] {
        let error = manifest_value_error(
            &supervisor,
            &release_root,
            &anchor,
            &original,
            "/artifact/sha256",
            serde_json::Value::String(value),
        );
        assert!(matches!(error, SupervisorError::MalformedArtifactDigest));
        assert_eq!(
            supervisor.generation_count().expect("count succeeds"),
            0,
            "malformed digest must fail before staging"
        );
    }
}

fn manifest_value_error(
    supervisor: &Supervisor,
    release_root: &Path,
    anchor: &TrustAnchor,
    original: &[u8],
    pointer: &str,
    value: serde_json::Value,
) -> SupervisorError {
    let manifest_path = release_root.join("release-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(original).expect("fixture manifest parses");
    *manifest
        .pointer_mut(pointer)
        .expect("fixture manifest path exists") = value;
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest).expect("fixture manifest serializes"),
    )
    .expect("tampered fixture manifest writes");
    supervisor
        .ensure(release_root, anchor, EnsureOptions::default())
        .expect_err("unsafe manifest must fail")
}
