use boundary_protocol::{
    CURRENT_PROTOCOL_VERSION, GuardianCommand, RequestEnvelope, ResponseEnvelope,
};
#[cfg(all(windows, debug_assertions))]
use execution_guardian::WindowsContainmentFaultPoint;
use execution_guardian::{
    ContainmentMechanism, DispatchOutcome, Guardian, GuardianErrorCode, GuardianResult,
};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

fn fixture_child() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fixture-child"))
}

fn spawn_request(
    request_id: &str,
    operation_id: &str,
    fence: &str,
    drop_response: bool,
) -> RequestEnvelope {
    RequestEnvelope {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        request_id: request_id.to_owned(),
        command: GuardianCommand::Spawn {
            operation_id: operation_id.to_owned(),
            opaque_fence: fence.to_owned(),
            fixture_mode: "tree".to_owned(),
            drop_response,
        },
    }
}

fn terminate_request(request_id: &str, operation_id: &str, fence: &str) -> RequestEnvelope {
    RequestEnvelope {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        request_id: request_id.to_owned(),
        command: GuardianCommand::Terminate {
            operation_id: operation_id.to_owned(),
            opaque_fence: fence.to_owned(),
        },
    }
}

fn advance_fence_request(
    request_id: &str,
    operation_id: &str,
    current_fence: &str,
    next_fence: &str,
) -> RequestEnvelope {
    RequestEnvelope {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        request_id: request_id.to_owned(),
        command: GuardianCommand::AdvanceFence {
            operation_id: operation_id.to_owned(),
            current_opaque_fence: current_fence.to_owned(),
            next_opaque_fence: next_fence.to_owned(),
        },
    }
}

fn assert_result(outcome: DispatchOutcome) -> GuardianResult {
    match outcome {
        DispatchOutcome::Respond(result) => result,
        DispatchOutcome::DropResponse => panic!("the fixture unexpectedly dropped its response"),
    }
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

#[cfg(unix)]
fn process_is_dead(pid: u32) -> bool {
    unsafe {
        libc::kill(pid as i32, 0) != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
}

#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct ObservedProcessIdentity {
    platform_boot: String,
    started_at: u64,
    started_at_subsecond: u64,
}

#[cfg(target_os = "linux")]
fn observed_process_identity(pid: u32) -> Option<ObservedProcessIdentity> {
    let platform_boot = fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .ok()?
        .trim()
        .to_owned();
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let closing_parenthesis = stat.rfind(')')?;
    let started_at = stat[closing_parenthesis + 1..]
        .split_whitespace()
        .nth(19)?
        .parse::<u64>()
        .ok()?;
    Some(ObservedProcessIdentity {
        platform_boot,
        started_at,
        started_at_subsecond: 0,
    })
}

#[cfg(target_os = "macos")]
fn observed_process_identity(pid: u32) -> Option<ObservedProcessIdentity> {
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
        return None;
    }
    Some(ObservedProcessIdentity {
        platform_boot: "macos-boot-session".to_owned(),
        started_at: info.pbi_start_tvsec,
        started_at_subsecond: info.pbi_start_tvusec,
    })
}

#[cfg(unix)]
fn identity_stalling_fixture(root: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let fixture = root.join("identity-stalling-fixture.sh");
    fs::write(
        &fixture,
        r#"#!/bin/sh
identity_path=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--identity-path" ]; then
    identity_path="$2"
    shift 2
  else
    shift
  fi
done
echo "$$" > "$(dirname "$identity_path")/stalled.pid"
while :; do sleep 1; done
"#,
    )
    .expect("fixture script writes");
    fs::set_permissions(&fixture, fs::Permissions::from_mode(0o755))
        .expect("fixture script is executable");
    fixture
}

#[cfg(target_os = "linux")]
fn mismatched_birth_identity() -> serde_json::Value {
    serde_json::json!({
        "kind": "linux_proc_start_time",
        "boot_id": "00000000-0000-0000-0000-000000000000",
        "start_time_ticks": 0,
    })
}

#[cfg(target_os = "macos")]
fn mismatched_birth_identity() -> serde_json::Value {
    serde_json::json!({
        "kind": "macos_proc_start_time",
        "seconds": 0,
        "microseconds": 0,
    })
}

