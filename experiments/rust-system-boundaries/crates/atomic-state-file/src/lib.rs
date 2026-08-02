//! Narrow state-file replacement primitive for the Rust system-boundaries spike.
//!
//! This crate owns only same-directory replacement mechanics. It has no
//! protocol, runtime, provider, or orchestration vocabulary.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static ATOMIC_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Replaces a same-directory state file without a remove-then-rename gap.
///
/// This is an evidence-harness primitive. It does not make an fsync or
/// power-loss durability claim. The temporary file always lives beside the
/// destination, so Windows replacement cannot silently cross volumes.
pub fn replace_file_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "atomic replacement target has no parent directory",
            )
        })?;
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "atomic replacement target has no file name",
        )
    })?;
    let temporary = create_temporary_file(parent, file_name, bytes)?;
    let result = replace_temporary_file(&temporary, path);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn create_temporary_file(
    parent: &Path,
    file_name: &std::ffi::OsStr,
    bytes: &[u8],
) -> io::Result<PathBuf> {
    for _ in 0..32 {
        let counter = ATOMIC_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(
            ".{}.{}.{}.tmp",
            file_name.to_string_lossy(),
            std::process::id(),
            counter
        ));
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes).and_then(|_| file.flush()) {
                    let _ = fs::remove_file(&temporary);
                    return Err(error);
                }
                return Ok(temporary);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique temporary state file",
    ))
}

#[cfg(windows)]
fn replace_temporary_file(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let temporary_wide = temporary
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        MoveFileExW(
            temporary_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_temporary_file(temporary: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(test)]
mod tests {
    use super::replace_file_atomically;

    #[test]
    fn atomic_replacement_repeatedly_overwrites_an_existing_state_file() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let path = temporary.path().join("state.json");
        for value in 0..32 {
            replace_file_atomically(&path, value.to_string().as_bytes())
                .expect("state replacement succeeds");
            assert_eq!(
                std::fs::read_to_string(&path).expect("replacement reads"),
                value.to_string()
            );
        }
    }
}
