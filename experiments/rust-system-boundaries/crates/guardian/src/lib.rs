//! Evidence-only Execution Guardian.
//!
//! The Guardian owns physical process custody only: spawning a disposable
//! fixture, bounded stream capture, host containment, and technical recovery
//! evidence. It does not own runtime domain state, authorization, distributed
//! locks, retries, or recovery decisions.

use atomic_state_file::replace_file_atomically;
use boundary_protocol::{
    GuardianCommand, ProtocolErrorCode, RequestEnvelope, validate_protocol_version,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static IDENTIFIER_COUNTER: AtomicU64 = AtomicU64::new(0);

const CUSTODY_SCHEMA_VERSION: u16 = 2;
const DEFAULT_CAPTURE_LIMIT: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardianErrorCode {
    StaleFence,
    RequestConflict,
    OperationConflict,
    IdentityUnverified,
    OperationNotFound,
    Unsupported,
    Protocol,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustodyState {
    Launching,
    Live,
    Terminated,
    LaunchUncertain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContainmentMechanism {
    UnixProcessGroup,
    WindowsJobObject,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContainmentReport {
    pub mechanism: ContainmentMechanism,
    pub qualified_for_bounded_fixture: bool,
    pub limitation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustodyObservation {
    pub operation_id: String,
    pub custody_id: String,
    pub pid: Option<u32>,
    pub state: CustodyState,
    pub containment: ContainmentReport,
    pub spawn_attempts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamSnapshot {
    pub stdout: String,
    pub stderr: String,
    pub stdout_dropped_bytes: usize,
    pub stderr_dropped_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status", deny_unknown_fields)]
pub enum GuardianResult {
    Spawned {
        observation: CustodyObservation,
    },
    Replay {
        observation: CustodyObservation,
    },
    OperationAlreadyExists {
        observation: CustodyObservation,
    },
    Found {
        observation: CustodyObservation,
    },
    NotFound {
        operation_id: String,
    },
    ReconcileVerifiedLive {
        observation: CustodyObservation,
    },
    ReconcileGone {
        observation: CustodyObservation,
    },
    ReconcileIdentityUnverified {
        observation: CustodyObservation,
    },
    ReconcileLaunchUncertain {
        observation: CustodyObservation,
    },
    Terminated {
        observation: CustodyObservation,
    },
    FenceAdvanced {
        observation: CustodyObservation,
    },
    Containment {
        report: ContainmentReport,
    },
    Rejected {
        code: GuardianErrorCode,
        detail: String,
    },
    ProtocolRejected {
        code: ProtocolErrorCode,
        detail: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchOutcome {
    Respond(GuardianResult),
    DropResponse,
}

#[derive(Debug)]
pub enum GuardianError {
    Io(io::Error),
    Serialize(serde_json::Error),
    InvalidOperationId,
    CorruptCustodyEvidence,
    StateRootLocked,
    UnsupportedPlatform(String),
    UnsupportedFixtureMode,
    SpawnFailed(String),
}

/// Deterministic fault points for the Windows debug-test hook.
///
/// The hook itself is not compiled into release builds and is not part of the
/// Guardian wire protocol. Each point exercises the real suspended-process
/// cleanup path.
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[doc(hidden)]
pub enum WindowsContainmentFaultPoint {
    AfterSuspendedCreate,
    AfterJobCreate,
    AfterJobAssignment,
    BeforeResume,
    AfterResume,
}

impl std::fmt::Display for GuardianError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "I/O error: {error}"),
            Self::Serialize(error) => write!(formatter, "serialization error: {error}"),
            Self::InvalidOperationId => {
                write!(formatter, "operation ID cannot name an unsafe path")
            }
            Self::CorruptCustodyEvidence => write!(formatter, "custody evidence is corrupt"),
            Self::StateRootLocked => {
                write!(formatter, "another Guardian already owns this state root")
            }
            Self::UnsupportedPlatform(detail) => {
                write!(
                    formatter,
                    "unsupported Guardian platform capability: {detail}"
                )
            }
            Self::UnsupportedFixtureMode => write!(formatter, "fixture mode is not supported"),
            Self::SpawnFailed(detail) => write!(formatter, "fixture spawn failed: {detail}"),
        }
    }
}

/// OS-backed process birth evidence. The Guardian only establishes persistent
/// custody on targets that can re-read the same value during reconciliation.
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

impl std::error::Error for GuardianError {}

impl From<io::Error> for GuardianError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentityProof {
    custody_id: String,
    spawn_nonce: String,
    pid: u32,
    birth_identity: ProcessBirthIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FenceAdvanceReceipt {
    request_id: String,
    request_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CustodyRecord {
    schema_version: u16,
    request_id: String,
    request_fingerprint: String,
    operation_id: String,
    operation_fingerprint: String,
    fence_digest: String,
    custody_id: String,
    spawn_nonce: String,
    pid: Option<u32>,
    birth_identity: Option<ProcessBirthIdentity>,
    process_group_id: Option<i32>,
    identity_path: PathBuf,
    descendant_pid_path: PathBuf,
    release_descendant_path: PathBuf,
    termination_marker_path: PathBuf,
    fixture_mode: String,
    state: CustodyState,
    containment: ContainmentReport,
    spawn_attempts: u32,
    fence_advance_receipts: Vec<FenceAdvanceReceipt>,
}

impl CustodyRecord {
    fn observation(&self) -> CustodyObservation {
        CustodyObservation {
            operation_id: self.operation_id.clone(),
            custody_id: self.custody_id.clone(),
            pid: self.pid,
            state: self.state.clone(),
            containment: self.containment.clone(),
            spawn_attempts: self.spawn_attempts,
        }
    }
}

#[derive(Debug, Clone)]
struct CachedRequest {
    fingerprint: String,
    result: GuardianResult,
    drop_response: bool,
}

#[derive(Debug)]
struct BoundedCapture {
    bytes: Vec<u8>,
    dropped_bytes: usize,
    limit: usize,
}

impl BoundedCapture {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            dropped_bytes: 0,
            limit,
        }
    }

    fn append(&mut self, bytes: &[u8]) {
        let remaining = self.limit.saturating_sub(self.bytes.len());
        let accepted = remaining.min(bytes.len());
        self.bytes.extend_from_slice(&bytes[..accepted]);
        self.dropped_bytes += bytes.len() - accepted;
    }
}

#[derive(Debug)]
struct LiveProcess {
    child: Child,
    birth_identity: ProcessBirthIdentity,
    stdout: Arc<Mutex<BoundedCapture>>,
    stderr: Arc<Mutex<BoundedCapture>>,
    readers: Vec<JoinHandle<()>>,
    containment: LiveContainment,
}

#[derive(Debug)]
enum LiveContainment {
    #[cfg(unix)]
    UnixProcessGroup { process_group_id: i32 },
    #[cfg(windows)]
    WindowsJobObject(WindowsJobObject),
    #[cfg(not(any(unix, windows)))]
    Unsupported,
}

#[derive(Debug)]
struct StateRootLock {
    file: fs::File,
}

fn acquire_state_root_lock(root: &Path) -> Result<StateRootLock, GuardianError> {
    fs::create_dir_all(root)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(root.join(".guardian-state.lock"))?;
    lock_state_root_file(file)
}

#[cfg(unix)]
fn lock_state_root_file(file: fs::File) -> Result<StateRootLock, GuardianError> {
    use std::os::unix::io::AsRawFd;

    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        return Ok(StateRootLock { file });
    }

    let error = io::Error::last_os_error();
    let raw_os_error = error.raw_os_error();
    if raw_os_error == Some(libc::EWOULDBLOCK) || raw_os_error == Some(libc::EAGAIN) {
        Err(GuardianError::StateRootLocked)
    } else {
        Err(GuardianError::Io(error))
    }
}

#[cfg(unix)]
impl Drop for StateRootLock {
    fn drop(&mut self) {
        use std::os::unix::io::AsRawFd;

        unsafe {
            let _ = libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy)]
struct WindowsOverlapped {
    internal: usize,
    internal_high: usize,
    offset: u32,
    offset_high: u32,
    event: *mut core::ffi::c_void,
}

#[cfg(windows)]
impl Default for WindowsOverlapped {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LockFileEx(
        file: windows_sys::Win32::Foundation::HANDLE,
        flags: u32,
        reserved: u32,
        bytes_low: u32,
        bytes_high: u32,
        overlapped: *mut WindowsOverlapped,
    ) -> i32;
    fn UnlockFileEx(
        file: windows_sys::Win32::Foundation::HANDLE,
        reserved: u32,
        bytes_low: u32,
        bytes_high: u32,
        overlapped: *mut WindowsOverlapped,
    ) -> i32;
}

#[cfg(windows)]
fn lock_state_root_file(file: fs::File) -> Result<StateRootLock, GuardianError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION, HANDLE};

    let mut overlapped = WindowsOverlapped::default();
    let locked = unsafe {
        LockFileEx(
            file.as_raw_handle() as HANDLE,
            0x0000_0001 | 0x0000_0002,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    };
    if locked != 0 {
        return Ok(StateRootLock { file });
    }

    let error = io::Error::last_os_error();
    if matches!(
        error.raw_os_error(),
        Some(code) if code == ERROR_LOCK_VIOLATION as i32 || code == ERROR_SHARING_VIOLATION as i32
    ) {
        Err(GuardianError::StateRootLocked)
    } else {
        Err(GuardianError::Io(error))
    }
}

#[cfg(windows)]
impl Drop for StateRootLock {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::HANDLE;

        let mut overlapped = WindowsOverlapped::default();
        unsafe {
            let _ = UnlockFileEx(
                self.file.as_raw_handle() as HANDLE,
                0,
                u32::MAX,
                u32::MAX,
                &mut overlapped,
            );
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn lock_state_root_file(_file: fs::File) -> Result<StateRootLock, GuardianError> {
    Err(GuardianError::UnsupportedPlatform(
        "this target has no lifetime-exclusive state-root lock adapter".to_owned(),
    ))
}

#[derive(Debug)]
pub struct Guardian {
    _state_root_lock: StateRootLock,
    root: PathBuf,
    fixture_child: PathBuf,
    capture_limit: usize,
    records: BTreeMap<String, CustodyRecord>,
    request_cache: BTreeMap<String, CachedRequest>,
    live: BTreeMap<String, LiveProcess>,
    #[cfg(all(windows, debug_assertions))]
    windows_containment_fault: Option<WindowsContainmentFaultPoint>,
}

impl Guardian {
    pub fn open(
        root: impl Into<PathBuf>,
        fixture_child: impl Into<PathBuf>,
    ) -> Result<Self, GuardianError> {
        Self::open_with_capture_limit(root, fixture_child, DEFAULT_CAPTURE_LIMIT)
    }

    pub fn open_with_capture_limit(
        root: impl Into<PathBuf>,
        fixture_child: impl Into<PathBuf>,
        capture_limit: usize,
    ) -> Result<Self, GuardianError> {
        Self::open_inner(
            root.into(),
            fixture_child.into(),
            capture_limit,
            #[cfg(all(windows, debug_assertions))]
            None,
        )
    }

    #[cfg(all(windows, debug_assertions))]
    #[doc(hidden)]
    pub fn open_with_windows_containment_fault(
        root: impl Into<PathBuf>,
        fixture_child: impl Into<PathBuf>,
        fault: WindowsContainmentFaultPoint,
    ) -> Result<Self, GuardianError> {
        Self::open_inner(
            root.into(),
            fixture_child.into(),
            DEFAULT_CAPTURE_LIMIT,
            Some(fault),
        )
    }

    fn open_inner(
        root: PathBuf,
        fixture_child: PathBuf,
        capture_limit: usize,
        #[cfg(all(windows, debug_assertions))] windows_containment_fault: Option<
            WindowsContainmentFaultPoint,
        >,
    ) -> Result<Self, GuardianError> {
        let state_root_lock = acquire_state_root_lock(&root)?;
        let custody_root = root.join("custody");
        fs::create_dir_all(&custody_root)?;
        let mut records = BTreeMap::new();
        for entry in fs::read_dir(&custody_root)? {
            let entry = entry?;
            if entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                != Some("json")
            {
                continue;
            }
            let record = serde_json::from_slice::<CustodyRecord>(&fs::read(entry.path())?)
                .map_err(|_| GuardianError::CorruptCustodyEvidence)?;
            if !is_valid_custody_record(&record) {
                return Err(GuardianError::CorruptCustodyEvidence);
            }
            if records
                .insert(record.operation_id.clone(), record)
                .is_some()
            {
                return Err(GuardianError::CorruptCustodyEvidence);
            }
        }
        let mut guardian = Self {
            _state_root_lock: state_root_lock,
            root,
            fixture_child,
            capture_limit,
            records,
            request_cache: BTreeMap::new(),
            live: BTreeMap::new(),
            #[cfg(all(windows, debug_assertions))]
            windows_containment_fault,
        };
        guardian.recover_launching_records()?;
        guardian.rebuild_request_cache()?;
        Ok(guardian)
    }

    fn rebuild_request_cache(&mut self) -> Result<(), GuardianError> {
        self.request_cache.clear();
        for record in self.records.values() {
            let receipts = std::iter::once((
                &record.request_id,
                &record.request_fingerprint,
                GuardianResult::Spawned {
                    observation: record.observation(),
                },
            ))
            .chain(record.fence_advance_receipts.iter().map(|receipt| {
                (
                    &receipt.request_id,
                    &receipt.request_fingerprint,
                    GuardianResult::FenceAdvanced {
                        observation: record.observation(),
                    },
                )
            }));
            for (request_id, fingerprint, result) in receipts {
                if self
                    .request_cache
                    .insert(
                        request_id.clone(),
                        CachedRequest {
                            fingerprint: fingerprint.clone(),
                            result,
                            // A lost response belongs to the old transport. After
                            // restart the caller receives a durable replay receipt.
                            drop_response: false,
                        },
                    )
                    .is_some()
                {
                    return Err(GuardianError::CorruptCustodyEvidence);
                }
            }
        }
        Ok(())
    }

    fn recover_launching_records(&mut self) -> Result<(), GuardianError> {
        let operation_ids = self.records.keys().cloned().collect::<Vec<_>>();
        for operation_id in operation_ids {
            let Some(record) = self.records.get(&operation_id).cloned() else {
                continue;
            };
            if record.state != CustodyState::Launching
                && record.state != CustodyState::LaunchUncertain
            {
                continue;
            }

            let mut recovered = record.clone();
            if let Some(proof) = read_matching_launch_identity(&record)
                && matches!(
                    process_liveness(proof.pid, &proof.birth_identity),
                    ProcessLiveness::VerifiedLive
                )
                && let Ok(process_group_id) = recovered_process_group_id(proof.pid)
            {
                recovered.pid = Some(proof.pid);
                recovered.birth_identity = Some(proof.birth_identity);
                recovered.process_group_id = process_group_id;
                recovered.state = CustodyState::Live;
            } else {
                // We cannot prove the process belongs to this custody record, so
                // the restart never retries or declares it terminal on its own.
                recovered.state = CustodyState::LaunchUncertain;
            }
            self.persist_record(&recovered)?;
            self.records.insert(operation_id, recovered);
        }
        Ok(())
    }

    fn refresh_launch_identity(&mut self, operation_id: &str) -> Result<(), GuardianError> {
        let Some(record) = self.records.get(operation_id).cloned() else {
            return Ok(());
        };
        if record.state != CustodyState::Launching && record.state != CustodyState::LaunchUncertain
        {
            return Ok(());
        }
        let Some(proof) = read_matching_launch_identity(&record) else {
            return Ok(());
        };
        if process_liveness(proof.pid, &proof.birth_identity) != ProcessLiveness::VerifiedLive {
            return Ok(());
        }
        let process_group_id = recovered_process_group_id(proof.pid)?;
        let mut recovered = record;
        recovered.pid = Some(proof.pid);
        recovered.birth_identity = Some(proof.birth_identity);
        recovered.process_group_id = process_group_id;
        recovered.state = CustodyState::Live;
        self.persist_record(&recovered)?;
        self.records.insert(operation_id.to_owned(), recovered);
        Ok(())
    }

    pub fn dispatch(&mut self, request: RequestEnvelope) -> DispatchOutcome {
        if let Err(error) = validate_protocol_version(request.protocol_version) {
            return DispatchOutcome::Respond(GuardianResult::ProtocolRejected {
                code: error.code,
                detail: error.detail.to_owned(),
            });
        }
        let request_fingerprint = sha256_json(&request);
        if let Some(cached) = self.request_cache.get(&request.request_id) {
            return if cached.fingerprint == request_fingerprint {
                if cached.drop_response {
                    DispatchOutcome::DropResponse
                } else {
                    DispatchOutcome::Respond(GuardianResult::Replay {
                        observation: observation_from_result(&cached.result)
                            .unwrap_or_else(|| unknown_observation("replayed_request")),
                    })
                }
            } else {
                DispatchOutcome::Respond(rejected(
                    GuardianErrorCode::RequestConflict,
                    "request ID was replayed with a different semantic payload",
                ))
            };
        }

        let result = self.dispatch_command(&request);
        let drop_response = matches!(
            &request.command,
            GuardianCommand::Spawn {
                drop_response: true,
                ..
            }
        ) && matches!(result, GuardianResult::Spawned { .. });
        self.request_cache.insert(
            request.request_id,
            CachedRequest {
                fingerprint: request_fingerprint,
                result: result.clone(),
                drop_response,
            },
        );
        if drop_response {
            DispatchOutcome::DropResponse
        } else {
            DispatchOutcome::Respond(result)
        }
    }

    pub fn output_snapshot(&self, operation_id: &str) -> Option<StreamSnapshot> {
        let live = self.live.get(operation_id)?;
        let stdout = live.stdout.lock().ok()?;
        let stderr = live.stderr.lock().ok()?;
        Some(StreamSnapshot {
            stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
            stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
            stdout_dropped_bytes: stdout.dropped_bytes,
            stderr_dropped_bytes: stderr.dropped_bytes,
        })
    }

    pub fn custody_record_path(&self, operation_id: &str) -> Result<PathBuf, GuardianError> {
        if !is_safe_operation_id(operation_id) {
            return Err(GuardianError::InvalidOperationId);
        }
        Ok(self
            .root
            .join("custody")
            .join(format!("{operation_id}.json")))
    }

    fn dispatch_command(&mut self, request: &RequestEnvelope) -> GuardianResult {
        match &request.command {
            GuardianCommand::Spawn {
                operation_id,
                opaque_fence,
                fixture_mode,
                ..
            } => self.spawn(
                &request.request_id,
                operation_id,
                opaque_fence,
                fixture_mode,
                sha256_json(request),
            ),
            GuardianCommand::Query { operation_id } => self.query(operation_id),
            GuardianCommand::Terminate {
                operation_id,
                opaque_fence,
            } => self.terminate(operation_id, opaque_fence),
            GuardianCommand::AdvanceFence {
                operation_id,
                current_opaque_fence,
                next_opaque_fence,
            } => self.advance_fence(
                &request.request_id,
                sha256_json(request),
                operation_id,
                current_opaque_fence,
                next_opaque_fence,
            ),
            GuardianCommand::InspectContainment => GuardianResult::Containment {
                report: host_containment_report(),
            },
        }
    }

    fn spawn(
        &mut self,
        request_id: &str,
        operation_id: &str,
        opaque_fence: &str,
        fixture_mode: &str,
        request_fingerprint: String,
    ) -> GuardianResult {
        if !is_safe_operation_id(operation_id) {
            return rejected(
                GuardianErrorCode::Protocol,
                "operation ID is not safe for technical custody storage",
            );
        }
        if fixture_mode != "tree" {
            return rejected(
                GuardianErrorCode::Unsupported,
                "only the disposable tree fixture mode is implemented",
            );
        }

        let fence_digest = sha256_bytes(opaque_fence.as_bytes());
        let operation_fingerprint =
            sha256_bytes(format!("{operation_id}\0{fixture_mode}").as_bytes());
        if let Some(existing) = self.records.get(operation_id) {
            return if existing.fixture_mode != fixture_mode {
                rejected(
                    GuardianErrorCode::OperationConflict,
                    "operation ID already names a different technical process request",
                )
            } else if existing.fence_digest != fence_digest {
                rejected(
                    GuardianErrorCode::StaleFence,
                    "operation ID is bound to a newer technical fence",
                )
            } else {
                GuardianResult::OperationAlreadyExists {
                    observation: existing.observation(),
                }
            };
        }

        let custody_id = unique_identifier("custody");
        let spawn_nonce = unique_identifier("spawn");
        let operation_root = self.root.join("operations").join(operation_id);
        if let Err(error) = fs::create_dir_all(&operation_root) {
            return rejected(GuardianErrorCode::Internal, &error.to_string());
        }
        let mut record = CustodyRecord {
            schema_version: CUSTODY_SCHEMA_VERSION,
            request_id: request_id.to_owned(),
            request_fingerprint,
            operation_id: operation_id.to_owned(),
            operation_fingerprint,
            fence_digest,
            custody_id: custody_id.clone(),
            spawn_nonce: spawn_nonce.clone(),
            pid: None,
            birth_identity: None,
            process_group_id: None,
            identity_path: operation_root.join("identity.json"),
            descendant_pid_path: operation_root.join("descendant.pid"),
            release_descendant_path: operation_root.join("allow-descendant"),
            termination_marker_path: operation_root.join("terminated.marker"),
            fixture_mode: fixture_mode.to_owned(),
            state: CustodyState::Launching,
            containment: host_containment_report(),
            spawn_attempts: 1,
            fence_advance_receipts: Vec::new(),
        };

        if let Err(error) = self.persist_record(&record) {
            return rejected(GuardianErrorCode::Internal, &error.to_string());
        }

        match self.spawn_fixture(&record) {
            Ok(live) => {
                record.pid = Some(live.child.id());
                record.birth_identity = Some(live.birth_identity.clone());
                record.process_group_id = live.containment.process_group_id();
                record.state = CustodyState::Live;
                if let Err(error) = self.persist_record(&record) {
                    // The durable Launching intent already exists. Keep the
                    // stronger in-memory custody evidence before cleanup so a
                    // different request cannot create a duplicate in this Host.
                    self.records.insert(operation_id.to_owned(), record.clone());
                    let detail = match terminate_live_process(live, &record) {
                        Ok(()) => error.to_string(),
                        Err(cleanup_error) => {
                            format!("{error}; post-spawn cleanup failed: {cleanup_error}")
                        }
                    };
                    return rejected(GuardianErrorCode::Internal, &detail);
                }
                self.records.insert(operation_id.to_owned(), record.clone());
                self.live.insert(operation_id.to_owned(), live);
                GuardianResult::Spawned {
                    observation: record.observation(),
                }
            }
            Err(error) => {
                record.state = CustodyState::LaunchUncertain;
                let detail = match self.persist_record(&record) {
                    Ok(()) => error.to_string(),
                    Err(persist_error) => {
                        format!(
                            "{error}; launch uncertainty could not be persisted: {persist_error}"
                        )
                    }
                };
                self.records.insert(operation_id.to_owned(), record);
                rejected(GuardianErrorCode::Internal, &detail)
            }
        }
    }

    fn query(&mut self, operation_id: &str) -> GuardianResult {
        if let Err(error) = self.refresh_launch_identity(operation_id) {
            return rejected(GuardianErrorCode::Internal, &error.to_string());
        }
        let Some(record) = self.records.get(operation_id).cloned() else {
            return GuardianResult::NotFound {
                operation_id: operation_id.to_owned(),
            };
        };
        let reconciliation = self.reconcile_record(&record);
        if reconciliation == Reconciliation::VerifiedLive
            && record.state == CustodyState::Terminated
        {
            let mut repaired = record;
            repaired.state = CustodyState::Live;
            if let Err(error) = self.persist_record(&repaired) {
                return rejected(GuardianErrorCode::Internal, &error.to_string());
            }
            self.records
                .insert(operation_id.to_owned(), repaired.clone());
            return reconciliation_result(&repaired, reconciliation);
        }
        reconciliation_result(&record, reconciliation)
    }

    fn terminate(&mut self, operation_id: &str, opaque_fence: &str) -> GuardianResult {
        if let Err(error) = self.refresh_launch_identity(operation_id) {
            return rejected(GuardianErrorCode::Internal, &error.to_string());
        }
        let Some(record) = self.records.get(operation_id).cloned() else {
            return rejected(
                GuardianErrorCode::OperationNotFound,
                "no custody record exists for operation",
            );
        };
        if record.fence_digest != sha256_bytes(opaque_fence.as_bytes()) {
            return rejected(
                GuardianErrorCode::StaleFence,
                "opaque technical fence does not match custody evidence",
            );
        }

        let termination = if let Some(live) = self.live.remove(operation_id) {
            // A live containment handle/process-group witness can still own
            // descendants after the root process exits.
            terminate_live_process(live, &record)
        } else {
            let reconciliation = self.reconcile_record(&record);
            if reconciliation != Reconciliation::VerifiedLive {
                return reconciliation_result(&record, reconciliation);
            }
            terminate_persisted_process(&record)
        };
        if let Err(error) = termination {
            return rejected(GuardianErrorCode::Internal, &error.to_string());
        }
        if !wait_for_custody_process_gone(&record, Duration::from_secs(1)) {
            return rejected(
                GuardianErrorCode::Internal,
                "termination completed without proving the recorded process identity is gone",
            );
        }
        let mut terminated = record;
        terminated.state = CustodyState::Terminated;
        if let Err(error) = self.persist_record(&terminated) {
            return rejected(GuardianErrorCode::Internal, &error.to_string());
        }
        self.records
            .insert(operation_id.to_owned(), terminated.clone());
        GuardianResult::Terminated {
            observation: terminated.observation(),
        }
    }

    fn advance_fence(
        &mut self,
        request_id: &str,
        request_fingerprint: String,
        operation_id: &str,
        current_opaque_fence: &str,
        next_opaque_fence: &str,
    ) -> GuardianResult {
        if let Err(error) = self.refresh_launch_identity(operation_id) {
            return rejected(GuardianErrorCode::Internal, &error.to_string());
        }
        let Some(record) = self.records.get(operation_id).cloned() else {
            return rejected(
                GuardianErrorCode::OperationNotFound,
                "no custody record exists for operation",
            );
        };
        if record.fence_digest != sha256_bytes(current_opaque_fence.as_bytes()) {
            return rejected(
                GuardianErrorCode::StaleFence,
                "current technical fence does not match custody evidence",
            );
        }

        let reconciliation = self.reconcile_record(&record);
        if reconciliation != Reconciliation::VerifiedLive {
            return reconciliation_result(&record, reconciliation);
        }

        let mut rebound = record;
        rebound.fence_digest = sha256_bytes(next_opaque_fence.as_bytes());
        rebound.fence_advance_receipts.push(FenceAdvanceReceipt {
            request_id: request_id.to_owned(),
            request_fingerprint,
        });
        if let Err(error) = self.persist_record(&rebound) {
            return rejected(GuardianErrorCode::Internal, &error.to_string());
        }
        self.records
            .insert(operation_id.to_owned(), rebound.clone());
        GuardianResult::FenceAdvanced {
            observation: rebound.observation(),
        }
    }

    pub fn reconcile(&self, operation_id: &str) -> GuardianResult {
        let Some(record) = self.records.get(operation_id) else {
            return GuardianResult::NotFound {
                operation_id: operation_id.to_owned(),
            };
        };
        reconciliation_result(record, self.reconcile_record(record))
    }

    fn reconcile_record(&self, record: &CustodyRecord) -> Reconciliation {
        if record.state == CustodyState::Launching || record.state == CustodyState::LaunchUncertain
        {
            return Reconciliation::LaunchUncertain;
        }
        let (Some(pid), Some(birth_identity)) = (record.pid, record.birth_identity.as_ref()) else {
            return Reconciliation::IdentityUnverified;
        };
        match process_liveness(pid, birth_identity) {
            ProcessLiveness::VerifiedLive => match read_matching_live_identity(record) {
                Some(_) => Reconciliation::VerifiedLive,
                None => Reconciliation::IdentityUnverified,
            },
            ProcessLiveness::Gone | ProcessLiveness::IdentityChanged => {
                if record.state == CustodyState::Terminated {
                    Reconciliation::Terminated
                } else if self.live.contains_key(&record.operation_id) {
                    Reconciliation::IdentityUnverified
                } else if tree_exit_is_proven_after_root_loss(record) {
                    Reconciliation::Gone
                } else {
                    Reconciliation::IdentityUnverified
                }
            }
            ProcessLiveness::Unverified => Reconciliation::IdentityUnverified,
        }
    }

    fn spawn_fixture(&self, record: &CustodyRecord) -> Result<LiveProcess, GuardianError> {
        let mut command = Command::new(&self.fixture_child);
        command
            .args([
                "--mode",
                "tree",
                "--identity-path",
                record.identity_path.to_str().ok_or_else(|| {
                    GuardianError::SpawnFailed("identity path is not UTF-8".to_owned())
                })?,
                "--custody-id",
                &record.custody_id,
                "--spawn-nonce",
                &record.spawn_nonce,
                "--descendant-pid-path",
                record.descendant_pid_path.to_str().ok_or_else(|| {
                    GuardianError::SpawnFailed("descendant path is not UTF-8".to_owned())
                })?,
                "--release-descendant-path",
                record.release_descendant_path.to_str().ok_or_else(|| {
                    GuardianError::SpawnFailed("release path is not UTF-8".to_owned())
                })?,
                "--termination-marker-path",
                record.termination_marker_path.to_str().ok_or_else(|| {
                    GuardianError::SpawnFailed("termination marker path is not UTF-8".to_owned())
                })?,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let pre_spawn_report = configure_containment(&mut command)?;
        let mut child = command.spawn().map_err(GuardianError::Io)?;
        let mut containment = None;
        let initialized = (|| -> Result<_, GuardianError> {
            #[cfg(windows)]
            {
                containment = Some(attach_containment(
                    &mut child,
                    pre_spawn_report,
                    record,
                    #[cfg(debug_assertions)]
                    self.windows_containment_fault,
                )?);
            }
            #[cfg(not(windows))]
            {
                containment = Some(attach_containment(&mut child, pre_spawn_report)?);
            }
            let birth_identity = process_birth_identity(child.id())?;
            wait_for_identity(
                &record.identity_path,
                &record.custody_id,
                &record.spawn_nonce,
                child.id(),
                &birth_identity,
            )?;
            fs::write(&record.release_descendant_path, b"release")?;
            let stdout = child.stdout.take().ok_or_else(|| {
                GuardianError::SpawnFailed("child stdout pipe is unavailable".to_owned())
            })?;
            let stderr = child.stderr.take().ok_or_else(|| {
                GuardianError::SpawnFailed("child stderr pipe is unavailable".to_owned())
            })?;
            Ok((birth_identity, stdout, stderr))
        })();

        let (birth_identity, stdout_pipe, stderr_pipe) = match initialized {
            Ok(initialized) => initialized,
            Err(error) => {
                return match cleanup_spawned_process(&mut child, containment, record) {
                    Ok(()) => Err(error),
                    Err(cleanup_error) => Err(GuardianError::SpawnFailed(format!(
                        "{error}; post-spawn cleanup failed: {cleanup_error}"
                    ))),
                };
            }
        };
        let containment = containment.expect("successful initialization attaches containment");
        let stdout = Arc::new(Mutex::new(BoundedCapture::new(self.capture_limit)));
        let stderr = Arc::new(Mutex::new(BoundedCapture::new(self.capture_limit)));
        let stdout_reader = capture_reader(stdout_pipe, Arc::clone(&stdout));
        let stderr_reader = capture_reader(stderr_pipe, Arc::clone(&stderr));
        Ok(LiveProcess {
            child,
            birth_identity,
            stdout,
            stderr,
            readers: vec![stdout_reader, stderr_reader],
            containment,
        })
    }

    fn persist_record(&self, record: &CustodyRecord) -> Result<(), GuardianError> {
        let path = self.custody_record_path(&record.operation_id)?;
        write_json_atomically(&path, record)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reconciliation {
    VerifiedLive,
    Gone,
    IdentityUnverified,
    LaunchUncertain,
    Terminated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessLiveness {
    VerifiedLive,
    Gone,
    IdentityChanged,
    Unverified,
}

impl LiveContainment {
    fn process_group_id(&self) -> Option<i32> {
        match self {
            #[cfg(unix)]
            Self::UnixProcessGroup { process_group_id } => Some(*process_group_id),
            #[cfg(windows)]
            Self::WindowsJobObject(_) => None,
            #[cfg(not(any(unix, windows)))]
            Self::Unsupported => None,
        }
    }
}

fn rejected(code: GuardianErrorCode, detail: &str) -> GuardianResult {
    GuardianResult::Rejected {
        code,
        detail: detail.to_owned(),
    }
}

fn reconciliation_result(record: &CustodyRecord, reconciliation: Reconciliation) -> GuardianResult {
    let mut observation = record.observation();
    match reconciliation {
        Reconciliation::VerifiedLive => {
            // A persisted terminal bit is never authoritative over a live,
            // identity-verified process.
            observation.state = CustodyState::Live;
            GuardianResult::ReconcileVerifiedLive { observation }
        }
        Reconciliation::Gone | Reconciliation::Terminated => {
            GuardianResult::ReconcileGone { observation }
        }
        Reconciliation::IdentityUnverified => {
            GuardianResult::ReconcileIdentityUnverified { observation }
        }
        Reconciliation::LaunchUncertain => GuardianResult::ReconcileLaunchUncertain { observation },
    }
}

fn observation_from_result(result: &GuardianResult) -> Option<CustodyObservation> {
    match result {
        GuardianResult::Spawned { observation }
        | GuardianResult::Replay { observation }
        | GuardianResult::OperationAlreadyExists { observation }
        | GuardianResult::Found { observation }
        | GuardianResult::ReconcileVerifiedLive { observation }
        | GuardianResult::ReconcileGone { observation }
        | GuardianResult::ReconcileIdentityUnverified { observation }
        | GuardianResult::ReconcileLaunchUncertain { observation }
        | GuardianResult::Terminated { observation }
        | GuardianResult::FenceAdvanced { observation } => Some(observation.clone()),
        _ => None,
    }
}

fn is_valid_custody_record(record: &CustodyRecord) -> bool {
    if record.schema_version != CUSTODY_SCHEMA_VERSION
        || !is_safe_operation_id(&record.operation_id)
    {
        return false;
    }
    match record.state {
        CustodyState::Launching => {
            record.pid.is_none()
                && record.birth_identity.is_none()
                && record.process_group_id.is_none()
        }
        CustodyState::Live | CustodyState::Terminated => {
            record.pid.is_some() && record.birth_identity.is_some()
        }
        CustodyState::LaunchUncertain => true,
    }
}

fn read_identity_proof(path: &Path) -> Option<IdentityProof> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<IdentityProof>(&bytes).ok())
}

fn read_matching_launch_identity(record: &CustodyRecord) -> Option<IdentityProof> {
    read_identity_proof(&record.identity_path).filter(|proof| {
        proof.custody_id == record.custody_id && proof.spawn_nonce == record.spawn_nonce
    })
}

fn read_matching_live_identity(record: &CustodyRecord) -> Option<IdentityProof> {
    let pid = record.pid?;
    let birth_identity = record.birth_identity.as_ref()?;
    read_matching_launch_identity(record)
        .filter(|proof| proof.pid == pid && proof.birth_identity == *birth_identity)
}

fn unknown_observation(operation_id: &str) -> CustodyObservation {
    CustodyObservation {
        operation_id: operation_id.to_owned(),
        custody_id: "unavailable".to_owned(),
        pid: None,
        state: CustodyState::LaunchUncertain,
        containment: host_containment_report(),
        spawn_attempts: 0,
    }
}

fn sha256_json<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("fixed protocol values serialize");
    sha256_bytes(&bytes)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn unique_identifier(prefix: &str) -> String {
    let sequence = IDENTIFIER_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}-{nanos}-{sequence}")
}

fn is_safe_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), GuardianError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(GuardianError::Serialize)?;
    replace_file_atomically(path, &bytes).map_err(GuardianError::Io)
}

fn capture_reader(
    mut reader: impl Read + Send + 'static,
    capture: Arc<Mutex<BoundedCapture>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 512];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => return,
                Ok(read) => {
                    if let Ok(mut capture) = capture.lock() {
                        capture.append(&buffer[..read]);
                    } else {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    })
}

fn wait_for_identity(
    path: &Path,
    custody_id: &str,
    spawn_nonce: &str,
    pid: u32,
    birth_identity: &ProcessBirthIdentity,
) -> Result<(), GuardianError> {
    for _ in 0..80 {
        if let Ok(bytes) = fs::read(path)
            && let Ok(proof) = serde_json::from_slice::<IdentityProof>(&bytes)
            && proof.custody_id == custody_id
            && proof.spawn_nonce == spawn_nonce
            && proof.pid == pid
            && proof.birth_identity == *birth_identity
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(10));
    }
    Err(GuardianError::SpawnFailed(
        "fixture did not publish matching custody identity evidence".to_owned(),
    ))
}

/// Returns a target-native process birth value that can be re-read later to
/// distinguish a reused PID from the process originally placed in custody.
pub fn current_process_birth_identity() -> Result<ProcessBirthIdentity, GuardianError> {
    process_birth_identity(std::process::id())
}

fn process_liveness(pid: u32, expected: &ProcessBirthIdentity) -> ProcessLiveness {
    match process_birth_identity(pid) {
        Ok(actual) if actual == *expected => match process_is_alive_for_reconciliation(pid) {
            Ok(true) => ProcessLiveness::VerifiedLive,
            Ok(false) => ProcessLiveness::Gone,
            Err(_) => ProcessLiveness::Unverified,
        },
        Ok(_) => ProcessLiveness::IdentityChanged,
        Err(error) if process_identity_error_means_gone(&error) => ProcessLiveness::Gone,
        Err(_) => ProcessLiveness::Unverified,
    }
}

#[cfg(windows)]
fn process_is_alive_for_reconciliation(pid: u32) -> Result<bool, GuardianError> {
    windows_process_is_alive(pid)
}

#[cfg(not(windows))]
fn process_is_alive_for_reconciliation(pid: u32) -> Result<bool, GuardianError> {
    Ok(process_is_alive(pid))
}

#[cfg(unix)]
fn tree_exit_is_proven_after_root_loss(record: &CustodyRecord) -> bool {
    if !record.termination_marker_path.exists() {
        return false;
    }
    let Ok(descendant_pid) = fs::read_to_string(&record.descendant_pid_path) else {
        return false;
    };
    let Ok(descendant_pid) = descendant_pid.trim().parse::<u32>() else {
        return false;
    };
    !process_is_alive(descendant_pid)
}

#[cfg(windows)]
fn tree_exit_is_proven_after_root_loss(_record: &CustodyRecord) -> bool {
    // Every persisted Live record was attached to a KILL_ON_JOB_CLOSE Job
    // before publication. Once the owning Guardian is gone, handle closure
    // terminates the complete assigned fixture tree.
    true
}

#[cfg(not(any(unix, windows)))]
fn tree_exit_is_proven_after_root_loss(_record: &CustodyRecord) -> bool {
    false
}

#[cfg(unix)]
fn process_identity_error_means_gone(error: &GuardianError) -> bool {
    matches!(
        error,
        GuardianError::Io(error)
            if matches!(error.raw_os_error(), Some(libc::ESRCH) | Some(libc::ENOENT))
    )
}

#[cfg(windows)]
fn process_identity_error_means_gone(error: &GuardianError) -> bool {
    use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;

    matches!(
        error,
        GuardianError::Io(error)
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32)
    )
}

#[cfg(not(any(unix, windows)))]
fn process_identity_error_means_gone(_error: &GuardianError) -> bool {
    false
}

#[cfg(target_os = "linux")]
fn process_birth_identity(pid: u32) -> Result<ProcessBirthIdentity, GuardianError> {
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")?
        .trim()
        .to_owned();
    if boot_id.is_empty() || boot_id.len() > 128 || !boot_id.is_ascii() {
        return Err(GuardianError::SpawnFailed(
            "Linux boot identity is invalid".to_owned(),
        ));
    }
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let closing_parenthesis = stat.rfind(')').ok_or_else(|| {
        GuardianError::SpawnFailed("Linux process stat record has no command terminator".to_owned())
    })?;
    let start_time_ticks = stat[closing_parenthesis + 1..]
        .split_whitespace()
        .nth(19)
        .ok_or_else(|| {
            GuardianError::SpawnFailed(
                "Linux process stat record has no start-time field".to_owned(),
            )
        })?
        .parse::<u64>()
        .map_err(|_| {
            GuardianError::SpawnFailed("Linux process start-time field is invalid".to_owned())
        })?;
    Ok(ProcessBirthIdentity::LinuxProcStartTime {
        boot_id,
        start_time_ticks,
    })
}

#[cfg(target_os = "macos")]
fn process_birth_identity(pid: u32) -> Result<ProcessBirthIdentity, GuardianError> {
    use std::mem::size_of;

    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size_of::<libc::proc_bsdinfo>() as libc::c_int,
        )
    };
    if read != size_of::<libc::proc_bsdinfo>() as libc::c_int {
        return Err(GuardianError::Io(io::Error::last_os_error()));
    }
    Ok(ProcessBirthIdentity::MacosProcStartTime {
        seconds: info.pbi_start_tvsec,
        microseconds: info.pbi_start_tvusec,
    })
}

#[cfg(windows)]
fn process_birth_identity(pid: u32) -> Result<ProcessBirthIdentity, GuardianError> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return Err(GuardianError::Io(io::Error::last_os_error()));
        }
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let read = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        let error = if read == 0 {
            Some(io::Error::last_os_error())
        } else {
            None
        };
        CloseHandle(handle);
        if let Some(error) = error {
            return Err(GuardianError::Io(error));
        }
        Ok(ProcessBirthIdentity::WindowsCreationTime {
            filetime_100ns: u64::from(creation.dwLowDateTime)
                | (u64::from(creation.dwHighDateTime) << 32),
        })
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn process_birth_identity(_pid: u32) -> Result<ProcessBirthIdentity, GuardianError> {
    Err(GuardianError::UnsupportedPlatform(
        "no re-readable OS process birth identity is implemented for this target".to_owned(),
    ))
}

