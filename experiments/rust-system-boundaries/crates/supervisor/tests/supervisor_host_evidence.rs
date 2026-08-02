use boundary_supervisor::{
    ActiveGeneration, EnsureOptions, HealthCheck, Supervisor, SupervisorError, TrustAnchor,
    write_fixture_release,
};
use ed25519_dalek::SigningKey;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const WITNESS_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
struct HostObservation {
    generation_id: String,
    pid: u32,
}

#[derive(Debug)]
struct RunningHost {
    observation: HostObservation,
    child: Child,
}

#[derive(Debug, Default)]
struct HostState {
    running: Option<RunningHost>,
    stopped_pids: Vec<u32>,
}

#[derive(Debug)]
struct SyntheticHostWitness {
    host_binary: PathBuf,
    ready_path: PathBuf,
    heartbeat_path: PathBuf,
    state: Mutex<HostState>,
    starts: AtomicUsize,
    crash_detections: AtomicUsize,
}

impl SyntheticHostWitness {
    fn new(root: &Path) -> Self {
        fs::create_dir_all(root).expect("Host witness root must be writable");
        Self {
            host_binary: PathBuf::from(env!("CARGO_BIN_EXE_synthetic_host")),
            ready_path: root.join("host-ready"),
            heartbeat_path: root.join("host-heartbeat"),
            state: Mutex::new(HostState::default()),
            starts: AtomicUsize::new(0),
            crash_detections: AtomicUsize::new(0),
        }
    }

    fn ensure_active(&self, supervisor: &Supervisor) -> HostObservation {
        let active = supervisor
            .inspect_active()
            .expect("active generation inspection succeeds")
            .expect("an active generation is required to bootstrap the Host");
        let mut state = self.lock_state();
        if let Some(running) = state.running.as_mut()
            && running.observation.generation_id == active.generation_id
            && self.host_is_healthy(running)
        {
            return running.observation.clone();
        }
        Self::stop_running(&mut state);
        let running = self.start_host(&active);
        let observation = running.observation.clone();
        state.running = Some(running);
        observation
    }

    fn crash_current(&self) -> HostObservation {
        let mut state = self.lock_state();
        let running = state
            .running
            .as_mut()
            .expect("a Host must be running before it can crash");
        let observation = running.observation.clone();
        running.child.kill().expect("synthetic Host crash signal");
        running.child.wait().expect("synthetic Host crash exit");
        observation
    }

    fn start_count(&self) -> usize {
        self.starts.load(Ordering::SeqCst)
    }

    fn crash_detection_count(&self) -> usize {
        self.crash_detections.load(Ordering::SeqCst)
    }

    fn was_stopped(&self, pid: u32) -> bool {
        self.lock_state().stopped_pids.contains(&pid)
    }

    fn heartbeat_sequence(&self, observation: &HostObservation) -> Option<u64> {
        let heartbeat = fs::read_to_string(&self.heartbeat_path).ok()?;
        let mut fields = heartbeat.lines();
        if fields.next()? != observation.generation_id {
            return None;
        }
        if fields.next()?.parse::<u32>().ok()? != observation.pid {
            return None;
        }
        fields.next()?.parse::<u64>().ok()
    }

    fn host_is_healthy(&self, running: &mut RunningHost) -> bool {
        if !matches!(running.child.try_wait(), Ok(None)) {
            self.crash_detections.fetch_add(1, Ordering::SeqCst);
            return false;
        }
        self.heartbeat_sequence(&running.observation).is_some()
    }

    fn start_host(&self, active: &ActiveGeneration) -> RunningHost {
        let _ = fs::remove_file(&self.ready_path);
        let _ = fs::remove_file(&self.heartbeat_path);
        let mut child = Command::new(&self.host_binary)
            .arg("--generation")
            .arg(&active.generation_id)
            .arg("--ready-path")
            .arg(&self.ready_path)
            .arg("--heartbeat-path")
            .arg(&self.heartbeat_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("synthetic Host process starts");
        let observation = HostObservation {
            generation_id: active.generation_id.clone(),
            pid: child.id(),
        };
        wait_until(WITNESS_TIMEOUT, || {
            self.ready_matches(&observation) && self.heartbeat_sequence(&observation).is_some()
        });
        assert!(
            matches!(child.try_wait(), Ok(None)),
            "synthetic Host must remain live after bootstrap"
        );
        self.starts.fetch_add(1, Ordering::SeqCst);
        RunningHost { observation, child }
    }

    fn ready_matches(&self, observation: &HostObservation) -> bool {
        fs::read_to_string(&self.ready_path).is_ok_and(|ready| {
            ready == format!("{}\n{}\n", observation.generation_id, observation.pid)
        })
    }

    fn lock_state(&self) -> MutexGuard<'_, HostState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn stop_running(state: &mut HostState) {
        if let Some(mut running) = state.running.take() {
            let pid = running.observation.pid;
            let _ = running.child.kill();
            let _ = running.child.wait();
            state.stopped_pids.push(pid);
        }
    }
}

