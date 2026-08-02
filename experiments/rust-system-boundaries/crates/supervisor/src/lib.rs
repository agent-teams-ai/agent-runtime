//! Evidence-only Local Supervisor boundary.
//!
//! This crate owns neither runtime domain state nor distributed authority. It
//! verifies a signed release, stages one local generation, starts its staged
//! Host artifact, and accepts activation only after a fresh, generation-bound
//! health witness passes local process-identity checks.

use atomic_state_file::replace_file_atomically;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

const MANIFEST_FILE: &str = "release-manifest.json";
const ACTIVE_FILE: &str = "active-generation.json";
const TRANSACTION_FILE: &str = "activation-transaction.json";
const HEALTH_MAX_BYTES: usize = 16 * 1024;
const DEFAULT_HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(unix)]
const POSIX_ENOENT: i32 = 2;
#[cfg(unix)]
const POSIX_ESRCH: i32 = 3;

#[cfg(target_os = "macos")]
const MACOS_PROC_PIDTBSDINFO: i32 = 3;

#[cfg(target_os = "macos")]
#[repr(C)]
struct MacosProcBsdInfo {
    pbi_flags: u32,
    pbi_status: u32,
    pbi_xstatus: u32,
    pbi_pid: u32,
    pbi_ppid: u32,
    pbi_uid: u32,
    pbi_gid: u32,
    pbi_ruid: u32,
    pbi_rgid: u32,
    pbi_svuid: u32,
    pbi_svgid: u32,
    rfu_1: u32,
    pbi_comm: [std::os::raw::c_char; 16],
    pbi_name: [std::os::raw::c_char; 32],
    pbi_nfiles: u32,
    pbi_pgid: u32,
    pbi_pjobc: u32,
    e_tdev: u32,
    e_tpgid: u32,
    pbi_nice: i32,
    pbi_start_tvsec: u64,
    pbi_start_tvusec: u64,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    #[link_name = "proc_pidinfo"]
    fn macos_proc_pidinfo(
        pid: i32,
        flavor: i32,
        arg: u64,
        buffer: *mut std::ffi::c_void,
        buffer_size: i32,
    ) -> i32;
}

#[cfg(windows)]
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
#[cfg(windows)]
const WINDOWS_ERROR_INVALID_PARAMETER: i32 = 87;
#[cfg(windows)]
const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct WindowsFileTime {
    dw_low_date_time: u32,
    dw_high_date_time: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "OpenProcess"]
    fn open_process(
        desired_access: u32,
        inherit_handle: i32,
        process_id: u32,
    ) -> *mut std::ffi::c_void;
    #[link_name = "GetProcessTimes"]
    fn get_process_times(
        handle: *mut std::ffi::c_void,
        creation: *mut WindowsFileTime,
        exit: *mut WindowsFileTime,
        kernel: *mut WindowsFileTime,
        user: *mut WindowsFileTime,
    ) -> i32;
    #[link_name = "CloseHandle"]
    fn close_handle(handle: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
#[link(name = "bcrypt")]
unsafe extern "system" {
    #[link_name = "BCryptGenRandom"]
    fn bcrypt_gen_random(
        algorithm: *mut std::ffi::c_void,
        buffer: *mut u8,
        buffer_len: u32,
        flags: u32,
    ) -> i32;
}

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
    pub artifact_file_name: String,
    pub artifact_sha256: String,
}

/// Target-native evidence used to distinguish a reused PID from the process
/// that published a health witness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
pub enum ProcessBirthIdentity {
    LinuxProcStartTime {
        boot_id: String,
        start_time_ticks: u64,
    },
    MacosProcStartTime {
        seconds: u64,
        microseconds: u64,
    },
    WindowsCreationTime {
        filetime_100ns: u64,
    },
}

/// The locally verified identity of a running staged Host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostObservation {
    pub generation_id: String,
    pub generation_digest: String,
    pub pid: u32,
    pub birth_identity: ProcessBirthIdentity,
}

/// Host launch inputs. They select process arguments only; they do not carry a
/// caller-supplied health result.
#[derive(Debug, Clone)]
pub struct HostLaunch {
    pub extra_args: Vec<String>,
    pub health_timeout: Duration,
}

