//! Evidence-only Local Supervisor boundary.
//!
//! This crate owns neither runtime domain state nor distributed authority. It
//! only verifies a signed release, stages one local generation, atomically
//! selects it after a local health result, and can roll back an interrupted
//! activation. The caller owns rollout policy and all business semantics.

use atomic_state_file::replace_file_atomically;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

const MANIFEST_FILE: &str = "release-manifest.json";
const ACTIVE_FILE: &str = "active-generation.json";
const TRANSACTION_FILE: &str = "activation-transaction.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustAnchor {
    verifying_key: VerifyingKey,
}

impl TrustAnchor {
    pub fn from_signing_key(signing_key: &SigningKey) -> Self {
        Self {
            verifying_key: signing_key.verifying_key(),
        }
    }

    pub fn from_base64(value: &str) -> Result<Self, SupervisorError> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(value)
            .map_err(|_| SupervisorError::InvalidTrustAnchor)?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| SupervisorError::InvalidTrustAnchor)?;
        let verifying_key =
            VerifyingKey::from_bytes(&bytes).map_err(|_| SupervisorError::InvalidTrustAnchor)?;
        Ok(Self { verifying_key })
    }

    pub fn to_base64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.verifying_key.as_bytes())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactDescriptor {
    pub file_name: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestPayload {
    format_version: u16,
    version: String,
    artifact: ArtifactDescriptor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedReleaseManifest {
    format_version: u16,
    pub version: String,
    pub artifact: ArtifactDescriptor,
    pub signature_base64: String,
}

impl SignedReleaseManifest {
    fn payload(&self) -> ManifestPayload {
        ManifestPayload {
            format_version: self.format_version,
            version: self.version.clone(),
            artifact: self.artifact.clone(),
        }
    }

    fn canonical_payload_bytes(&self) -> Result<Vec<u8>, SupervisorError> {
        serde_json::to_vec(&self.payload()).map_err(SupervisorError::Serialize)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActiveGeneration {
    pub generation_id: String,
    pub version: String,
    pub artifact_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthCheck {
    Pass,
    Fail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultPoint {
    AfterStaged,
    AfterActivePointerWriteBeforePhaseUpdate,
    AfterPhaseUpdateBeforeCommit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultBehavior {
    ReturnError,
    AbortProcess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnsureOptions {
    pub health_check: HealthCheck,
    pub fault_point: Option<FaultPoint>,
    pub fault_behavior: FaultBehavior,
}

impl Default for EnsureOptions {
    fn default() -> Self {
        Self {
            health_check: HealthCheck::Pass,
            fault_point: None,
            fault_behavior: FaultBehavior::ReturnError,
        }
    }
}

#[derive(Debug)]
pub enum SupervisorError {
    Io(io::Error),
    Serialize(serde_json::Error),
    InvalidTrustAnchor,
    InvalidSignatureEncoding,
    InvalidSignature,
    ArtifactDigestMismatch { expected: String, actual: String },
    UnsafeArtifactFileName,
    UnsafeVersion,
    MalformedArtifactDigest,
    UnsupportedManifestFormat,
    HealthCheckFailed,
    FaultInjected(FaultPoint),
    CorruptTransaction,
}

impl std::fmt::Display for SupervisorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "I/O error: {error}"),
            Self::Serialize(error) => write!(formatter, "serialization error: {error}"),
            Self::InvalidTrustAnchor => write!(formatter, "invalid trust anchor"),
            Self::InvalidSignatureEncoding => {
                write!(formatter, "invalid manifest signature encoding")
            }
            Self::InvalidSignature => write!(formatter, "manifest signature verification failed"),
            Self::ArtifactDigestMismatch { expected, actual } => {
                write!(
                    formatter,
                    "artifact digest mismatch: expected {expected}, got {actual}"
                )
            }
            Self::UnsafeArtifactFileName => {
                write!(
                    formatter,
                    "manifest artifact file name is not a safe file component"
                )
            }
            Self::UnsafeVersion => {
                write!(
                    formatter,
                    "manifest version is not a safe generation path component"
                )
            }
            Self::MalformedArtifactDigest => {
                write!(
                    formatter,
                    "manifest artifact digest is not canonical SHA-256"
                )
            }
            Self::UnsupportedManifestFormat => write!(formatter, "unsupported manifest format"),
            Self::HealthCheckFailed => {
                write!(formatter, "candidate generation failed health check")
            }
            Self::FaultInjected(point) => write!(formatter, "fault injected at {point:?}"),
            Self::CorruptTransaction => write!(formatter, "activation transaction is corrupt"),
        }
    }
}

impl std::error::Error for SupervisorError {}

impl From<io::Error> for SupervisorError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ActivationPhase {
    Staged,
    ActivePointerWritten,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActivationTransaction {
    phase: ActivationPhase,
    previous_active: Option<ActiveGeneration>,
    candidate: ActiveGeneration,
}

#[cfg(test)]
#[derive(Clone, Default)]
struct TestHooks {
    after_verified_snapshot: Option<std::sync::Arc<dyn Fn() + Send + Sync>>,
    after_failed_health: Option<std::sync::Arc<dyn Fn() + Send + Sync>>,
}

#[cfg(test)]
impl TestHooks {
    fn after_verified_snapshot(&self) {
        if let Some(hook) = &self.after_verified_snapshot {
            hook();
        }
    }

    fn after_failed_health(&self) {
        if let Some(hook) = &self.after_failed_health {
            hook();
        }
    }
}

#[cfg(test)]
impl std::fmt::Debug for TestHooks {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("TestHooks").finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct Supervisor {
    root: PathBuf,
    #[cfg(test)]
    test_hooks: TestHooks,
}

impl Supervisor {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, SupervisorError> {
        let root = root.into();
        fs::create_dir_all(root.join("generations"))?;
        Ok(Self {
            root,
            #[cfg(test)]
            test_hooks: TestHooks::default(),
        })
    }

    pub fn ensure(
        &self,
        release_root: &Path,
        trust_anchor: &TrustAnchor,
        options: EnsureOptions,
    ) -> Result<ActiveGeneration, SupervisorError> {
        let lock = self.acquire_lock()?;
        self.recover_locked()?;
        let verified = verify_release(release_root, trust_anchor)?;
        #[cfg(test)]
        self.test_hooks.after_verified_snapshot();
        let candidate = ActiveGeneration {
            generation_id: format!(
                "{}-{}",
                verified.manifest.version,
                &verified.manifest.artifact.sha256[..16]
            ),
            version: verified.manifest.version.clone(),
            artifact_sha256: verified.manifest.artifact.sha256.clone(),
        };

        if self.inspect_active_locked()? == Some(candidate.clone()) {
            drop(lock);
            return Ok(candidate);
        }

        let previous_active = self.inspect_active_locked()?;
        let generation_dir = self.root.join("generations").join(&candidate.generation_id);
        self.stage_verified_release(&generation_dir, &verified)?;

        let mut transaction = ActivationTransaction {
            phase: ActivationPhase::Staged,
            previous_active: previous_active.clone(),
            candidate: candidate.clone(),
        };
        self.write_transaction(&transaction)?;
        self.inject_fault(options, FaultPoint::AfterStaged)?;

        // A candidate can become externally observable only after health passes.
        if options.health_check == HealthCheck::Fail {
            #[cfg(test)]
            self.test_hooks.after_failed_health();
            self.remove_transaction()?;
            return Err(SupervisorError::HealthCheckFailed);
        }

        self.write_active(&candidate)?;
        self.inject_fault(
            options,
            FaultPoint::AfterActivePointerWriteBeforePhaseUpdate,
        )?;
        transaction.phase = ActivationPhase::ActivePointerWritten;
        self.write_transaction(&transaction)?;
        self.inject_fault(options, FaultPoint::AfterPhaseUpdateBeforeCommit)?;

        // Readers hold the same lock, so no active pointer is exposed until this
        // transaction is finalized. Any surviving transaction is rollback-only.
        self.remove_transaction()?;
        drop(lock);
        Ok(candidate)
    }

    pub fn recover(&self) -> Result<(), SupervisorError> {
        let lock = self.acquire_lock()?;
        let result = self.recover_locked();
        drop(lock);
        result
    }

    pub fn inspect_active(&self) -> Result<Option<ActiveGeneration>, SupervisorError> {
        let lock = self.acquire_lock()?;
        let result = self
            .recover_locked()
            .and_then(|_| self.inspect_active_locked());
        drop(lock);
        result
    }

    pub fn generation_count(&self) -> Result<usize, SupervisorError> {
        let lock = self.acquire_lock()?;
        let result = self
            .recover_locked()
            .and_then(|_| Ok(fs::read_dir(self.root.join("generations"))?.count()));
        drop(lock);
        result
    }

    fn acquire_lock(&self) -> Result<File, SupervisorError> {
        let lock = File::options()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(self.root.join("supervisor.lock"))?;
        lock.lock()?;
        Ok(lock)
    }

    fn recover_locked(&self) -> Result<(), SupervisorError> {
        let transaction_path = self.root.join(TRANSACTION_FILE);
        if !transaction_path.exists() {
            return Ok(());
        }
        let bytes = fs::read(&transaction_path)?;
        let transaction = serde_json::from_slice::<ActivationTransaction>(&bytes)
            .map_err(|_| SupervisorError::CorruptTransaction)?;
        match transaction.phase {
            ActivationPhase::Staged | ActivationPhase::ActivePointerWritten => {
                self.restore_active(transaction.previous_active.as_ref())?
            }
        }
        self.remove_transaction()
    }

    fn inspect_active_locked(&self) -> Result<Option<ActiveGeneration>, SupervisorError> {
        let active_path = self.root.join(ACTIVE_FILE);
        if !active_path.exists() {
            return Ok(None);
        }
        let active =
            serde_json::from_slice(&fs::read(active_path)?).map_err(SupervisorError::Serialize)?;
        Ok(Some(active))
    }

    fn write_active(&self, active: &ActiveGeneration) -> Result<(), SupervisorError> {
        write_json_atomically(&self.root.join(ACTIVE_FILE), active)
    }

    fn stage_verified_release(
        &self,
        generation_dir: &Path,
        verified: &VerifiedRelease,
    ) -> Result<(), SupervisorError> {
        fs::create_dir_all(generation_dir)?;
        replace_file_atomically(
            &generation_dir.join(&verified.manifest.artifact.file_name),
            &verified.artifact_bytes,
        )?;
        replace_file_atomically(
            &generation_dir.join(MANIFEST_FILE),
            &verified.manifest_bytes,
        )?;
        Ok(())
    }

    fn restore_active(&self, previous: Option<&ActiveGeneration>) -> Result<(), SupervisorError> {
        match previous {
            Some(active) => self.write_active(active),
            None => {
                let active_path = self.root.join(ACTIVE_FILE);
                if active_path.exists() {
                    fs::remove_file(active_path)?;
                }
                Ok(())
            }
        }
    }

    fn write_transaction(
        &self,
        transaction: &ActivationTransaction,
    ) -> Result<(), SupervisorError> {
        write_json_atomically(&self.root.join(TRANSACTION_FILE), transaction)
    }

    fn remove_transaction(&self) -> Result<(), SupervisorError> {
        let path = self.root.join(TRANSACTION_FILE);
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    fn inject_fault(
        &self,
        options: EnsureOptions,
        point: FaultPoint,
    ) -> Result<(), SupervisorError> {
        if options.fault_point == Some(point) {
            match options.fault_behavior {
                FaultBehavior::ReturnError => return Err(SupervisorError::FaultInjected(point)),
                // This behavior exists only in the separate-process evidence driver.
                // `abort` occurs while `ensure` still owns the OS file lock.
                FaultBehavior::AbortProcess => std::process::abort(),
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
struct VerifiedRelease {
    manifest: SignedReleaseManifest,
    manifest_bytes: Vec<u8>,
    artifact_bytes: Vec<u8>,
}

fn verify_release(
    release_root: &Path,
    trust_anchor: &TrustAnchor,
) -> Result<VerifiedRelease, SupervisorError> {
    let manifest_bytes = fs::read(release_root.join(MANIFEST_FILE))?;
    let manifest = serde_json::from_slice::<SignedReleaseManifest>(&manifest_bytes)
        .map_err(SupervisorError::Serialize)?;
    if manifest.format_version != 1 {
        return Err(SupervisorError::UnsupportedManifestFormat);
    }
    if !is_safe_path_component(&manifest.version) {
        return Err(SupervisorError::UnsafeVersion);
    }
    if !is_safe_path_component(&manifest.artifact.file_name) {
        return Err(SupervisorError::UnsafeArtifactFileName);
    }
    if !is_canonical_sha256(&manifest.artifact.sha256) {
        return Err(SupervisorError::MalformedArtifactDigest);
    }
    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(&manifest.signature_base64)
        .map_err(|_| SupervisorError::InvalidSignatureEncoding)?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| SupervisorError::InvalidSignatureEncoding)?;
    trust_anchor
        .verifying_key
        .verify_strict(&manifest.canonical_payload_bytes()?, &signature)
        .map_err(|_| SupervisorError::InvalidSignature)?;

    let artifact_path = release_root.join(&manifest.artifact.file_name);
    let artifact_bytes = fs::read(artifact_path)?;
    let actual = sha256_hex(&artifact_bytes);
    if actual != manifest.artifact.sha256 {
        return Err(SupervisorError::ArtifactDigestMismatch {
            expected: manifest.artifact.sha256,
            actual,
        });
    }
    Ok(VerifiedRelease {
        manifest,
        manifest_bytes,
        artifact_bytes,
    })
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), SupervisorError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(SupervisorError::Serialize)?;
    replace_file_atomically(path, &bytes).map_err(SupervisorError::Io)
}

fn is_safe_path_component(value: &str) -> bool {
    let bytes = value.as_bytes();
    let syntax_is_safe = !bytes.is_empty()
        && bytes.len() <= 128
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'));
    if !syntax_is_safe {
        return false;
    }

    let windows_device_stem = value
        .split_once('.')
        .map_or(value, |(stem, _)| stem)
        .to_ascii_uppercase();
    !matches!(
        windows_device_stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn is_canonical_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

/// Creates a disposable signed fixture release. The signing key is test-only;
/// it is not platform signing and must never be reused for a product release.
pub fn write_fixture_release(
    release_root: &Path,
    version: &str,
    artifact_bytes: &[u8],
    signing_key: &SigningKey,
) -> Result<(), SupervisorError> {
    fs::create_dir_all(release_root)?;
    let artifact = ArtifactDescriptor {
        file_name: "fixture-runtime.bin".to_owned(),
        sha256: sha256_hex(artifact_bytes),
    };
    fs::write(release_root.join(&artifact.file_name), artifact_bytes)?;
    let unsigned = SignedReleaseManifest {
        format_version: 1,
        version: version.to_owned(),
        artifact,
        signature_base64: String::new(),
    };
    let signature = signing_key.sign(&unsigned.canonical_payload_bytes()?);
    let manifest = SignedReleaseManifest {
        signature_base64: base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
        ..unsigned
    };
    write_json_atomically(&release_root.join(MANIFEST_FILE), &manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::Duration;
    use tempfile::TempDir;

    fn fixture_key() -> SigningKey {
        SigningKey::from_bytes(&[0x5a; 32])
    }

    fn release(root: &Path, version: &str, body: &[u8], key: &SigningKey) {
        write_fixture_release(root, version, body, key).expect("fixture release must be writable");
    }

    fn supervisor_with_test_hooks(root: &Path, test_hooks: TestHooks) -> Supervisor {
        fs::create_dir_all(root.join("generations")).expect("supervisor root must be writable");
        Supervisor {
            root: root.to_path_buf(),
            test_hooks,
        }
    }

    #[test]
    fn inspect_waits_for_failed_health_and_reports_only_the_previous_generation() {
        let temp = TempDir::new().expect("temporary root");
        let supervisor_root = temp.path().join("supervisor");
        let good_release = temp.path().join("good");
        let rejected_release = temp.path().join("rejected");
        let key = fixture_key();
        let anchor = TrustAnchor::from_signing_key(&key);
        release(&good_release, "1.0.0", b"good", &key);
        release(&rejected_release, "2.0.0", b"rejected", &key);

        let (failed_health_started_tx, failed_health_started_rx) = mpsc::channel();
        let (resume_failure_tx, resume_failure_rx) = mpsc::channel();
        let resume_failure_rx = Arc::new(Mutex::new(resume_failure_rx));
        let hooks = TestHooks {
            after_failed_health: Some(Arc::new(move || {
                failed_health_started_tx
                    .send(())
                    .expect("test must observe failed health");
                resume_failure_rx
                    .lock()
                    .expect("test health gate lock")
                    .recv()
                    .expect("test must release failed health");
            })),
            ..TestHooks::default()
        };
        let supervisor = Arc::new(supervisor_with_test_hooks(&supervisor_root, hooks));
        supervisor
            .ensure(&good_release, &anchor, EnsureOptions::default())
            .expect("good generation activates");

        let ensuring_supervisor = Arc::clone(&supervisor);
        let ensuring_release = rejected_release.clone();
        let ensuring_anchor = anchor.clone();
        let ensure_thread = thread::spawn(move || {
            ensuring_supervisor.ensure(
                &ensuring_release,
                &ensuring_anchor,
                EnsureOptions {
                    health_check: HealthCheck::Fail,
                    ..EnsureOptions::default()
                },
            )
        });
        failed_health_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("failed health must hold the activation lock");

        let persisted_active = serde_json::from_slice::<ActiveGeneration>(
            &fs::read(supervisor_root.join(ACTIVE_FILE)).expect("active pointer reads"),
        )
        .expect("active pointer parses");
        assert_eq!(
            persisted_active.version, "1.0.0",
            "a failed candidate must never replace the active pointer"
        );

        let inspecting_root = supervisor_root.clone();
        let (inspect_result_tx, inspect_result_rx) = mpsc::channel();
        let inspect_thread = thread::spawn(move || {
            inspect_result_tx
                .send(
                    Supervisor::open(inspecting_root)
                        .expect("independent inspector opens")
                        .inspect_active(),
                )
                .expect("test must receive inspect result");
        });
        assert!(
            matches!(
                inspect_result_rx.recv_timeout(Duration::from_millis(100)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "inspect must serialize behind a failing activation"
        );

        resume_failure_tx
            .send(())
            .expect("test must release failed health");
        assert!(matches!(
            ensure_thread.join().expect("ensure thread must not panic"),
            Err(SupervisorError::HealthCheckFailed)
        ));
        let active = inspect_result_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("inspect must finish after failed health")
            .expect("inspect succeeds")
            .expect("previous generation remains active");
        assert_eq!(active.version, "1.0.0");
        inspect_thread
            .join()
            .expect("inspect thread must not panic");
    }

    #[test]
    fn staging_uses_the_verified_artifact_snapshot_after_source_mutation() {
        let temp = TempDir::new().expect("temporary root");
        let supervisor_root = temp.path().join("supervisor");
        let release_root = temp.path().join("release");
        let original_artifact = b"verified artifact snapshot";
        let mutated_artifact = b"source changed after verification".to_vec();
        let key = fixture_key();
        let anchor = TrustAnchor::from_signing_key(&key);
        release(&release_root, "1.0.0", original_artifact, &key);
        let original_manifest =
            fs::read(release_root.join(MANIFEST_FILE)).expect("fixture manifest reads");
        let source_artifact = release_root.join("fixture-runtime.bin");
        let mutation_path = source_artifact.clone();
        let mutation_for_hook = mutated_artifact.clone();
        let hooks = TestHooks {
            after_verified_snapshot: Some(Arc::new(move || {
                fs::write(&mutation_path, &mutation_for_hook)
                    .expect("test source mutation must succeed");
            })),
            ..TestHooks::default()
        };
        let supervisor = supervisor_with_test_hooks(&supervisor_root, hooks);

        let active = supervisor
            .ensure(&release_root, &anchor, EnsureOptions::default())
            .expect("verified snapshot activates despite later source mutation");
        let generation_dir = supervisor_root
            .join("generations")
            .join(&active.generation_id);
        let staged_artifact =
            fs::read(generation_dir.join("fixture-runtime.bin")).expect("staged artifact reads");
        assert_eq!(staged_artifact, original_artifact);
        assert_eq!(sha256_hex(&staged_artifact), active.artifact_sha256);
        assert_eq!(
            fs::read(generation_dir.join(MANIFEST_FILE)).expect("staged manifest reads"),
            original_manifest
        );
        assert_eq!(
            fs::read(source_artifact).expect("mutated source reads"),
            mutated_artifact
        );
    }
}