#[cfg(windows)]
fn process_is_dead(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
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
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                return true;
            }
            panic!("cannot verify whether Windows process {pid} exited: {error}");
        }
        let wait_result = WaitForSingleObject(handle, 0);
        let error = (wait_result == WAIT_FAILED).then(std::io::Error::last_os_error);
        CloseHandle(handle);
        if let Some(error) = error {
            panic!("cannot verify whether Windows process {pid} exited: {error}");
        }
        match wait_result {
            WAIT_OBJECT_0 => true,
            WAIT_TIMEOUT => false,
            value => panic!("unexpected Windows process wait result: {value}"),
        }
    }
}

#[cfg(windows)]
fn windows_containment_evidence(root: &Path, operation_id: &str) -> serde_json::Value {
    let path = root
        .join("operations")
        .join(operation_id)
        .join("windows-containment-evidence.json");
    serde_json::from_slice(&fs::read(path).expect("Windows containment evidence reads"))
        .expect("Windows containment evidence parses")
}

#[cfg(windows)]
fn evidence_stages(evidence: &serde_json::Value) -> Vec<&str> {
    evidence["entries"]
        .as_array()
        .expect("evidence entries")
        .iter()
        .map(|entry| entry["stage"].as_str().expect("evidence stage"))
        .collect()
}

#[test]
fn fixture_tree_streams_bounded_output_and_full_tree_terminates() {
    let temp = TempDir::new().expect("temporary root");
    let mut guardian = Guardian::open_with_capture_limit(temp.path(), fixture_child(), 96)
        .expect("guardian opens");
    let result =
        assert_result(guardian.dispatch(spawn_request("spawn-1", "tree-1", "fence-1", false)));
    let observation = match result {
        GuardianResult::Spawned { observation } => observation,
        other => panic!("unexpected spawn result: {other:?}"),
    };
    let descendant_pid_path = temp.path().join("operations/tree-1/descendant.pid");
    wait_until(Duration::from_secs(2), || descendant_pid_path.exists());
    let descendant_pid = fs::read_to_string(descendant_pid_path)
        .expect("descendant PID file")
        .trim()
        .parse::<u32>()
        .expect("numeric descendant PID");
    wait_until(Duration::from_secs(2), || {
        guardian.output_snapshot("tree-1").is_some_and(|snapshot| {
            snapshot.stdout_dropped_bytes > 0 && snapshot.stderr_dropped_bytes > 0
        })
    });
    let streams = guardian.output_snapshot("tree-1").expect("stream snapshot");
    assert!(streams.stdout.contains("fixture stdout"));
    assert!(streams.stderr.contains("fixture stderr"));
    assert!(streams.stdout.len() <= 96);
    assert!(streams.stderr.len() <= 96);

    let terminated =
        assert_result(guardian.dispatch(terminate_request("terminate-1", "tree-1", "fence-1")));
    assert!(
        matches!(terminated, GuardianResult::Terminated { .. }),
        "unexpected termination result: {terminated:?}"
    );
    #[cfg(any(unix, windows))]
    {
        let parent_pid = observation.pid.expect("live fixture PID");
        wait_until(Duration::from_secs(2), || process_is_dead(parent_pid));
        wait_until(Duration::from_secs(2), || process_is_dead(descendant_pid));
    }
}

#[cfg(windows)]
#[test]
fn suspended_job_assignment_precedes_immediate_descendant_creation() {
    let temp = TempDir::new().expect("temporary root");
    let mut guardian = Guardian::open(temp.path(), fixture_child()).expect("guardian opens");
    let spawned = assert_result(guardian.dispatch(spawn_request(
        "spawn-suspended-job",
        "suspended-job-1",
        "fence-suspended-job",
        false,
    )));
    let root_pid = match spawned {
        GuardianResult::Spawned { observation } => observation.pid.expect("fixture root PID"),
        other => panic!("unexpected spawn result: {other:?}"),
    };
    let descendant_path = temp
        .path()
        .join("operations/suspended-job-1/descendant.pid");
    wait_until(Duration::from_secs(2), || descendant_path.exists());
    let descendant_pid = fs::read_to_string(&descendant_path)
        .expect("descendant PID reads")
        .trim()
        .parse::<u32>()
        .expect("numeric descendant PID");

    let evidence = windows_containment_evidence(temp.path(), "suspended-job-1");
    let entries = evidence["entries"].as_array().expect("evidence entries");
    let suspended = entries
        .iter()
        .find(|entry| entry["stage"] == "created_suspended")
        .expect("suspended-create evidence");
    assert_eq!(suspended["identity_path_present"], false);
    assert_eq!(suspended["descendant_pid_path_present"], false);
    assert_eq!(
        evidence_stages(&evidence),
        vec![
            "created_suspended",
            "job_created",
            "assigned_to_job",
            "resumed"
        ]
    );

    drop(guardian);
    wait_until(Duration::from_secs(2), || process_is_dead(root_pid));
    wait_until(Duration::from_secs(2), || process_is_dead(descendant_pid));
}