#[cfg(unix)]
fn recovered_process_group_id(pid: u32) -> Result<Option<i32>, GuardianError> {
    let process_group_id = unsafe { libc::getpgid(pid as i32) };
    if process_group_id < 0 {
        return Err(GuardianError::Io(io::Error::last_os_error()));
    }
    if process_group_id != pid as i32 {
        return Err(GuardianError::SpawnFailed(format!(
            "recovered fixture does not retain its dedicated process group: expected {pid}, got {process_group_id}"
        )));
    }
    Ok(Some(process_group_id))
}

#[cfg(windows)]
fn recovered_process_group_id(_pid: u32) -> Result<Option<i32>, GuardianError> {
    Ok(None)
}

#[cfg(not(any(unix, windows)))]
fn recovered_process_group_id(_pid: u32) -> Result<Option<i32>, GuardianError> {
    Err(GuardianError::UnsupportedPlatform(
        "no persistent containment identity is implemented for this target".to_owned(),
    ))
}

#[cfg(unix)]
fn configure_containment(command: &mut Command) -> Result<ContainmentReport, GuardianError> {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    Ok(host_containment_report())
}

#[cfg(windows)]
fn configure_containment(_command: &mut Command) -> Result<ContainmentReport, GuardianError> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

    // std preserves its normal quoting and pipe setup, while this flag makes
    // CreateProcessW return before any fixture code can create descendants.
    _command.creation_flags(CREATE_SUSPENDED);
    Ok(host_containment_report())
}