impl Default for HostLaunch {
    fn default() -> Self {
        Self {
            extra_args: Vec::new(),
            health_timeout: DEFAULT_HEALTH_TIMEOUT,
        }
    }
}

impl HostLaunch {
    pub fn with_extra_args(extra_args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            extra_args: extra_args.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HealthWitness {
    pub generation_id: String,
    pub generation_digest: String,
    pub executable_digest: String,
    pub launch_nonce: String,
    pub pid: u32,
    pub birth_identity: ProcessBirthIdentity,
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
    pub fault_point: Option<FaultPoint>,
    pub fault_behavior: FaultBehavior,
}

impl Default for EnsureOptions {
    fn default() -> Self {
        Self {
            fault_point: None,
            fault_behavior: FaultBehavior::ReturnError,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthWitnessRejection {
    NonceMismatch,
    GenerationIdMismatch,
    GenerationDigestMismatch,
    ExecutableDigestMismatch,
    PidMismatch,
    BirthIdentityMismatch,
    ProcessIdentityChanged,
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
    StagedGenerationMismatch,
    HostExitedBeforeHealth,
    HealthWitnessTimeout,
    HealthWitnessReadTimeout,
    HealthWitnessTooLarge,
    HealthWitnessMalformed,
    HealthWitnessRejected(HealthWitnessRejection),
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
            Self::StagedGenerationMismatch => {
                write!(
                    formatter,
                    "staged generation does not match its active record"
                )
            }
            Self::HostExitedBeforeHealth => {
                write!(formatter, "candidate Host exited before health")
            }
            Self::HealthWitnessTimeout => {
                write!(formatter, "candidate Host health witness timed out")
            }
            Self::HealthWitnessReadTimeout => {
                write!(formatter, "candidate Host health witness did not finish")
            }
            Self::HealthWitnessTooLarge => {
                write!(formatter, "candidate Host health witness is too large")
            }
            Self::HealthWitnessMalformed => {
                write!(formatter, "candidate Host health witness is malformed")
            }
            Self::HealthWitnessRejected(reason) => {
                write!(
                    formatter,
                    "candidate Host health witness was rejected: {reason:?}"
                )
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

#[derive(Debug)]
struct RunningHost {
    observation: HostObservation,
    child: Child,
}

#[derive(Debug)]
pub struct Supervisor {
    root: PathBuf,
    running_host: Mutex<Option<RunningHost>>,
}

impl Supervisor {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, SupervisorError> {
        let root = root.into();
        fs::create_dir_all(root.join("generations"))?;
        Ok(Self {
            root,
            running_host: Mutex::new(None),
        })
    }

    pub fn ensure(
        &self,
        release_root: &Path,
        trust_anchor: &TrustAnchor,
        host_launch: &HostLaunch,
        options: EnsureOptions,
    ) -> Result<ActiveGeneration, SupervisorError> {
        let lock = self.acquire_lock()?;
        self.recover_locked()?;
        let verified = verify_release(release_root, trust_anchor)?;
        let candidate = ActiveGeneration {
            generation_id: format!(
                "{}-{}",
                verified.manifest.version,
                &verified.manifest.artifact.sha256[..16]
            ),
            version: verified.manifest.version.clone(),
            artifact_file_name: verified.manifest.artifact.file_name.clone(),
            artifact_sha256: verified.manifest.artifact.sha256.clone(),
        };

        let mut running_host = self.lock_running_host();
        if self.inspect_active_locked()? == Some(candidate.clone()) {
            drop(running_host);
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

        let mut candidate_host = self.spawn_and_verify_host(&candidate, host_launch)?;
        if let Err(error) = self.write_active(&candidate) {
            let _ = terminate_host(&mut candidate_host);
            return Err(error);
        }
        if let Err(error) = self.inject_fault(
            options,
            FaultPoint::AfterActivePointerWriteBeforePhaseUpdate,
        ) {
            let _ = terminate_host(&mut candidate_host);
            return Err(error);
        }
        transaction.phase = ActivationPhase::ActivePointerWritten;
        if let Err(error) = self.write_transaction(&transaction) {
            let _ = terminate_host(&mut candidate_host);
            return Err(error);
        }
        if let Err(error) = self.inject_fault(options, FaultPoint::AfterPhaseUpdateBeforeCommit) {
            let _ = terminate_host(&mut candidate_host);
            return Err(error);
        }
        if let Err(error) = self.remove_transaction() {
            let _ = terminate_host(&mut candidate_host);
            return Err(error);
        }

        let previous_host = running_host.replace(candidate_host);
        if let Some(mut previous_host) = previous_host {
            terminate_host(&mut previous_host)?;
        }
        drop(running_host);
        drop(lock);
        Ok(candidate)
    }

    /// Starts the currently selected generation after a Supervisor restart, or
    /// replaces a crashed local Host with a new verified instance.
    pub fn ensure_active_host(
        &self,
        host_launch: &HostLaunch,
    ) -> Result<HostObservation, SupervisorError> {
        let lock = self.acquire_lock()?;
        self.recover_locked()?;
        let active = self
            .inspect_active_locked()?
            .ok_or(SupervisorError::StagedGenerationMismatch)?;
        let mut running_host = self.lock_running_host();
        let observation =
            self.ensure_active_host_locked(&active, host_launch, &mut running_host)?;
        drop(running_host);
        drop(lock);
        Ok(observation)
    }

    /// Returns a currently owned Host only when it is both live and still
    /// associated with the active generation.
    pub fn inspect_active_host(&self) -> Result<Option<HostObservation>, SupervisorError> {
        let lock = self.acquire_lock()?;
        self.recover_locked()?;
        let active = self.inspect_active_locked()?;
        let mut running_host = self.lock_running_host();
        let observation = if let (Some(active), Some(host)) = (active, running_host.as_mut()) {
            if host.observation.generation_id == active.generation_id && host_is_live(host)? {
                Some(host.observation.clone())
            } else {
                None
            }
        } else {
            None
        };
        drop(running_host);
        drop(lock);
        Ok(observation)
    }

    /// Diagnostic helper for the spike tests. It never authorizes a process;
    /// it only proves whether an observed PID still has the same birth value.
    pub fn observation_is_live(
        &self,
        observation: &HostObservation,
    ) -> Result<bool, SupervisorError> {
        match process_birth_identity(observation.pid) {
            Ok(actual) => Ok(actual == observation.birth_identity),
            Err(error) if process_identity_error_means_gone(&error) => Ok(false),
            Err(error) => Err(error),
        }
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

    fn ensure_active_host_locked(
        &self,
        active: &ActiveGeneration,
        host_launch: &HostLaunch,
        running_host: &mut Option<RunningHost>,
    ) -> Result<HostObservation, SupervisorError> {
        if let Some(host) = running_host.as_mut()
            && host.observation.generation_id == active.generation_id
            && host_is_live(host)?
        {
            return Ok(host.observation.clone());
        }

        if let Some(mut stale_host) = running_host.take() {
            terminate_host(&mut stale_host)?;
        }
        let host = self.spawn_and_verify_host(active, host_launch)?;
        let observation = host.observation.clone();
        *running_host = Some(host);
        Ok(observation)
    }

    fn spawn_and_verify_host(
        &self,
        active: &ActiveGeneration,
        host_launch: &HostLaunch,
    ) -> Result<RunningHost, SupervisorError> {
        let artifact_path = self.staged_artifact_path(active)?;
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let endpoint = listener.local_addr()?.to_string();
        let nonce = secure_nonce()?;
        let mut command = Command::new(&artifact_path);
        command
            .args(&host_launch.extra_args)
            .arg("--health-endpoint")
            .arg(endpoint)
            .arg("--health-nonce")
            .arg(&nonce)
            .arg("--generation-id")
            .arg(&active.generation_id)
            .arg("--generation-digest")
            .arg(&active.artifact_sha256)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn()?;
        let birth_identity = match process_birth_identity(child.id()) {
            Ok(identity) => identity,
            Err(error) => {
                let _ = terminate_child(&mut child);
                return Err(error);
            }
        };
        let observation = HostObservation {
            generation_id: active.generation_id.clone(),
            generation_digest: active.artifact_sha256.clone(),
            pid: child.id(),
            birth_identity: birth_identity.clone(),
        };
        let witness_result = wait_for_health_witness(
            &listener,
            &mut child,
            &observation,
            &nonce,
            host_launch.health_timeout,
        );
        if let Err(error) = witness_result {
            let _ = terminate_child(&mut child);
            return Err(error);
        }
        Ok(RunningHost { observation, child })
    }

    fn staged_artifact_path(&self, active: &ActiveGeneration) -> Result<PathBuf, SupervisorError> {
        let generation_dir = self.root.join("generations").join(&active.generation_id);
        let manifest_path = generation_dir.join(MANIFEST_FILE);
        let manifest = serde_json::from_slice::<SignedReleaseManifest>(&fs::read(manifest_path)?)
            .map_err(SupervisorError::Serialize)?;
        if manifest.format_version != 1
            || manifest.version != active.version
            || manifest.artifact.file_name != active.artifact_file_name
            || manifest.artifact.sha256 != active.artifact_sha256
        {
            return Err(SupervisorError::StagedGenerationMismatch);
        }
        let artifact_path = generation_dir.join(&active.artifact_file_name);
        let actual_digest = sha256_hex(&fs::read(&artifact_path)?);
        if actual_digest != active.artifact_sha256 {
            return Err(SupervisorError::ArtifactDigestMismatch {
                expected: active.artifact_sha256.clone(),
                actual: actual_digest,
            });
        }
        Ok(artifact_path)
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

    fn lock_running_host(&self) -> std::sync::MutexGuard<'_, Option<RunningHost>> {
        self.running_host
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
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
        let staged_artifact = generation_dir.join(&verified.manifest.artifact.file_name);
        replace_file_atomically(&staged_artifact, &verified.artifact_bytes)?;
        make_executable(&staged_artifact)?;
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
                // The fixture Host self-terminates after its health report there.
                FaultBehavior::AbortProcess => std::process::abort(),
            }
        }
        Ok(())
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        let Ok(running_host) = self.running_host.get_mut() else {
            return;
        };
        if let Some(mut host) = running_host.take() {
            let _ = terminate_host(&mut host);
        }
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

fn wait_for_health_witness(
    listener: &TcpListener,
    child: &mut Child,
    expected: &HostObservation,
    expected_nonce: &str,
    timeout: Duration,
) -> Result<(), SupervisorError> {
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            return Err(SupervisorError::HostExitedBeforeHealth);
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let witness = read_health_witness(stream, remaining)?;
                verify_health_witness(&witness, child, expected, expected_nonce)?;
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(SupervisorError::HealthWitnessTimeout);
                }
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => return Err(SupervisorError::Io(error)),
        }
    }
}

fn read_health_witness(
    mut stream: TcpStream,
    timeout: Duration,
) -> Result<HealthWitness, SupervisorError> {
    stream.set_read_timeout(Some(timeout.max(Duration::from_millis(1))))?;
    let mut length = [0_u8; 4];
    read_health_frame(&mut stream, &mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > HEALTH_MAX_BYTES {
        return Err(SupervisorError::HealthWitnessTooLarge);
    }
    let mut bytes = vec![0_u8; length];
    read_health_frame(&mut stream, &mut bytes)?;
    serde_json::from_slice(&bytes).map_err(|_| SupervisorError::HealthWitnessMalformed)
}

fn read_health_frame(stream: &mut TcpStream, bytes: &mut [u8]) -> Result<(), SupervisorError> {
    stream.read_exact(bytes).map_err(|error| {
        if matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ) {
            SupervisorError::HealthWitnessReadTimeout
        } else {
            SupervisorError::Io(error)
        }
    })
}

fn verify_health_witness(
    witness: &HealthWitness,
    child: &mut Child,
    expected: &HostObservation,
    expected_nonce: &str,
) -> Result<(), SupervisorError> {
    if witness.launch_nonce != expected_nonce {
        return Err(SupervisorError::HealthWitnessRejected(
            HealthWitnessRejection::NonceMismatch,
        ));
    }
    if witness.generation_id != expected.generation_id {
        return Err(SupervisorError::HealthWitnessRejected(
            HealthWitnessRejection::GenerationIdMismatch,
        ));
    }
    if witness.generation_digest != expected.generation_digest {
        return Err(SupervisorError::HealthWitnessRejected(
            HealthWitnessRejection::GenerationDigestMismatch,
        ));
    }
    if witness.executable_digest != expected.generation_digest {
        return Err(SupervisorError::HealthWitnessRejected(
            HealthWitnessRejection::ExecutableDigestMismatch,
        ));
    }
    if witness.pid != expected.pid {
        return Err(SupervisorError::HealthWitnessRejected(
            HealthWitnessRejection::PidMismatch,
        ));
    }
    if witness.birth_identity != expected.birth_identity {
        return Err(SupervisorError::HealthWitnessRejected(
            HealthWitnessRejection::BirthIdentityMismatch,
        ));
    }
    if child.try_wait()?.is_some() {
        return Err(SupervisorError::HostExitedBeforeHealth);
    }
    match process_birth_identity(expected.pid) {
        Ok(actual) if actual == expected.birth_identity => {}
        Ok(_) => {
            return Err(SupervisorError::HealthWitnessRejected(
                HealthWitnessRejection::ProcessIdentityChanged,
            ));
        }
        Err(error) if process_identity_error_means_gone(&error) => {
            return Err(SupervisorError::HostExitedBeforeHealth);
        }
        Err(error) => return Err(error),
    }
    Ok(())
}

fn host_is_live(host: &mut RunningHost) -> Result<bool, SupervisorError> {
    if host.child.try_wait()?.is_some() {
        return Ok(false);
    }
    match process_birth_identity(host.observation.pid) {
        Ok(actual) => Ok(actual == host.observation.birth_identity),
        Err(error) if process_identity_error_means_gone(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

fn terminate_host(host: &mut RunningHost) -> Result<(), SupervisorError> {
    terminate_child(&mut host.child)
}

fn terminate_child(child: &mut Child) -> Result<(), SupervisorError> {
    if child.try_wait()?.is_none() {
        child.kill()?;
        child.wait()?;
    }
    Ok(())
}

fn secure_nonce() -> Result<String, SupervisorError> {
    let mut bytes = [0_u8; 32];
    fill_secure_random(&mut bytes)?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(unix)]
fn fill_secure_random(bytes: &mut [u8]) -> Result<(), SupervisorError> {
    File::open("/dev/urandom")?.read_exact(bytes)?;
    Ok(())
}

#[cfg(windows)]
fn fill_secure_random(bytes: &mut [u8]) -> Result<(), SupervisorError> {
    let status = unsafe {
        bcrypt_gen_random(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(SupervisorError::Io(io::Error::other(format!(
            "BCryptGenRandom failed with status {status}"
        ))));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn fill_secure_random(_bytes: &mut [u8]) -> Result<(), SupervisorError> {
    Err(SupervisorError::Io(io::Error::new(
        io::ErrorKind::Unsupported,
        "secure random nonce is unsupported on this target",
    )))
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), SupervisorError> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), SupervisorError> {
    Ok(())
}

/// Returns a target-native process birth value that can be re-read later to
/// distinguish a reused PID from the process that published a health witness.
pub fn current_process_birth_identity() -> Result<ProcessBirthIdentity, SupervisorError> {
    process_birth_identity(std::process::id())
}

#[cfg(target_os = "linux")]
fn process_birth_identity(pid: u32) -> Result<ProcessBirthIdentity, SupervisorError> {
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")?
        .trim()
        .to_owned();
    if boot_id.is_empty() || boot_id.len() > 128 || !boot_id.is_ascii() {
        return Err(SupervisorError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "Linux boot identity is invalid",
        )));
    }
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let closing_parenthesis = stat.rfind(')').ok_or_else(|| {
        SupervisorError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "Linux process stat record has no command terminator",
        ))
    })?;
    let start_time_ticks = stat[closing_parenthesis + 1..]
        .split_whitespace()
        .nth(19)
        .ok_or_else(|| {
            SupervisorError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "Linux process stat record has no start-time field",
            ))
        })?
        .parse::<u64>()
        .map_err(|_| {
            SupervisorError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "Linux process start-time field is invalid",
            ))
        })?;
    Ok(ProcessBirthIdentity::LinuxProcStartTime {
        boot_id,
        start_time_ticks,
    })
}

#[cfg(target_os = "macos")]
fn process_birth_identity(pid: u32) -> Result<ProcessBirthIdentity, SupervisorError> {
    use std::mem::size_of;

    let mut info: MacosProcBsdInfo = unsafe { std::mem::zeroed() };
    let read = unsafe {
        macos_proc_pidinfo(
            pid as i32,
            MACOS_PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut std::ffi::c_void,
            size_of::<MacosProcBsdInfo>() as i32,
        )
    };
    if read != size_of::<MacosProcBsdInfo>() as i32 {
        return Err(SupervisorError::Io(io::Error::last_os_error()));
    }
    Ok(ProcessBirthIdentity::MacosProcStartTime {
        seconds: info.pbi_start_tvsec,
        microseconds: info.pbi_start_tvusec,
    })
}

#[cfg(windows)]
fn process_birth_identity(pid: u32) -> Result<ProcessBirthIdentity, SupervisorError> {
    unsafe {
        let handle = open_process(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return Err(SupervisorError::Io(io::Error::last_os_error()));
        }
        let mut creation = WindowsFileTime::default();
        let mut exit = WindowsFileTime::default();
        let mut kernel = WindowsFileTime::default();
        let mut user = WindowsFileTime::default();
        let read = get_process_times(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        let error = if read == 0 {
            Some(io::Error::last_os_error())
        } else {
            None
        };
        close_handle(handle);
        if let Some(error) = error {
            return Err(SupervisorError::Io(error));
        }
        Ok(ProcessBirthIdentity::WindowsCreationTime {
            filetime_100ns: u64::from(creation.dw_low_date_time)
                | (u64::from(creation.dw_high_date_time) << 32),
        })
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn process_birth_identity(_pid: u32) -> Result<ProcessBirthIdentity, SupervisorError> {
    Err(SupervisorError::Io(io::Error::new(
        io::ErrorKind::Unsupported,
        "no re-readable OS process birth identity is implemented for this target",
    )))
}

#[cfg(unix)]
fn process_identity_error_means_gone(error: &SupervisorError) -> bool {
    matches!(
        error,
        SupervisorError::Io(error)
            if matches!(error.raw_os_error(), Some(POSIX_ESRCH) | Some(POSIX_ENOENT))
    )
}

#[cfg(windows)]
fn process_identity_error_means_gone(error: &SupervisorError) -> bool {
    matches!(
        error,
        SupervisorError::Io(error)
            if error.raw_os_error() == Some(WINDOWS_ERROR_INVALID_PARAMETER)
    )
}

#[cfg(not(any(unix, windows)))]
fn process_identity_error_means_gone(_error: &SupervisorError) -> bool {
    false
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
    write_fixture_release_with_artifact(
        release_root,
        version,
        "fixture-runtime.bin",
        artifact_bytes,
        signing_key,
    )
}

/// Creates a fixture release whose artifact can be an executable synthetic Host.
pub fn write_fixture_release_with_artifact(
    release_root: &Path,
    version: &str,
    artifact_file_name: &str,
    artifact_bytes: &[u8],
    signing_key: &SigningKey,
) -> Result<(), SupervisorError> {
    if !is_safe_path_component(version) {
        return Err(SupervisorError::UnsafeVersion);
    }
    if !is_safe_path_component(artifact_file_name) {
        return Err(SupervisorError::UnsafeArtifactFileName);
    }
    fs::create_dir_all(release_root)?;
    let artifact = ArtifactDescriptor {
        file_name: artifact_file_name.to_owned(),
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