#[cfg(windows)]
#[test]
fn job_accounting_proves_cleanup_when_descendant_pid_evidence_is_missing() {
    let temp = TempDir::new().expect("temporary root");
    let mut guardian = Guardian::open(temp.path(), fixture_child()).expect("guardian opens");
    let spawned = assert_result(guardian.dispatch(spawn_request(
        "spawn-job-accounting",
        "job-accounting-1",
        "fence-job-accounting",
        false,
    )));
    let root_pid = match spawned {
        GuardianResult::Spawned { observation } => observation.pid.expect("fixture root PID"),
        other => panic!("unexpected spawn result: {other:?}"),
    };
    let descendant_path = temp
        .path()
        .join("operations/job-accounting-1/descendant.pid");
    wait_until(Duration::from_secs(2), || descendant_path.exists());
    let descendant_pid = fs::read_to_string(&descendant_path)
        .expect("descendant PID reads")
        .trim()
        .parse::<u32>()
        .expect("numeric descendant PID");
    fs::remove_file(&descendant_path).expect("test removes non-authoritative descendant evidence");

    let terminated = assert_result(guardian.dispatch(terminate_request(
        "terminate-job-accounting",
        "job-accounting-1",
        "fence-job-accounting",
    )));
    assert!(
        matches!(terminated, GuardianResult::Terminated { .. }),
        "Job Object accounting must prove the complete tree without a PID-file shortcut: {terminated:?}"
    );
    wait_until(Duration::from_secs(2), || process_is_dead(root_pid));
    wait_until(Duration::from_secs(2), || process_is_dead(descendant_pid));
}

#[cfg(all(windows, debug_assertions))]
#[test]
fn partial_windows_containment_failures_kill_the_fixture_and_record_cleanup_evidence() {
    let cases = [
        (
            "after-suspended-create",
            WindowsContainmentFaultPoint::AfterSuspendedCreate,
            false,
        ),
        (
            "after-job-create",
            WindowsContainmentFaultPoint::AfterJobCreate,
            false,
        ),
        (
            "after-job-assignment",
            WindowsContainmentFaultPoint::AfterJobAssignment,
            false,
        ),
        (
            "before-resume",
            WindowsContainmentFaultPoint::BeforeResume,
            false,
        ),
        (
            "after-resume",
            WindowsContainmentFaultPoint::AfterResume,
            true,
        ),
    ];

    for (operation_id, fault, may_create_descendant) in cases {
        let temp = TempDir::new().expect("temporary root");
        let mut guardian =
            Guardian::open_with_windows_containment_fault(temp.path(), fixture_child(), fault)
                .expect("Guardian opens");
        let result = assert_result(guardian.dispatch(spawn_request(
            &format!("spawn-{operation_id}"),
            operation_id,
            "fault-fence",
            false,
        )));
        assert!(
            matches!(
                result,
                GuardianResult::Rejected {
                    code: GuardianErrorCode::Internal,
                    ..
                }
            ),
            "fault point {fault:?} must reject the start after cleanup: {result:?}"
        );

        let evidence = windows_containment_evidence(temp.path(), operation_id);
        let root_pid = evidence["process_id"]
            .as_u64()
            .expect("root PID in evidence") as u32;
        let stages = evidence_stages(&evidence);
        assert_eq!(
            stages.first(),
            Some(&"created_suspended"),
            "fault point {fault:?} ({operation_id}) wrote unexpected evidence: {evidence:#}"
        );
        assert_eq!(
            stages.last(),
            Some(&"cleanup_completed"),
            "fault point {fault:?} ({operation_id}) left cleanup unverified: {evidence:#}"
        );
        wait_until(Duration::from_secs(2), || process_is_dead(root_pid));

        let descendant_path = temp
            .path()
            .join("operations")
            .join(operation_id)
            .join("descendant.pid");
        if !may_create_descendant {
            assert!(
                !descendant_path.exists(),
                "a fixture cannot create a descendant before the suspended root is resumed"
            );
            continue;
        }
        if descendant_path.exists() {
            let descendant_pid = fs::read_to_string(descendant_path)
                .expect("descendant PID reads")
                .trim()
                .parse::<u32>()
                .expect("numeric descendant PID");
            wait_until(Duration::from_secs(2), || process_is_dead(descendant_pid));
        }
    }
}

