//! Unix containment evidence primitives.
//!
//! This module is intentionally not wired into the production Guardian yet.
//! It captures the platform proof required before doing so:
//!
//! - a Unix process group is not containment because a descendant can call
//!   `setsid()` and leave it;
//! - Linux pidfds remove the check-then-signal PID reuse race for one process;
//! - a host-owned, delegated cgroup v2 tree is required to contain a process
//!   tree that may call `setsid()`;
//! - macOS has no supported equivalent in this spike, so it must fail closed
//!   for untrusted or restartable process-tree custody.
//!
//! `pidfd` is deliberately not presented as process-tree containment. It is a
//! stable handle for one task. Linux cgroup v2 can kill a whole subtree, but
//! only after the Host has created and exclusively owns a dedicated cgroup.

#![cfg(unix)]

use std::io;

#[cfg(target_os = "linux")]
use std::fmt;
#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::io::{Read, Write};
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(target_os = "linux")]
use std::path::Path;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnixContainmentGate {
    #[cfg(target_os = "linux")]
    LinuxRequiresDelegatedCgroupV2 { blocker: LinuxCgroupV2Blocker },
    #[cfg(target_os = "linux")]
    LinuxCgroupV2Candidate { root: String },
    #[cfg(target_os = "macos")]
    MacosFailClosed { blocker: &'static str },
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    UnsupportedUnixFailClosed { blocker: &'static str },
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinuxCgroupV2Blocker {
    MissingExplicitDelegatedRoot,
    NotCgroupV2Filesystem { root: String },
    MissingRequiredControlFile { root: String, file: &'static str },
    RequiredControlFileNotWritable { root: String, file: &'static str },
    HostOwnedLeafIsPopulated { root: String },
}

#[cfg(target_os = "linux")]
impl fmt::Display for LinuxCgroupV2Blocker {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingExplicitDelegatedRoot => write!(
                formatter,
                "a Host-owned delegated cgroup v2 root is required; process-group fallback is forbidden"
            ),
            Self::NotCgroupV2Filesystem { root } => {
                write!(formatter, "{root} is not a cgroup v2 filesystem")
            }
            Self::MissingRequiredControlFile { root, file } => {
                write!(
                    formatter,
                    "{root} does not expose required cgroup v2 control file {file}"
                )
            }
            Self::RequiredControlFileNotWritable { root, file } => write!(
                formatter,
                "{root} does not grant the Host write access to required cgroup v2 control file {file}"
            ),
            Self::HostOwnedLeafIsPopulated { root } => write!(
                formatter,
                "{root} is already populated; the Host must create a new empty delegated leaf before spawning into it"
            ),
        }
    }
}

/// Returns the production gate for a Unix Host.
///
/// A path is only a candidate. The caller must additionally prove that it is a
/// newly created, Host-owned leaf and spawn directly into it. Moving a process
/// after it has started leaves an escape window before cgroup membership is
/// established. On Linux that direct spawn requires a native launcher using
/// `clone3(CLONE_INTO_CGROUP)` or a service manager that offers the same
/// guarantee.
#[cfg(target_os = "linux")]
pub fn linux_containment_gate(delegated_root: Option<&std::path::Path>) -> UnixContainmentGate {
    let Some(root) = delegated_root else {
        return UnixContainmentGate::LinuxRequiresDelegatedCgroupV2 {
            blocker: LinuxCgroupV2Blocker::MissingExplicitDelegatedRoot,
        };
    };

    match LinuxCgroupV2Tree::open_new_host_owned_leaf(root) {
        Ok(_) => UnixContainmentGate::LinuxCgroupV2Candidate {
            root: root.display().to_string(),
        },
        Err(blocker) => UnixContainmentGate::LinuxRequiresDelegatedCgroupV2 { blocker },
    }
}

/// macOS has process groups and sessions, but a process can create a new
/// session with `setsid()`. This spike has no pidfd-like stable process handle
/// and no cgroup v2 tree-kill primitive on macOS. Re-checking a PID's start
/// time and then calling `kill(pid, ...)` cannot close PID reuse between those
/// two operations, so production custody must reject this capability instead
/// of reporting process-group containment as sufficient.
#[cfg(target_os = "macos")]
pub fn macos_containment_gate() -> UnixContainmentGate {
    UnixContainmentGate::MacosFailClosed {
        blocker: "macOS lacks a supported pidfd plus cgroup-v2 tree-custody primitive in this Host; process-group/session containment is not qualified",
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn unsupported_unix_containment_gate() -> UnixContainmentGate {
    UnixContainmentGate::UnsupportedUnixFailClosed {
        blocker: "this Unix target has no qualified process-tree containment primitive in the spike",
    }
}

#[cfg(target_os = "linux")]
/// A descriptor-backed cgroup v2 tree that was empty when the Host accepted
/// it. The Host retains this handle while it directly spawns the workload into
/// the cgroup. `kill_tree` writes `1` to `cgroup.kill`, which Linux applies to
/// the cgroup and all of its descendants, including concurrent forks.
///
/// This type cannot prove that a pathname belongs to this Host. The caller
/// must create the leaf in a delegated subtree under Host control and must not
/// give the workload permission to move itself out of that subtree. The empty
/// leaf check makes accidental adoption of a populated shared cgroup fail
/// closed; it is not a substitute for that ownership contract.
#[cfg(target_os = "linux")]
#[derive(Debug)]
pub struct LinuxCgroupV2Tree {
    directory: File,
}

/// A directly spawned child whose initial cgroup membership was selected by
/// `clone3(CLONE_INTO_CGROUP)`, before the child had a chance to execute
/// workload code.
///
/// This type is evidence-only. It gives the caller a `waitpid` handle for the
/// direct child; it is not a general-purpose process supervisor.
#[cfg(target_os = "linux")]
#[derive(Debug)]
pub struct LinuxCgroupV2Child {
    process_id: u32,
    reaped: bool,
}

#[cfg(target_os = "linux")]
impl LinuxCgroupV2Tree {
    pub fn open_new_host_owned_leaf(root: &std::path::Path) -> Result<Self, LinuxCgroupV2Blocker> {
        let root_display = root.display().to_string();
        let directory = open_cgroup_directory(root).map_err(|_| {
            LinuxCgroupV2Blocker::NotCgroupV2Filesystem {
                root: root_display.clone(),
            }
        })?;
        verify_cgroup2_filesystem(&directory, &root_display)?;

        for control_file in ["cgroup.procs", "cgroup.kill"] {
            open_cgroup_control_file(
                &directory,
                control_file,
                libc::O_WRONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
            .map_err(|_| LinuxCgroupV2Blocker::RequiredControlFileNotWritable {
                root: root_display.clone(),
                file: control_file,
            })?;
        }

        let mut events = String::new();
        open_cgroup_control_file(
            &directory,
            "cgroup.events",
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
        .map_err(|_| LinuxCgroupV2Blocker::MissingRequiredControlFile {
            root: root_display.clone(),
            file: "cgroup.events",
        })?
        .read_to_string(&mut events)
        .map_err(|_| LinuxCgroupV2Blocker::MissingRequiredControlFile {
            root: root_display.clone(),
            file: "cgroup.events",
        })?;
        if !events.lines().any(|line| line.trim() == "populated 0") {
            return Err(LinuxCgroupV2Blocker::HostOwnedLeafIsPopulated { root: root_display });
        }

        Ok(Self { directory })
    }

    /// Kills the held cgroup tree without resolving a path again.
    ///
    /// This is the only primitive in this spike that is resistant to a
    /// `setsid()` escape for a whole process tree. It deliberately uses
    /// SIGKILL because cgroup.kill has that kernel-defined semantic.
    pub fn kill_tree(&self) -> io::Result<()> {
        let mut kill_control = open_cgroup_control_file(
            &self.directory,
            "cgroup.kill",
            libc::O_WRONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )?;
        kill_control.write_all(b"1\n")
    }

    /// Lists every thread-group leader that currently belongs to this exact
    /// cgroup. Reading through the retained directory FD prevents a later
    /// pathname replacement from changing the object being inspected.
    pub fn member_process_ids(&self) -> io::Result<Vec<u32>> {
        let mut contents = String::new();
        open_cgroup_control_file(
            &self.directory,
            "cgroup.procs",
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )?
        .read_to_string(&mut contents)?;

        contents
            .lines()
            .map(|line| {
                line.parse::<u32>().map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("cgroup.procs contained a non-PID value: {line:?}"),
                    )
                })
            })
            .collect()
    }

    /// Waits until both cgroup v2's `populated` state and its explicit member
    /// list are empty. The two observations guard different failure modes: a
    /// stale process list is not enough, and a bare lifecycle bit is not an
    /// orphan scan.
    pub fn wait_until_empty(&self, timeout: Duration) -> io::Result<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            if !self.is_populated()? && self.member_process_ids()?.is_empty() {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Starts one executable directly inside this tree using
    /// `clone3(CLONE_INTO_CGROUP)`. There is deliberately no fallback to
    /// `fork` plus a later write to `cgroup.procs`: such a fallback would
    /// reintroduce the pre-containment escape window this evidence guards.
    pub fn spawn_exec_atomically(
        &self,
        executable: &Path,
        arguments: &[&std::ffi::OsStr],
    ) -> io::Result<LinuxCgroupV2Child> {
        let executable = os_str_to_c_string(executable.as_os_str())?;
        let mut argument_storage = Vec::with_capacity(arguments.len() + 1);
        argument_storage.push(executable.clone());
        for argument in arguments {
            argument_storage.push(os_str_to_c_string(argument)?);
        }
        let mut argument_pointers = argument_storage
            .iter()
            .map(|argument| argument.as_ptr())
            .collect::<Vec<_>>();
        argument_pointers.push(std::ptr::null());

        let mut clone_arguments: libc::clone_args = unsafe { std::mem::zeroed() };
        clone_arguments.flags = CLONE_INTO_CGROUP;
        clone_arguments.exit_signal = libc::SIGCHLD as u64;
        clone_arguments.cgroup = self.directory.as_raw_fd() as u64;

        // SAFETY: clone_arguments contains only the documented clone3 fields,
        // the cgroup FD belongs to this verified v2 directory, and all argv
        // pointers remain valid across the syscall. The child takes the
        // async-signal-safe exec-or-exit path below without touching Rust
        // allocator state after the clone.
        let result = unsafe {
            libc::syscall(
                libc::SYS_clone3,
                std::ptr::addr_of!(clone_arguments),
                std::mem::size_of::<libc::clone_args>(),
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        if result == 0 {
            // SAFETY: executable and argument_pointers were prepared before
            // clone3, form a null-terminated argv vector, and remain valid in
            // the child address space until execv replaces it.
            unsafe {
                libc::execv(executable.as_ptr(), argument_pointers.as_ptr());
                libc::_exit(127);
            }
        }

        Ok(LinuxCgroupV2Child {
            process_id: result as u32,
            reaped: false,
        })
    }

    fn is_populated(&self) -> io::Result<bool> {
        let mut events = String::new();
        open_cgroup_control_file(
            &self.directory,
            "cgroup.events",
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )?
        .read_to_string(&mut events)?;

        for line in events.lines() {
            let mut fields = line.split_whitespace();
            if fields.next() != Some("populated") {
                continue;
            }
            return match (fields.next(), fields.next()) {
                (Some("0"), None) => Ok(false),
                (Some("1"), None) => Ok(true),
                (Some(value), None) => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("cgroup.events contained an invalid populated value: {value:?}"),
                )),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "cgroup.events contained a malformed populated line",
                )),
            };
        }

        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "cgroup.events did not contain populated state",
        ))
    }
}

#[cfg(target_os = "linux")]
impl LinuxCgroupV2Child {
    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    /// Reaps the direct child after a bounded wait. Descendants intentionally
    /// are not waited by PID: they are checked by the cgroup member scan so a
    /// `setsid()` escape cannot hide them from the evidence.
    pub fn wait_for_exit(&mut self, timeout: Duration) -> io::Result<bool> {
        if self.reaped {
            return Ok(true);
        }

        let deadline = Instant::now() + timeout;
        loop {
            let mut status = 0;
            // SAFETY: process_id is a direct child created by clone3 in this
            // process, status points to initialized writable storage, and
            // WNOHANG does not alter unrelated children.
            let result = unsafe {
                libc::waitpid(self.process_id as libc::pid_t, &mut status, libc::WNOHANG)
            };
            if result == self.process_id as libc::pid_t {
                self.reaped = true;
                return Ok(true);
            }
            if result == 0 {
                if Instant::now() >= deadline {
                    return Ok(false);
                }
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            if result < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            unreachable!("waitpid returned an impossible positive PID");
        }
    }
}

#[cfg(target_os = "linux")]
const CLONE_INTO_CGROUP: u64 = 1_u64 << 33;

#[cfg(target_os = "linux")]
fn os_str_to_c_string(value: &std::ffi::OsStr) -> io::Result<std::ffi::CString> {
    std::ffi::CString::new(value.as_encoded_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "cgroup fixture path or argument contains NUL",
        )
    })
}