#[cfg(not(any(unix, windows)))]
fn configure_containment(_command: &mut Command) -> Result<ContainmentReport, GuardianError> {
    Ok(host_containment_report())
}

#[cfg(unix)]
fn attach_containment(
    child: &mut Child,
    _report: ContainmentReport,
) -> Result<LiveContainment, GuardianError> {
    let process_group_id = unsafe { libc::getpgid(child.id() as i32) };
    if process_group_id < 0 {
        return Err(GuardianError::Io(io::Error::last_os_error()));
    }
    if process_group_id != child.id() as i32 {
        return Err(GuardianError::SpawnFailed(format!(
            "fixture did not enter its dedicated process group: expected {}, got {process_group_id}",
            child.id()
        )));
    }
    Ok(LiveContainment::UnixProcessGroup { process_group_id })
}

#[cfg(windows)]
fn attach_containment(
    child: &mut Child,
    _report: ContainmentReport,
    record: &CustodyRecord,
    #[cfg(debug_assertions)] fault: Option<WindowsContainmentFaultPoint>,
) -> Result<LiveContainment, GuardianError> {
    let pid = child.id();
    if let Err(error) = verify_windows_child_is_suspended(child, record) {
        return Err(fail_closed_windows_containment(
            child,
            None,
            record,
            "verify_suspended_before_assignment",
            error,
        ));
    }
    if let Err(error) = inject_windows_containment_fault(
        #[cfg(debug_assertions)]
        fault,
        WindowsContainmentFaultPoint::AfterSuspendedCreate,
    ) {
        return Err(fail_closed_windows_containment(
            child,
            None,
            record,
            "after_suspended_create",
            error,
        ));
    }

    let mut job = match WindowsJobObject::create() {
        Ok(job) => job,
        Err(error) => {
            return Err(fail_closed_windows_containment(
                child,
                None,
                record,
                "create_job_object",
                error,
            ));
        }
    };
    if let Err(error) = append_windows_containment_evidence(
        record,
        pid,
        WindowsContainmentEvidenceStage::JobCreated,
        "KILL_ON_JOB_CLOSE Job Object created while root remains suspended",
    ) {
        return Err(fail_closed_windows_containment(
            child,
            Some(job),
            record,
            "record_job_created",
            error,
        ));
    }
    if let Err(error) = inject_windows_containment_fault(
        #[cfg(debug_assertions)]
        fault,
        WindowsContainmentFaultPoint::AfterJobCreate,
    ) {
        return Err(fail_closed_windows_containment(
            child,
            Some(job),
            record,
            "after_job_create",
            error,
        ));
    }

    if let Err(error) = job.assign(child) {
        return Err(fail_closed_windows_containment(
            child,
            Some(job),
            record,
            "assign_process_to_job",
            error,
        ));
    }
    if let Err(error) = append_windows_containment_evidence(
        record,
        pid,
        WindowsContainmentEvidenceStage::AssignedToJob,
        "suspended root was assigned to KILL_ON_JOB_CLOSE Job Object",
    ) {
        return Err(fail_closed_windows_containment(
            child,
            Some(job),
            record,
            "record_job_assignment",
            error,
        ));
    }
    if let Err(error) = inject_windows_containment_fault(
        #[cfg(debug_assertions)]
        fault,
        WindowsContainmentFaultPoint::AfterJobAssignment,
    ) {
        return Err(fail_closed_windows_containment(
            child,
            Some(job),
            record,
            "after_job_assignment",
            error,
        ));
    }
    if let Err(error) = inject_windows_containment_fault(
        #[cfg(debug_assertions)]
        fault,
        WindowsContainmentFaultPoint::BeforeResume,
    ) {
        return Err(fail_closed_windows_containment(
            child,
            Some(job),
            record,
            "before_resume",
            error,
        ));
    }

    if let Err(error) = resume_suspended_primary_thread(pid) {
        return Err(fail_closed_windows_containment(
            child,
            Some(job),
            record,
            "resume_primary_thread",
            error,
        ));
    }
    if let Err(error) = append_windows_containment_evidence(
        record,
        pid,
        WindowsContainmentEvidenceStage::Resumed,
        "primary thread resumed only after Job Object assignment",
    ) {
        return Err(fail_closed_windows_containment(
            child,
            Some(job),
            record,
            "record_resumed",
            error,
        ));
    }
    if let Err(error) = inject_windows_containment_fault(
        #[cfg(debug_assertions)]
        fault,
        WindowsContainmentFaultPoint::AfterResume,
    ) {
        return Err(fail_closed_windows_containment(
            child,
            Some(job),
            record,
            "after_resume",
            error,
        ));
    }

    Ok(LiveContainment::WindowsJobObject(job))
}