#[cfg(unix)]
#[test]
fn live_containment_terminates_descendants_after_the_root_crashes() {
    let temp = TempDir::new().expect("temporary root");
    let mut guardian = Guardian::open(temp.path(), fixture_child()).expect("guardian opens");
    let spawned = assert_result(guardian.dispatch(spawn_request(
        "spawn-root-crash",
        "root-crash-1",
        "fence-root-crash",
        false,
    )));
    let root_pid = match spawned {
        GuardianResult::Spawned { observation } => observation.pid.expect("fixture root PID"),
        other => panic!("unexpected spawn result: {other:?}"),
    };
    let descendant_path = temp.path().join("operations/root-crash-1/descendant.pid");
    wait_until(Duration::from_secs(2), || descendant_path.exists());
    let descendant_pid = fs::read_to_string(descendant_path)
        .expect("descendant PID reads")
        .trim()
        .parse::<u32>()
        .expect("descendant PID is numeric");

    assert_eq!(unsafe { libc::kill(root_pid as i32, libc::SIGKILL) }, 0);
    let terminated = assert_result(guardian.dispatch(terminate_request(
        "terminate-after-root-crash",
        "root-crash-1",
        "fence-root-crash",
    )));
    assert!(matches!(terminated, GuardianResult::Terminated { .. }));
    wait_until(Duration::from_secs(2), || process_is_dead(descendant_pid));
}

#[test]
fn stale_fence_and_duplicate_requests_cannot_create_or_mutate_another_process() {
    let temp = TempDir::new().expect("temporary root");
    let mut guardian = Guardian::open(temp.path(), fixture_child()).expect("guardian opens");
    let initial = spawn_request("request-1", "operation-1", "fence-a", false);
    let initial_result = assert_result(guardian.dispatch(initial.clone()));
    let initial_observation = match initial_result {
        GuardianResult::Spawned { observation } => observation,
        other => panic!("unexpected initial result: {other:?}"),
    };

    let exact_replay = assert_result(guardian.dispatch(initial));
    assert!(matches!(exact_replay, GuardianResult::Replay { .. }));
    let operation_replay = assert_result(guardian.dispatch(spawn_request(
        "request-2",
        "operation-1",
        "fence-a",
        false,
    )));
    let replay_observation = match operation_replay {
        GuardianResult::OperationAlreadyExists { observation } => observation,
        other => panic!("unexpected operation replay result: {other:?}"),
    };
    assert_eq!(replay_observation.pid, initial_observation.pid);
    assert_eq!(replay_observation.spawn_attempts, 1);

    let conflict = assert_result(guardian.dispatch(spawn_request(
        "request-1",
        "operation-1",
        "fence-b",
        false,
    )));
    assert!(matches!(
        conflict,
        GuardianResult::Rejected {
            code: GuardianErrorCode::RequestConflict,
            ..
        }
    ));
    let stale = assert_result(guardian.dispatch(terminate_request(
        "terminate-stale",
        "operation-1",
        "fence-b",
    )));
    assert!(matches!(
        stale,
        GuardianResult::Rejected {
            code: GuardianErrorCode::StaleFence,
            ..
        }
    ));
    assert!(matches!(
        guardian.reconcile("operation-1"),
        GuardianResult::ReconcileVerifiedLive { .. }
    ));

    let terminated = assert_result(guardian.dispatch(terminate_request(
        "terminate-good",
        "operation-1",
        "fence-a",
    )));
    assert!(
        matches!(terminated, GuardianResult::Terminated { .. }),
        "unexpected termination result: {terminated:?}"
    );
}