#[cfg(target_os = "linux")]
fn open_cgroup_directory(root: &std::path::Path) -> io::Result<File> {
    let path = std::ffi::CString::new(root.as_os_str().as_encoded_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "cgroup root contains NUL"))?;
    // SAFETY: `path` is NUL terminated. O_NOFOLLOW and O_DIRECTORY ensure the
    // resulting descriptor refers to the requested directory rather than a
    // symlinked replacement.
    let raw_fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if raw_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `raw_fd` was returned by open above and ownership is transferred
    // to File exactly once.
    Ok(unsafe { File::from_raw_fd(raw_fd) })
}

#[cfg(target_os = "linux")]
fn verify_cgroup2_filesystem(directory: &File, root: &str) -> Result<(), LinuxCgroupV2Blocker> {
    const CGROUP2_SUPER_MAGIC: libc::c_long = 0x6367_7270;

    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: the File owns a valid directory FD and `stat` is writable
    // storage for the fstatfs result.
    if unsafe { libc::fstatfs(directory.as_raw_fd(), &mut stat) } != 0
        || stat.f_type != CGROUP2_SUPER_MAGIC
    {
        return Err(LinuxCgroupV2Blocker::NotCgroupV2Filesystem {
            root: root.to_owned(),
        });
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_cgroup_control_file(
    directory: &File,
    control_file: &'static str,
    flags: libc::c_int,
) -> io::Result<File> {
    let file_name = std::ffi::CString::new(control_file).expect("fixed cgroup file name");
    // SAFETY: directory is an owned cgroup directory FD; file_name is a fixed
    // NUL-terminated file name without path separators; openat never resolves
    // a replacement through the original path.
    let raw_fd = unsafe { libc::openat(directory.as_raw_fd(), file_name.as_ptr(), flags, 0) };
    if raw_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `raw_fd` is a successful openat result transferred to File.
    Ok(unsafe { File::from_raw_fd(raw_fd) })
}

/// Sends a signal to a dedicated Unix process group.
///
/// This is used only to demonstrate the failure mode. It must not be treated
/// as a production containment primitive for untrusted descendants.
pub fn signal_process_group(process_group_id: i32, signal: i32) -> io::Result<()> {
    if process_group_id <= 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "process group ID must be positive",
        ));
    }

    // SAFETY: a negative PID requests signal delivery to exactly the given
    // process group. The caller supplies a positive, fixture-owned PGID.
    if unsafe { libc::kill(-process_group_id, signal) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn process_group_id(pid: u32) -> io::Result<i32> {
    // SAFETY: getpgid reads the kernel's process-group table for this PID and
    // does not dereference caller-provided memory.
    let process_group_id = unsafe { libc::getpgid(pid as libc::pid_t) };
    if process_group_id >= 0 {
        Ok(process_group_id)
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn session_id(pid: u32) -> io::Result<i32> {
    // SAFETY: getsid reads the kernel's session table for this PID and does
    // not dereference caller-provided memory.
    let session_id = unsafe { libc::getsid(pid as libc::pid_t) };
    if session_id >= 0 {
        Ok(session_id)
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn is_process_alive(pid: u32) -> bool {
    // SAFETY: signal 0 asks the kernel to check PID visibility without sending
    // a signal. It is evidence only, never used to authorize a later kill.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
pub struct LinuxPidFd {
    raw_fd: libc::c_int,
}

#[cfg(target_os = "linux")]
impl LinuxPidFd {
    /// Acquires a stable reference to a currently visible process.
    ///
    /// Once this succeeds, `send_signal` targets this process rather than a
    /// later process that happens to reuse the same numeric PID. A real Host
    /// must acquire this for its direct child before it can be reaped. For a
    /// newly spawned direct child, `pidfd_open` is safe while the Host retains
    /// SIGCHLD ownership; `clone3(CLONE_PIDFD)` is stronger where available.
    pub fn open(pid: u32) -> io::Result<Self> {
        // SAFETY: syscall arguments follow pidfd_open(2): a PID and flags=0.
        let raw_fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0_u32) };
        if raw_fd >= 0 {
            Ok(Self {
                raw_fd: raw_fd as libc::c_int,
            })
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// Signals the process referred to by this file descriptor, not a numeric
    /// PID. If that process has exited, Linux returns ESRCH instead of
    /// delivering the signal to a reused PID.
    pub fn send_signal(&self, signal: i32) -> io::Result<()> {
        // SAFETY: syscall arguments follow pidfd_send_signal(2); a null
        // siginfo pointer requests ordinary SI_USER signal metadata.
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.raw_fd,
                signal,
                std::ptr::null_mut::<libc::siginfo_t>(),
                0_u32,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// Waits for process termination through the pidfd itself. This avoids a
    /// second PID lookup when checking whether the process exited.
    pub fn wait_for_exit(&self, timeout: std::time::Duration) -> io::Result<bool> {
        let timeout_ms = timeout.as_millis().min(i32::MAX as u128) as libc::c_int;
        let mut descriptor = libc::pollfd {
            fd: self.raw_fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: descriptor points to one initialized pollfd value for the
        // duration of the call, and the count matches that allocation.
        let result = unsafe { libc::poll(&mut descriptor, 1, timeout_ms) };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        if result == 0 {
            return Ok(false);
        }
        Ok((descriptor.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR)) != 0)
    }
}

#[cfg(target_os = "linux")]
impl Drop for LinuxPidFd {
    fn drop(&mut self) {
        // SAFETY: `raw_fd` is owned by this value and is closed exactly once
        // when the value is dropped.
        unsafe {
            let _ = libc::close(self.raw_fd);
        }
    }
}