#[cfg(not(any(unix, windows)))]
fn attach_containment(
    _child: &mut Child,
    _report: ContainmentReport,
) -> Result<LiveContainment, GuardianError> {
    Ok(LiveContainment::Unsupported)
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WindowsContainmentEvidenceStage {
    CreatedSuspended,
    JobCreated,
    AssignedToJob,
    Resumed,
    CleanupCompleted,
    CleanupUnverified,
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WindowsContainmentEvidenceEntry {
    stage: WindowsContainmentEvidenceStage,
    identity_path_present: bool,
    descendant_pid_path_present: bool,
    detail: String,
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WindowsContainmentEvidence {
    schema_version: u16,
    custody_id: String,
    process_id: u32,
    entries: Vec<WindowsContainmentEvidenceEntry>,
}

#[cfg(windows)]
fn windows_containment_evidence_path(record: &CustodyRecord) -> Result<PathBuf, GuardianError> {
    let operation_root = record.identity_path.parent().ok_or_else(|| {
        GuardianError::SpawnFailed("fixture identity path has no operation directory".to_owned())
    })?;
    Ok(operation_root.join("windows-containment-evidence.json"))
}

#[cfg(windows)]
fn append_windows_containment_evidence(
    record: &CustodyRecord,
    process_id: u32,
    stage: WindowsContainmentEvidenceStage,
    detail: &str,
) -> Result<(), GuardianError> {
    let path = windows_containment_evidence_path(record)?;
    let mut evidence = match fs::read(&path) {
        Ok(bytes) => {
            serde_json::from_slice::<WindowsContainmentEvidence>(&bytes).map_err(|_| {
                GuardianError::SpawnFailed(
                    "Windows containment evidence is corrupt and cannot be extended".to_owned(),
                )
            })?
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => WindowsContainmentEvidence {
            schema_version: 1,
            custody_id: record.custody_id.clone(),
            process_id,
            entries: Vec::new(),
        },
        Err(error) => return Err(GuardianError::Io(error)),
    };
    if evidence.schema_version != 1
        || evidence.custody_id != record.custody_id
        || evidence.process_id != process_id
    {
        return Err(GuardianError::SpawnFailed(
            "Windows containment evidence does not match the active custody attempt".to_owned(),
        ));
    }
    evidence.entries.push(WindowsContainmentEvidenceEntry {
        stage,
        identity_path_present: record.identity_path.exists(),
        descendant_pid_path_present: record.descendant_pid_path.exists(),
        detail: detail.to_owned(),
    });
    write_json_atomically(&path, &evidence)
}

#[cfg(windows)]
fn verify_windows_child_is_suspended(
    child: &mut Child,
    record: &CustodyRecord,
) -> Result<(), GuardianError> {
    if record.identity_path.exists() || record.descendant_pid_path.exists() {
        return Err(GuardianError::SpawnFailed(
            "a Windows fixture emitted execution evidence before Job Object assignment".to_owned(),
        ));
    }
    if child.try_wait()?.is_some() {
        return Err(GuardianError::SpawnFailed(
            "a Windows fixture exited before Job Object assignment".to_owned(),
        ));
    }
    append_windows_containment_evidence(
        record,
        child.id(),
        WindowsContainmentEvidenceStage::CreatedSuspended,
        "CREATE_SUSPENDED returned before the fixture emitted root or descendant evidence",
    )
}

#[cfg(windows)]
fn inject_windows_containment_fault(
    #[cfg(debug_assertions)] fault: Option<WindowsContainmentFaultPoint>,
    point: WindowsContainmentFaultPoint,
) -> Result<(), GuardianError> {
    #[cfg(debug_assertions)]
    if fault == Some(point) {
        return Err(GuardianError::SpawnFailed(format!(
            "debug test injected Windows containment failure at {point:?}"
        )));
    }
    #[cfg(not(debug_assertions))]
    let _ = point;
    Ok(())
}

#[cfg(windows)]
fn fail_closed_windows_containment(
    child: &mut Child,
    job: Option<WindowsJobObject>,
    record: &CustodyRecord,
    stage: &str,
    cause: GuardianError,
) -> GuardianError {
    let (cleanup_verified, cleanup_detail) = match job {
        Some(job) => close_windows_job_and_verify(child, job),
        None => match kill_windows_child_only(child) {
            Ok(()) => (true, "suspended root exit was verified".to_owned()),
            Err(error) => (
                false,
                format!("suspended root exit was unverified: {error}"),
            ),
        },
    };

    let evidence_stage = if cleanup_verified {
        WindowsContainmentEvidenceStage::CleanupCompleted
    } else {
        WindowsContainmentEvidenceStage::CleanupUnverified
    };
    let evidence_detail = format!("stage={stage}; cause={cause}; {cleanup_detail}");
    let evidence_write =
        append_windows_containment_evidence(record, child.id(), evidence_stage, &evidence_detail);
    let evidence_suffix = match evidence_write {
        Ok(()) => String::new(),
        Err(error) => format!("; containment evidence write also failed: {error}"),
    };

    GuardianError::SpawnFailed(format!(
        "Windows containment failed at {stage}: {cause}; {cleanup_detail}{evidence_suffix}"
    ))
}

#[cfg(windows)]
fn close_windows_job_and_verify(child: &mut Child, mut job: WindowsJobObject) -> (bool, String) {
    let termination_error = job.terminate().err();
    let termination_succeeded = termination_error.is_none();
    // Successful TerminateJobObject is not enough on its own. Keep the handle
    // open and observe the Job's authoritative active-membership accounting
    // before claiming that a tree has exited. A missing fixture PID file is
    // deliberately not evidence of a terminated descendant.
    let accounting_error = if termination_error.is_none() {
        job.wait_for_empty(Duration::from_secs(1)).err()
    } else {
        None
    };

    // A failure can happen after the Job Object exists but before the root is
    // assigned to it. In that state an empty Job proves nothing about the
    // suspended root, so always use direct root termination as the final
    // fallback. If assignment did succeed, this direct call is benign.
    let root_cleanup_error = kill_windows_child_only(child).err();
    let child_exit_error = wait_for_child_exit(child).err();

    // KILL_ON_JOB_CLOSE remains the final containment action when the primary
    // operation or verification failed. It cannot be independently observed
    // after the last handle is closed, therefore it is intentionally not a
    // success condition.
    drop(job);

    let cleanup_verified =
        termination_succeeded && accounting_error.is_none() && child_exit_error.is_none();

    let mut details = Vec::new();
    match termination_error.as_ref() {
        Some(error) => details.push(format!(
            "TerminateJobObject failed: {error}; KILL_ON_JOB_CLOSE ran only as an unverified fail-closed fallback"
        )),
        None => details.push("TerminateJobObject succeeded".to_owned()),
    }
    match accounting_error {
        Some(error) => details.push(format!(
            "Job Object active-membership accounting did not prove an empty tree: {error}"
        )),
        None if termination_succeeded => {
            details.push("Job Object accounting observed zero active processes".to_owned())
        }
        None => {}
    }
    match child_exit_error {
        Some(error) => details.push(format!(
            "root child exit remained unverified after cleanup: {error}"
        )),
        None => details.push("root child exit was observed".to_owned()),
    }
    if let Some(error) = root_cleanup_error {
        details.push(format!(
            "direct root fallback reported: {error}; Job Object accounting remains the tree proof"
        ));
    }

    (cleanup_verified, details.join("; "))
}

#[cfg(windows)]
fn resume_suspended_primary_thread(process_id: u32) -> Result<(), GuardianError> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(GuardianError::Io(io::Error::last_os_error()));
        }

        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut thread_id = None;
        if Thread32First(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32OwnerProcessID == process_id
                    && thread_id.replace(entry.th32ThreadID).is_some()
                {
                    CloseHandle(snapshot);
                    return Err(GuardianError::SpawnFailed(
                        "suspended Windows fixture exposed more than one thread before resume"
                            .to_owned(),
                    ));
                }
                entry.dwSize = size_of::<THREADENTRY32>() as u32;
                if Thread32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);

        let thread_id = thread_id.ok_or_else(|| {
            GuardianError::SpawnFailed(
                "suspended Windows fixture primary thread was not discoverable".to_owned(),
            )
        })?;
        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id);
        if thread.is_null() {
            return Err(GuardianError::Io(io::Error::last_os_error()));
        }
        let previous_suspend_count = ResumeThread(thread);
        let resume_error = if previous_suspend_count == u32::MAX {
            Some(GuardianError::Io(io::Error::last_os_error()))
        } else if previous_suspend_count != 1 {
            Some(GuardianError::SpawnFailed(format!(
                "suspended Windows fixture primary thread had unexpected suspend count {previous_suspend_count}"
            )))
        } else {
            None
        };
        CloseHandle(thread);
        if let Some(error) = resume_error {
            return Err(error);
        }
    }
    Ok(())
}