#[test]
fn explicit_fence_advance_rebinds_custody_and_rejects_the_old_fence() {
    let temp = TempDir::new().expect("temporary root");
    let mut guardian = Guardian::open(temp.path(), fixture_child()).expect("guardian opens");
    assert!(matches!(
        assert_result(guardian.dispatch(spawn_request(
            "spawn-rebind",
            "rebind-1",
            "fence-a",
            false,
        ))),
        GuardianResult::Spawned { .. }
    ));
    assert!(matches!(
        assert_result(guardian.dispatch(advance_fence_request(
            "advance-fence",
            "rebind-1",
            "fence-a",
            "fence-b",
        ))),
        GuardianResult::FenceAdvanced { .. }
    ));
    drop(guardian);
    let mut guardian = Guardian::open(temp.path(), fixture_child()).expect("guardian restarts");
    assert!(matches!(
        assert_result(guardian.dispatch(advance_fence_request(
            "advance-fence",
            "rebind-1",
            "fence-a",
            "fence-b",
        ))),
        GuardianResult::Replay { .. }
    ));

    let stale_termination = assert_result(guardian.dispatch(terminate_request(
        "terminate-old-fence",
        "rebind-1",
        "fence-a",
    )));
    assert!(matches!(
        stale_termination,
        GuardianResult::Rejected {
            code: GuardianErrorCode::StaleFence,
            ..
        }
    ));
    let stale_advance = assert_result(guardian.dispatch(advance_fence_request(
        "advance-old-fence",
        "rebind-1",
        "fence-a",
        "fence-c",
    )));
    assert!(matches!(
        stale_advance,
        GuardianResult::Rejected {
            code: GuardianErrorCode::StaleFence,
            ..
        }
    ));
    let terminated = assert_result(guardian.dispatch(terminate_request(
        "terminate-new-fence",
        "rebind-1",
        "fence-b",
    )));
    #[cfg(unix)]
    assert!(matches!(terminated, GuardianResult::Terminated { .. }));
    #[cfg(windows)]
    assert!(
        matches!(terminated, GuardianResult::ReconcileGone { .. }),
        "unexpected restarted Windows termination result: {terminated:?}"
    );
}

#[cfg(unix)]
#[test]
fn post_spawn_identity_failure_kills_the_synthetic_child_before_returning() {
    let temp = TempDir::new().expect("temporary root");
    let fixture = identity_stalling_fixture(temp.path());
    let root = temp.path().to_path_buf();
    let dispatch = thread::spawn(move || {
        let mut guardian = Guardian::open(&root, fixture).expect("guardian opens");
        let result = assert_result(guardian.dispatch(spawn_request(
            "spawn-stalled",
            "stalled-identity",
            "fence-stalled",
            false,
        )));
        let reconciliation = guardian.reconcile("stalled-identity");
        (result, reconciliation)
    });

    let pid_path = temp.path().join("operations/stalled-identity/stalled.pid");
    wait_until(Duration::from_secs(2), || {
        fs::read_to_string(&pid_path)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .and_then(observed_process_identity)
            .is_some()
    });
    let pid = fs::read_to_string(&pid_path)
        .expect("stalled child PID")
        .trim()
        .parse::<u32>()
        .expect("numeric stalled child PID");
    let identity = observed_process_identity(pid).expect("stalled child birth identity");
    let (result, reconciliation) = dispatch.join().expect("Guardian dispatch thread joins");
    assert!(matches!(
        result,
        GuardianResult::Rejected {
            code: GuardianErrorCode::Internal,
            ..
        }
    ));
    assert!(matches!(
        reconciliation,
        GuardianResult::ReconcileLaunchUncertain { .. }
    ));
    wait_until(Duration::from_secs(2), || {
        observed_process_identity(pid).as_ref() != Some(&identity)
    });
}