impl Drop for SyntheticHostWitness {
    fn drop(&mut self) {
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(|poison| poison.into_inner());
        Self::stop_running(state);
    }
}

fn fixture_key() -> SigningKey {
    SigningKey::from_bytes(&[0x5a; 32])
}

fn release(root: &Path, version: &str, body: &[u8], key: &SigningKey) {
    write_fixture_release(root, version, body, key).expect("fixture release must be writable");
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
fn synthetic_host_witness_converges_detects_crash_and_rolls_back_or_restarts_updates() {
    let temp = TempDir::new().expect("temporary root");
    let supervisor_root = temp.path().join("supervisor");
    let host_root = temp.path().join("host");
    let initial_release = temp.path().join("initial");
    let update_release = temp.path().join("update");
    let key = fixture_key();
    let anchor = TrustAnchor::from_signing_key(&key);
    release(&initial_release, "1.0.0", b"initial host bytes", &key);
    release(&update_release, "2.0.0", b"updated host bytes", &key);

    let supervisor = Arc::new(Supervisor::open(&supervisor_root).expect("supervisor opens"));
    let witness = Arc::new(SyntheticHostWitness::new(&host_root));
    let start = Arc::new(Barrier::new(8));
    let threads = (0..8)
        .map(|_| {
            let supervisor = Arc::clone(&supervisor);
            let witness = Arc::clone(&witness);
            let release_root = initial_release.clone();
            let anchor = anchor.clone();
            let start = Arc::clone(&start);
            thread::spawn(move || {
                start.wait();
                supervisor
                    .ensure(&release_root, &anchor, EnsureOptions::default())
                    .expect("concurrent ensure succeeds");
                witness.ensure_active(&supervisor)
            })
        })
        .collect::<Vec<_>>();
    let observations = threads
        .into_iter()
        .map(|thread| {
            thread
                .join()
                .expect("concurrent Host bootstrap must not panic")
        })
        .collect::<Vec<_>>();
    let initial_host = observations
        .first()
        .expect("at least one Host observation")
        .clone();
    assert!(
        observations
            .iter()
            .all(|observation| observation == &initial_host),
        "concurrent ensure must converge on exactly one Host generation and process"
    );
    assert_eq!(witness.start_count(), 1);
    assert_eq!(
        supervisor
            .inspect_active()
            .expect("active inspection succeeds")
            .expect("initial generation remains active")
            .generation_id,
        initial_host.generation_id
    );
    let initial_heartbeat = witness
        .heartbeat_sequence(&initial_host)
        .expect("initial Host heartbeat is readable");
    wait_until(WITNESS_TIMEOUT, || {
        witness
            .heartbeat_sequence(&initial_host)
            .is_some_and(|sequence| sequence > initial_heartbeat)
    });

    let crashed_host = witness.crash_current();
    let recovered_host = witness.ensure_active(&supervisor);
    assert_eq!(recovered_host.generation_id, initial_host.generation_id);
    assert_ne!(recovered_host.pid, crashed_host.pid);
    assert_eq!(witness.crash_detection_count(), 1);
    assert_eq!(witness.start_count(), 2);
    assert!(witness.was_stopped(crashed_host.pid));

    let failed_update = supervisor.ensure(
        &update_release,
        &anchor,
        EnsureOptions {
            health_check: HealthCheck::Fail,
            ..EnsureOptions::default()
        },
    );
    assert!(matches!(
        failed_update,
        Err(SupervisorError::HealthCheckFailed)
    ));
    let host_after_failed_update = witness.ensure_active(&supervisor);
    assert_eq!(host_after_failed_update, recovered_host);
    assert_eq!(witness.start_count(), 2);
    assert_eq!(
        supervisor
            .inspect_active()
            .expect("active inspection succeeds")
            .expect("prior healthy generation remains active")
            .version,
        "1.0.0"
    );

    let updated_generation = supervisor
        .ensure(&update_release, &anchor, EnsureOptions::default())
        .expect("healthy update activates");
    let updated_host = witness.ensure_active(&supervisor);
    assert_eq!(updated_host.generation_id, updated_generation.generation_id);
    assert_ne!(updated_host.pid, recovered_host.pid);
    assert_eq!(witness.start_count(), 3);
    assert!(witness.was_stopped(recovered_host.pid));
}