fn host_containment_report() -> ContainmentReport {
    #[cfg(unix)]
    {
        return ContainmentReport {
            mechanism: ContainmentMechanism::UnixProcessGroup,
            qualified_for_bounded_fixture: true,
            limitation: Some(
                "POSIX process groups do not contain a descendant that deliberately calls setsid. Linux and macOS custody also require a readable OS birth-time value; either capability failure fails closed.".to_owned(),
            ),
        };
    }
    #[cfg(windows)]
    {
        return ContainmentReport {
            mechanism: ContainmentMechanism::WindowsJobObject,
            qualified_for_bounded_fixture: true,
            limitation: Some(
                "The spike creates the disposable fixture suspended, assigns it to a KILL_ON_JOB_CLOSE Job Object, and resumes it only after assignment. A restarted Guardian cannot recover a closed Job Object handle.".to_owned(),
            ),
        };
    }
    #[allow(unreachable_code)]
    ContainmentReport {
        mechanism: ContainmentMechanism::Unsupported,
        qualified_for_bounded_fixture: false,
        limitation: Some(
            "No supported process containment adapter is compiled for this target.".to_owned(),
        ),
    }
}

fn cleanup_spawned_process(
    child: &mut Child,
    containment: Option<LiveContainment>,
    _record: &CustodyRecord,
) -> Result<(), GuardianError> {
    #[cfg(unix)]
    {
        match containment {
            Some(LiveContainment::UnixProcessGroup { process_group_id }) => {
                let signal_result = signal_unix_process_group(
                    process_group_id,
                    libc::SIGKILL,
                    "post-spawn SIGKILL",
                );
                let exit_result = if signal_result.is_ok() {
                    if wait_for_live_tree_exit(child, _record, Duration::from_secs(1))? {
                        Ok(())
                    } else {
                        Err(GuardianError::SpawnFailed(
                            "post-spawn cleanup did not prove the fixture tree exited".to_owned(),
                        ))
                    }
                } else {
                    kill_child_only(child)
                };
                signal_result.and(exit_result)
            }
            None => kill_child_only(child),
        }
    }

    #[cfg(windows)]
    {
        match containment {
            Some(LiveContainment::WindowsJobObject(job)) => {
                let (verified, detail) = close_windows_job_and_verify(child, job);
                let evidence_stage = if verified {
                    WindowsContainmentEvidenceStage::CleanupCompleted
                } else {
                    WindowsContainmentEvidenceStage::CleanupUnverified
                };
                let evidence = append_windows_containment_evidence(
                    _record,
                    child.id(),
                    evidence_stage,
                    &format!("post-spawn initialization cleanup: {detail}"),
                );
                match (verified, evidence) {
                    (true, Ok(())) => Ok(()),
                    (true, Err(error)) => Err(GuardianError::SpawnFailed(format!(
                        "post-spawn cleanup succeeded but containment evidence write failed: {error}"
                    ))),
                    (false, Ok(())) => Err(GuardianError::SpawnFailed(detail)),
                    (false, Err(error)) => Err(GuardianError::SpawnFailed(format!(
                        "{detail}; containment evidence write also failed: {error}"
                    ))),
                }
            }
            None => kill_windows_child_only(child),
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = containment;
        let _ = _record;
        kill_child_only(child)
    }
}

#[cfg(not(windows))]
fn kill_child_only(child: &mut Child) -> Result<(), GuardianError> {
    if child.try_wait()?.is_none() {
        child.kill()?;
        let _ = child.wait()?;
    }
    Ok(())
}

#[cfg(windows)]
fn wait_for_child_exit(child: &mut Child) -> Result<(), GuardianError> {
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    loop {
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(GuardianError::SpawnFailed(
                "Windows child process did not exit within the bounded cleanup timeout".to_owned(),
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(windows)]
fn kill_windows_child_only(child: &mut Child) -> Result<(), GuardianError> {
    if child.try_wait()?.is_none() {
        child.kill()?;
        wait_for_child_exit(child)?;
    }
    Ok(())
}

#[cfg(unix)]
fn terminate_live_process(
    mut live: LiveProcess,
    record: &CustodyRecord,
) -> Result<(), GuardianError> {
    let LiveContainment::UnixProcessGroup { process_group_id } = live.containment;
    signal_unix_process_group(process_group_id, libc::SIGTERM, "SIGTERM")?;
    if !wait_for_live_tree_exit(&mut live.child, record, Duration::from_millis(250))? {
        signal_unix_process_group(process_group_id, libc::SIGKILL, "SIGKILL")?;
        if !wait_for_live_tree_exit(&mut live.child, record, Duration::from_secs(1))? {
            return Err(GuardianError::SpawnFailed(
                "fixture process tree remained alive after SIGKILL".to_owned(),
            ));
        }
    }
    let _ = live.child.wait();
    for reader in live.readers.drain(..) {
        let _ = reader.join();
    }
    Ok(())
}

#[cfg(windows)]
fn terminate_live_process(
    mut live: LiveProcess,
    _record: &CustodyRecord,
) -> Result<(), GuardianError> {
    let LiveContainment::WindowsJobObject(job) = live.containment;
    let (verified, detail) = close_windows_job_and_verify(&mut live.child, job);
    if !verified {
        return Err(GuardianError::SpawnFailed(format!(
            "Windows live-process termination could not be verified: {detail}"
        )));
    }
    for reader in live.readers.drain(..) {
        let _ = reader.join();
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn terminate_live_process(
    mut live: LiveProcess,
    _record: &CustodyRecord,
) -> Result<(), GuardianError> {
    live.child.kill()?;
    let _ = live.child.wait();
    Ok(())
}

#[cfg(unix)]
fn terminate_persisted_process(record: &CustodyRecord) -> Result<(), GuardianError> {
    match record.process_group_id {
        Some(process_group_id) => {
            signal_unix_process_group(process_group_id, libc::SIGTERM, "SIGTERM")?;
            if !wait_for_persisted_tree_exit(record, Duration::from_secs(1)) {
                match record_liveness(record) {
                    ProcessLiveness::Gone | ProcessLiveness::IdentityChanged => return Ok(()),
                    ProcessLiveness::Unverified => {
                        return Err(GuardianError::SpawnFailed(
                            "persisted fixture liveness could not be re-verified before SIGKILL"
                                .to_owned(),
                        ));
                    }
                    ProcessLiveness::VerifiedLive => {}
                }
                signal_unix_process_group(process_group_id, libc::SIGKILL, "SIGKILL")?;
                if !wait_for_persisted_tree_exit(record, Duration::from_secs(1)) {
                    return Err(GuardianError::SpawnFailed(
                        "persisted fixture process tree remained alive after SIGKILL".to_owned(),
                    ));
                }
            }
            Ok(())
        }
        None => Err(GuardianError::SpawnFailed(
            "persisted Unix custody record has no process group ID".to_owned(),
        )),
    }
}

#[cfg(windows)]
fn terminate_persisted_process(_record: &CustodyRecord) -> Result<(), GuardianError> {
    Err(GuardianError::SpawnFailed(
        "a restarted Guardian has no Job Object handle; Windows job closure is expected to have already reaped the fixture".to_owned(),
    ))
}

#[cfg(not(any(unix, windows)))]
fn terminate_persisted_process(_record: &CustodyRecord) -> Result<(), GuardianError> {
    Err(GuardianError::SpawnFailed(
        "no persisted containment adapter exists for this platform".to_owned(),
    ))
}

#[cfg(unix)]
fn signal_unix_process_group(
    process_group_id: i32,
    signal: i32,
    signal_name: &str,
) -> Result<(), GuardianError> {
    unsafe {
        if libc::kill(-process_group_id, signal) != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(GuardianError::SpawnFailed(format!(
                    "{signal_name} for process group {process_group_id} failed: {error}"
                )));
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn descendant_pid(record: &CustodyRecord) -> Option<u32> {
    fs::read_to_string(&record.descendant_pid_path)
        .ok()?
        .trim()
        .parse::<u32>()
        .ok()
}

#[cfg(unix)]
fn wait_for_live_tree_exit(
    child: &mut Child,
    record: &CustodyRecord,
    timeout: Duration,
) -> Result<bool, GuardianError> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let parent_exited = child.try_wait()?.is_some();
        let descendant_alive = descendant_pid(record).is_some_and(process_is_alive);
        if parent_exited && !descendant_alive {
            return Ok(true);
        }
        if std::time::Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn wait_for_persisted_tree_exit(record: &CustodyRecord, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let parent_terminated = custody_process_is_gone(record);
        let descendant_alive = descendant_pid(record).is_some_and(process_is_alive);
        if parent_terminated && !descendant_alive {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn custody_process_is_gone(record: &CustodyRecord) -> bool {
    matches!(
        record_liveness(record),
        ProcessLiveness::Gone | ProcessLiveness::IdentityChanged
    )
}

fn wait_for_custody_process_gone(record: &CustodyRecord, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if custody_process_is_gone(record) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn record_liveness(record: &CustodyRecord) -> ProcessLiveness {
    let (Some(pid), Some(birth_identity)) = (record.pid, record.birth_identity.as_ref()) else {
        return ProcessLiveness::Unverified;
    };
    process_liveness(pid, birth_identity)
}

#[cfg(target_os = "linux")]
fn process_is_alive(pid: u32) -> bool {
    unsafe {
        if libc::kill(pid as i32, 0) == 0 {
            !matches!(linux_process_state(pid), Some('Z'))
        } else {
            io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_process_state(pid: u32) -> Option<char> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let closing_parenthesis = stat.rfind(')')?;
    stat[closing_parenthesis + 1..]
        .split_whitespace()
        .next()?
        .chars()
        .next()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_is_alive(pid: u32) -> bool {
    unsafe {
        if libc::kill(pid as i32, 0) == 0 {
            true
        } else {
            io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }
}

#[cfg(windows)]
fn windows_process_is_alive(pid: u32) -> Result<bool, GuardianError> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_FAILED};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        );
        if handle.is_null() {
            let error = io::Error::last_os_error();
            if windows_open_process_error_means_gone(&error) {
                return Ok(false);
            }
            return Err(GuardianError::Io(error));
        }
        let wait_result = WaitForSingleObject(handle, 0);
        let queried_state = if wait_result != WAIT_FAILED {
            Ok(wait_result)
        } else {
            Err(io::Error::last_os_error())
        };
        CloseHandle(handle);
        windows_wait_state_means_active(queried_state)
    }
}

#[cfg(windows)]
fn windows_open_process_error_means_gone(error: &io::Error) -> bool {
    use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;

    error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32)
}

#[cfg(windows)]
fn windows_wait_state_means_active(
    wait_state: Result<u32, io::Error>,
) -> Result<bool, GuardianError> {
    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};

    match wait_state.map_err(GuardianError::Io)? {
        WAIT_TIMEOUT => Ok(true),
        WAIT_OBJECT_0 => Ok(false),
        value => Err(GuardianError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("WaitForSingleObject returned unexpected process state {value}"),
        ))),
    }
}

#[cfg(not(any(unix, windows)))]
fn process_is_alive(_pid: u32) -> bool {
    false
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsJobObject {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl WindowsJobObject {
    fn create() -> Result<Self, GuardianError> {
        use std::mem::size_of;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(GuardianError::Io(io::Error::last_os_error()));
            }
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                let error = io::Error::last_os_error();
                CloseHandle(handle);
                return Err(GuardianError::Io(error));
            }
            Ok(Self { handle })
        }
    }

    fn assign(&mut self, child: &Child) -> Result<(), GuardianError> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        unsafe {
            let process = child.as_raw_handle() as HANDLE;
            if AssignProcessToJobObject(self.handle, process) == 0 {
                return Err(GuardianError::Io(io::Error::last_os_error()));
            }
        }
        Ok(())
    }

    fn terminate(&mut self) -> Result<(), GuardianError> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            if TerminateJobObject(self.handle, 1) == 0 {
                return Err(GuardianError::Io(io::Error::last_os_error()));
            }
        }
        Ok(())
    }

    fn active_process_count(&self) -> Result<u32, GuardianError> {
        use std::mem::size_of;
        use windows_sys::Win32::System::JobObjects::{
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectBasicAccountingInformation,
            QueryInformationJobObject,
        };

        unsafe {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            if QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut _,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(GuardianError::Io(io::Error::last_os_error()));
            }
            Ok(accounting.ActiveProcesses)
        }
    }

    fn wait_for_empty(&self, timeout: Duration) -> Result<(), GuardianError> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let active_processes = self.active_process_count()?;
            if active_processes == 0 {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(GuardianError::SpawnFailed(format!(
                    "Job Object still has {active_processes} active process(es) after bounded cleanup"
                )));
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJobObject {
    fn drop(&mut self) {
        unsafe {
            let _ = windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custody_evidence_replacement_overwrites_existing_state_file_repeatedly() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let path = temporary.path().join("custody.json");
        for value in 0..32 {
            write_json_atomically(&path, &serde_json::json!({ "value": value }))
                .expect("custody state replacement succeeds");
            let persisted: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).expect("custody state reads"))
                    .expect("custody state parses");
            assert_eq!(persisted["value"], value);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_process_query_errors_are_not_treated_as_process_exit() {
        use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER};
        use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};

        assert!(windows_wait_state_means_active(Ok(WAIT_TIMEOUT)).expect("timeout means live"));
        assert!(
            !windows_wait_state_means_active(Ok(WAIT_OBJECT_0)).expect("signaled means exited")
        );

        let access_denied = io::Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32);
        assert!(
            !windows_open_process_error_means_gone(&access_denied),
            "ACCESS_DENIED must remain an unverified process-query outcome"
        );
        assert!(
            windows_wait_state_means_active(Err(access_denied)).is_err(),
            "WaitForSingleObject failures must remain unverified"
        );
        let missing_process = io::Error::from_raw_os_error(ERROR_INVALID_PARAMETER as i32);
        assert!(
            windows_open_process_error_means_gone(&missing_process),
            "only OpenProcess(ERROR_INVALID_PARAMETER) is a verified missing PID"
        );
    }
}