#[cfg(unix)]
#[test]
fn crash_window_recovers_live_process_started_before_live_record_persist() {
    let temp = TempDir::new().expect("temporary root");
    let root = temp.path().to_path_buf();
    let mut first = Guardian::open(&root, fixture_child()).expect("first guardian opens");
    assert!(matches!(
        assert_result(first.dispatch(spawn_request(
            "spawn-crash-window",
            "crash-window-1",
            "fence-crash-window",
            false,
        ))),
        GuardianResult::Spawned { .. }
    ));
    let record_path = root.join("custody/crash-window-1.json");
    let mut pre_live: serde_json::Value =
        serde_json::from_slice(&fs::read(&record_path).expect("custody record reads"))
            .expect("custody record parses");
    pre_live["state"] = serde_json::Value::String("launching".to_owned());
    pre_live["pid"] = serde_json::Value::Null;
    pre_live["birth_identity"] = serde_json::Value::Null;
    pre_live["process_group_id"] = serde_json::Value::Null;
    fs::write(
        &record_path,
        serde_json::to_vec(&pre_live).expect("pre-live record serializes"),
    )
    .expect("pre-live record writes");
    drop(first);

    let mut recovered = Guardian::open(&root, fixture_child()).expect("recovery guardian opens");
    assert!(matches!(
        recovered.reconcile("crash-window-1"),
        GuardianResult::ReconcileVerifiedLive { .. }
    ));
    assert!(matches!(
        assert_result(recovered.dispatch(terminate_request(
            "terminate-crash-window",
            "crash-window-1",
            "fence-crash-window",
        ))),
        GuardianResult::Terminated { .. }
    ));
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn mismatched_birth_identity_refuses_pid_reuse_termination() {
    let temp = TempDir::new().expect("temporary root");
    let root = temp.path().to_path_buf();
    let mut first = Guardian::open(&root, fixture_child()).expect("first guardian opens");
    let spawned = assert_result(first.dispatch(spawn_request(
        "spawn-birth-mismatch",
        "birth-mismatch-1",
        "fence-birth-mismatch",
        false,
    )));
    let pid = match spawned {
        GuardianResult::Spawned { observation } => observation.pid.expect("fixture PID"),
        other => panic!("unexpected spawn result: {other:?}"),
    };
    drop(first);

    let record_path = root.join("custody/birth-mismatch-1.json");
    let original = fs::read(&record_path).expect("custody record reads");
    let mut tampered: serde_json::Value =
        serde_json::from_slice(&original).expect("custody record parses");
    tampered["birth_identity"] = mismatched_birth_identity();
    fs::write(
        &record_path,
        serde_json::to_vec(&tampered).expect("tampered record serializes"),
    )
    .expect("tampered record writes");

    let mut tampered_guardian =
        Guardian::open(&root, fixture_child()).expect("tampered guardian opens");
    assert!(matches!(
        tampered_guardian.reconcile("birth-mismatch-1"),
        GuardianResult::ReconcileIdentityUnverified { .. }
    ));
    assert!(matches!(
        assert_result(tampered_guardian.dispatch(terminate_request(
            "terminate-birth-mismatch",
            "birth-mismatch-1",
            "fence-birth-mismatch",
        ))),
        GuardianResult::ReconcileIdentityUnverified { .. }
    ));
    assert!(
        !process_is_dead(pid),
        "the live fixture must survive a mismatched persisted birth identity"
    );
    drop(tampered_guardian);

    fs::write(&record_path, original).expect("restore exact custody record");
    let mut recovered = Guardian::open(&root, fixture_child()).expect("recovered guardian opens");
    assert!(matches!(
        assert_result(recovered.dispatch(terminate_request(
            "terminate-restored-birth",
            "birth-mismatch-1",
            "fence-birth-mismatch",
        ))),
        GuardianResult::Terminated { .. }
    ));
}

#[cfg(unix)]
#[test]
fn restarted_guardian_requires_custody_proof_not_pid_alone_before_termination() {
    let temp = TempDir::new().expect("temporary root");
    let root = temp.path().to_path_buf();
    let mut first = Guardian::open(&root, fixture_child()).expect("first guardian opens");
    let initial_request = spawn_request("spawn-recovery", "recovery-1", "fence-recovery", false);
    let result = assert_result(first.dispatch(initial_request.clone()));
    let observation = match result {
        GuardianResult::Spawned { observation } => observation,
        other => panic!("unexpected spawn result: {other:?}"),
    };
    let pid = observation.pid.expect("fixture PID");
    let descendant_pid_path = root.join("operations/recovery-1/descendant.pid");
    wait_until(Duration::from_secs(2), || descendant_pid_path.exists());
    let descendant_pid = fs::read_to_string(descendant_pid_path)
        .expect("descendant PID file")
        .trim()
        .parse::<u32>()
        .expect("numeric descendant PID");
    drop(first);
    assert!(
        !process_is_dead(pid),
        "Unix fixture must survive a Guardian process loss for reconciliation"
    );

    let mut restarted_for_replay =
        Guardian::open(&root, fixture_child()).expect("restarted guardian opens");
    assert!(matches!(
        assert_result(restarted_for_replay.dispatch(initial_request)),
        GuardianResult::Replay { .. }
    ));
    drop(restarted_for_replay);

    let record_path = root.join("custody/recovery-1.json");
    let original = fs::read(&record_path).expect("custody evidence reads");
    let mut tampered: serde_json::Value =
        serde_json::from_slice(&original).expect("custody evidence JSON");
    tampered["spawn_nonce"] = serde_json::Value::String("wrong-nonce".to_owned());
    fs::write(
        &record_path,
        serde_json::to_vec(&tampered).expect("tampered JSON"),
    )
    .expect("tampered record writes");

    let mut tampered_guardian =
        Guardian::open(&root, fixture_child()).expect("tampered guardian opens");
    assert!(matches!(
        tampered_guardian.reconcile("recovery-1"),
        GuardianResult::ReconcileIdentityUnverified { .. }
    ));
    let rejected_termination = assert_result(tampered_guardian.dispatch(terminate_request(
        "terminate-tampered",
        "recovery-1",
        "fence-recovery",
    )));
    assert!(matches!(
        rejected_termination,
        GuardianResult::ReconcileIdentityUnverified { .. }
    ));
    assert!(
        !process_is_dead(pid),
        "PID alone must not authorize termination"
    );
    drop(tampered_guardian);

    fs::write(&record_path, original).expect("restore exact custody evidence");
    let mut restarted = Guardian::open(&root, fixture_child()).expect("restarted guardian opens");
    assert!(matches!(
        restarted.reconcile("recovery-1"),
        GuardianResult::ReconcileVerifiedLive { .. }
    ));
    let terminated = assert_result(restarted.dispatch(terminate_request(
        "terminate-recovery",
        "recovery-1",
        "fence-recovery",
    )));
    assert!(
        matches!(terminated, GuardianResult::Terminated { .. }),
        "unexpected termination result: {terminated:?}"
    );
    assert!(
        root.join("operations/recovery-1/terminated.marker")
            .exists(),
        "the persisted root must publish a terminal witness before recovery declares it gone"
    );
    wait_until(Duration::from_secs(2), || process_is_dead(descendant_pid));
}

#[test]
fn protocol_versions_and_platform_capability_are_typed_and_fail_closed() {
    let temp = TempDir::new().expect("temporary root");
    let mut guardian = Guardian::open(temp.path(), fixture_child()).expect("guardian opens");
    let invalid_version = RequestEnvelope {
        protocol_version: CURRENT_PROTOCOL_VERSION + 1,
        request_id: "newer-version".to_owned(),
        command: GuardianCommand::InspectContainment,
    };
    let invalid_result = assert_result(guardian.dispatch(invalid_version));
    assert!(matches!(
        invalid_result,
        GuardianResult::ProtocolRejected { .. }
    ));
    let containment = assert_result(guardian.dispatch(RequestEnvelope {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        request_id: "capability".to_owned(),
        command: GuardianCommand::InspectContainment,
    }));
    match containment {
        GuardianResult::Containment { report } => {
            #[cfg(unix)]
            assert_eq!(report.mechanism, ContainmentMechanism::UnixProcessGroup);
            #[cfg(windows)]
            assert_eq!(report.mechanism, ContainmentMechanism::WindowsJobObject);
            assert!(report.qualified_for_bounded_fixture);
            assert!(report.limitation.is_some());
        }
        other => panic!("unexpected containment result: {other:?}"),
    }
}

struct GuardianProcess {
    child: Child,
    stdin: ChildStdin,
    responses: Receiver<String>,
}

impl GuardianProcess {
    fn start(root: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_spike-guardian"))
            .args([
                "--root",
                root.to_str().expect("UTF-8 root"),
                "--fixture-child",
                fixture_child().to_str().expect("UTF-8 fixture path"),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("guardian process starts");
        let stdout = child.stdout.take().expect("guardian stdout");
        let (sender, responses) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = sender.send(line);
            }
        });
        Self {
            stdin: child.stdin.take().expect("guardian stdin"),
            child,
            responses,
        }
    }

    fn send(&mut self, request: &RequestEnvelope) {
        serde_json::to_writer(&mut self.stdin, request).expect("request serializes");
        self.stdin
            .write_all(b"\n")
            .expect("frame terminator writes");
        self.stdin.flush().expect("request flushes");
    }

    fn receive(&self) -> ResponseEnvelope<GuardianResult> {
        let response = self
            .responses
            .recv_timeout(Duration::from_secs(3))
            .expect("guardian must respond");
        serde_json::from_str(&response).expect("typed response parses")
    }
}

