use boundary_supervisor::{
    EnsureOptions, FaultBehavior, FaultPoint, HostLaunch, Supervisor, TrustAnchor,
};
use std::env;
use std::path::PathBuf;

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

fn has_flag(name: &str) -> bool {
    env::args().skip(1).any(|argument| argument == name)
}

fn main() {
    let root = PathBuf::from(argument("--root"));
    if has_flag("--recover") {
        Supervisor::open(root)
            .and_then(|supervisor| supervisor.recover())
            .expect("separate recovery process must succeed");
        return;
    }
    let release = PathBuf::from(argument("--release"));
    let anchor =
        TrustAnchor::from_base64(&argument("--trust-anchor")).expect("valid fixture trust anchor");
    let fault_point = match optional_argument("--crash-at").as_deref() {
        None => None,
        Some("after_staged") => Some(FaultPoint::AfterStaged),
        Some("before_previous_host_termination") => Some(FaultPoint::BeforePreviousHostTermination),
        Some("after_active_pointer_write_before_phase_update") => {
            Some(FaultPoint::AfterActivePointerWriteBeforePhaseUpdate)
        }
        Some("after_phase_update_before_commit") => Some(FaultPoint::AfterPhaseUpdateBeforeCommit),
        Some(value) => panic!("unsupported crash phase: {value}"),
    };
    let result = Supervisor::open(root).and_then(|supervisor| {
        let host_launch = optional_argument("--host-mode")
            .map_or_else(HostLaunch::default, |mode| {
                HostLaunch::with_extra_args(["--mode", mode.as_str()])
            });
        supervisor.ensure(
            &release,
            &anchor,
            &host_launch,
            EnsureOptions {
                fault_point,
                fault_behavior: if fault_point.is_some() {
                    FaultBehavior::AbortProcess
                } else {
                    FaultBehavior::ReturnError
                },
            },
        )
    });
    if fault_point.is_some() {
        panic!("the aborting fault behavior unexpectedly returned: {result:?}");
    }
    let active = result.expect("supervisor ensure must succeed");
    println!("{}", active.generation_id);
}