#[test]
fn guardian_state_root_has_one_os_process_owner_and_allows_handoff_after_exit() {
    let temp = TempDir::new().expect("temporary root");
    let mut owner = GuardianProcess::start(temp.path());
    owner.send(&RequestEnvelope {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        request_id: "owner-ready".to_owned(),
        command: GuardianCommand::InspectContainment,
    });
    assert!(matches!(
        owner.receive().result,
        GuardianResult::Containment { .. }
    ));

    let contender = Command::new(env!("CARGO_BIN_EXE_spike-guardian"))
        .args([
            "--root",
            temp.path().to_str().expect("UTF-8 root"),
            "--fixture-child",
            fixture_child().to_str().expect("UTF-8 fixture path"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .expect("contending Guardian process exits");
    assert!(!contender.status.success());
    let contender_stderr = String::from_utf8_lossy(&contender.stderr);
    assert!(
        contender_stderr.contains("another Guardian already owns this state root"),
        "contender must fail with the typed state-root lock error: {contender_stderr}"
    );

    drop(owner.stdin);
    assert!(owner.child.wait().expect("owner exits").success());
    let successor = Command::new(env!("CARGO_BIN_EXE_spike-guardian"))
        .args([
            "--root",
            temp.path().to_str().expect("UTF-8 root"),
            "--fixture-child",
            fixture_child().to_str().expect("UTF-8 fixture path"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .expect("successor Guardian process exits");
    assert!(
        successor.status.success(),
        "successor must acquire the released state root: {}",
        String::from_utf8_lossy(&successor.stderr)
    );
}

#[test]
fn ambiguous_spawn_response_is_reconciled_without_a_blind_second_spawn() {
    let temp = TempDir::new().expect("temporary root");
    let mut guardian = GuardianProcess::start(temp.path());
    let spawn = spawn_request(
        "ambiguous-request",
        "ambiguous-operation",
        "fence-ambiguous",
        true,
    );
    guardian.send(&spawn);
    assert!(
        guardian
            .responses
            .recv_timeout(Duration::from_millis(150))
            .is_err(),
        "the fixture must lose the spawn response"
    );

    guardian.send(&RequestEnvelope {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        request_id: "reconcile-request".to_owned(),
        command: GuardianCommand::Query {
            operation_id: "ambiguous-operation".to_owned(),
        },
    });
    let reconciled = guardian.receive();
    let observation = match reconciled.result {
        GuardianResult::ReconcileVerifiedLive { observation } => observation,
        other => panic!("caller must reconcile instead of retrying: {other:?}"),
    };
    assert_eq!(observation.spawn_attempts, 1);

    guardian.send(&spawn_request(
        "would-be-retry",
        "ambiguous-operation",
        "fence-ambiguous",
        false,
    ));
    let operation_replay = guardian.receive();
    match operation_replay.result {
        GuardianResult::OperationAlreadyExists {
            observation: replay,
        } => {
            assert_eq!(replay.pid, observation.pid);
            assert_eq!(replay.spawn_attempts, 1);
        }
        other => panic!("operation identity must prevent a duplicate spawn: {other:?}"),
    }

    guardian.send(&terminate_request(
        "terminate-ambiguous",
        "ambiguous-operation",
        "fence-ambiguous",
    ));
    let terminated = guardian.receive().result;
    assert!(
        matches!(terminated, GuardianResult::Terminated { .. }),
        "unexpected termination result: {terminated:?}"
    );
    drop(guardian.stdin);
    assert!(guardian.child.wait().expect("guardian exits").success());
}

#[cfg(windows)]
#[test]
fn guardian_process_crash_closes_the_job_and_reaps_the_immediate_descendant() {
    let temp = TempDir::new().expect("temporary root");
    let mut guardian = GuardianProcess::start(temp.path());
    guardian.send(&spawn_request(
        "spawn-crash-containment",
        "crash-containment-1",
        "fence-crash-containment",
        false,
    ));
    let root_pid = match guardian.receive().result {
        GuardianResult::Spawned { observation } => observation.pid.expect("fixture root PID"),
        other => panic!("unexpected spawn result: {other:?}"),
    };
    let descendant_path = temp
        .path()
        .join("operations/crash-containment-1/descendant.pid");
    wait_until(Duration::from_secs(2), || descendant_path.exists());
    let descendant_pid = fs::read_to_string(descendant_path)
        .expect("descendant PID reads")
        .trim()
        .parse::<u32>()
        .expect("numeric descendant PID");

    guardian.child.kill().expect("Guardian process terminates");
    let status = guardian.child.wait().expect("Guardian process exits");
    assert!(
        !status.success(),
        "test must terminate the Guardian process"
    );
    wait_until(Duration::from_secs(2), || process_is_dead(root_pid));
    wait_until(Duration::from_secs(2), || process_is_dead(descendant_pid));
}
