//! Crash-safe JSON stores in the app-data directory (`settings.json`,
//! `chats.json`, `bench_runs.json`).
//!
//! All three stores shared the same two ways of destroying user data, so the
//! fix lives here once and each store calls it:
//!
//! * **Torn writes.** `fs::write` truncates the destination and *then* streams
//!   the new bytes into it. A crash, a power loss or a full disk in between
//!   leaves a truncated — and therefore unparseable — file where the user's
//!   chats or settings used to be. [`atomic_write`] fills a sibling temp file,
//!   syncs it, and renames it over the destination, so a later reader sees
//!   either the complete old file or the complete new one and never a
//!   half-written one.
//!
//! * **Silent clobbering.** A store that exists but does not parse used to
//!   surface as an error the callers turned straight into defaults: the app
//!   rendered as a pristine first run and the very next save buried the real
//!   data under those defaults. [`load_json`] renames the unreadable file
//!   aside first (`chats.json` → `chats.corrupt-1.json`) and returns an error
//!   naming that path, so the data survives even when a caller ignores the
//!   error, and the UI can tell the user exactly where it went.
//!
//! A *missing* file is not corruption — it is a legitimate first run, and stays
//! silent ([`load_json`] returns `Ok(None)`).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::de::DeserializeOwned;

use crate::util::lock_or_poisoned;

/// How many `*.corrupt-N.*` slots to try before giving up. Reaching this means
/// something is repeatedly writing garbage; failing loudly beats spinning.
const MAX_QUARANTINE_SLOTS: u32 = 1000;

/// Write `contents` to `path` atomically.
///
/// The bytes go into a temp file **in the same directory** (`fs::rename` is
/// only atomic within one filesystem, so a global temp dir would silently
/// degrade to a copy) which is then synced and renamed over `path`.
///
/// `fs::rename` replaces an existing destination on Windows as well as on Unix
/// (it maps to `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`), so no
/// delete-then-rename dance is needed — that dance is precisely the window this
/// function exists to remove. The rename can still fail, though (an antivirus
/// scanner or another handle can hold the destination open on Windows), so its
/// result is checked rather than assumed: on failure the temp file is removed
/// and the previous `path` is left exactly as it was.
pub fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = temp_sibling(path)?;
    if let Err(e) = write_synced(&tmp, contents) {
        // Half-written temp files must not accumulate in the app-data dir, so
        // clean up on every failure path — including a disk-full error, where
        // the leftover would also be holding onto space.
        let _ = fs::remove_file(&tmp);
        return Err(format!("write {}: {e}", tmp.display()));
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            path.display()
        ));
    }
    Ok(())
}

/// Fill `tmp` and push it all the way to the device.
///
/// The `sync_all` is the load-bearing step: without it the rename can be
/// recorded while the file's bytes are still sitting in the OS cache, so a
/// crash right after publishes an *empty* file over the good one — a more
/// thorough version of the bug this module removes. (`flush` on a `File` is a
/// formality — there is no userspace buffer — but it keeps the intent explicit
/// and stays correct if the writer type ever changes.)
fn write_synced(tmp: &Path, contents: &str) -> std::io::Result<()> {
    let mut f = File::create(tmp)?;
    f.write_all(contents.as_bytes())?;
    f.flush()?;
    f.sync_all()
}

/// Build the temp path used by [`atomic_write`]: same directory, name derived
/// from the target, unique per process and per call so two writers racing on
/// one store cannot scribble into each other's temp file.
fn temp_sibling(path: &Path) -> Result<PathBuf, String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = path
        .parent()
        .ok_or_else(|| format!("no parent directory for {}", path.display()))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("unusable file name: {}", path.display()))?;
    let pid = std::process::id();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    Ok(dir.join(format!("{name}.{pid}.{seq}.tmp")))
}

/// Read and parse a JSON store, quarantining it when it exists but cannot be
/// used.
///
/// * missing file → `Ok(None)`, silently. This is a first run; the caller
///   substitutes its own default.
/// * unreadable bytes, invalid UTF-8, malformed JSON, or a shape that no longer
///   deserializes → the file is renamed aside and an `Err` naming the
///   quarantine path is returned. There is real user data on disk that we
///   cannot understand, and handing back a default would let the next save
///   overwrite it.
pub fn load_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            // "Missing" is decided from the read error rather than a prior
            // `exists()` check so the two can't disagree. If we are the ones
            // who moved it aside this run, missing is our own doing and must
            // keep reporting the failure — see `replay_quarantine`.
            return match replay_quarantine(path) {
                Some(msg) => Err(msg),
                None => Ok(None),
            };
        }
        Err(e) => return Err(quarantine_and_explain(path, &format!("read: {e}"))),
    };
    match serde_json::from_str(&raw) {
        Ok(parsed) => Ok(Some(parsed)),
        Err(e) => Err(quarantine_and_explain(path, &format!("parse: {e}"))),
    }
}

/// Move an unusable store aside and build the message the user sees.
///
/// The quarantine path is part of the message on purpose: the frontend renders
/// the error verbatim, so naming the file is what turns "your settings are
/// gone" into "your settings are in this file".
fn quarantine_and_explain(path: &Path, cause: &str) -> String {
    let msg = match quarantine(path) {
        Ok(saved) => format!(
            "{cause} — the unreadable file was moved aside to {} and is recoverable there",
            saved.display()
        ),
        Err(e) => format!(
            "{cause} — the unreadable file at {} could NOT be moved aside ({e}); \
             repair it by hand before saving anything",
            path.display()
        ),
    };
    remember_quarantine(path, &msg);
    msg
}

/// Rename `path` to the first free `<stem>.corrupt-<n>.<ext>` beside it and
/// return that path.
///
/// Numbering starts at 1 and never reuses a taken slot, so a second corruption
/// lands in `corrupt-2` and the evidence from the first is preserved intact.
fn quarantine(path: &Path) -> Result<PathBuf, String> {
    for n in 1..=MAX_QUARANTINE_SLOTS {
        let target = quarantine_target(path, n)?;
        // `create_new` reserves the name atomically — it fails if anything is
        // already there. An `exists()` test followed by a rename would instead
        // leave a window in which two callers pick the same free slot and the
        // second silently destroys the first one's evidence.
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(_) => {
                if let Err(e) = fs::rename(path, &target) {
                    // Give the reserved slot back so the next attempt reuses it
                    // instead of leaving an empty file and skipping the index.
                    let _ = fs::remove_file(&target);
                    return Err(format!(
                        "rename {} -> {}: {e}",
                        path.display(),
                        target.display()
                    ));
                }
                return Ok(target);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("create {}: {e}", target.display())),
        }
    }
    Err(format!(
        "{} quarantine slots beside {} are all taken",
        MAX_QUARANTINE_SLOTS,
        path.display()
    ))
}

/// `chats.json` + 1 → `chats.corrupt-1.json`. Extension-less stores just get
/// the suffix appended.
fn quarantine_target(path: &Path, n: u32) -> Result<PathBuf, String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("no parent directory for {}", path.display()))?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("unusable file name: {}", path.display()))?;
    Ok(match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => dir.join(format!("{stem}.corrupt-{n}.{ext}")),
        None => dir.join(format!("{stem}.corrupt-{n}")),
    })
}

/// Stores quarantined during this process run, keyed by store path, with the
/// message every later load of that same path replays.
///
/// Without this the *second* load of a corrupt store would look like a clean
/// first run — we already renamed the file away, so the read reports
/// `NotFound`. That is not hypothetical: `lib.rs`'s setup hook calls
/// `load_settings` before the window exists and discards the error, so the
/// frontend's own load would come second, see nothing wrong, render a pristine
/// first run and save a fresh file — leaving the user's real settings sitting
/// in a quarantine file nobody ever told them about. Replaying the message
/// keeps every consumer informed for the life of the process.
fn quarantined_stores() -> &'static Mutex<HashMap<PathBuf, String>> {
    static STORES: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();
    STORES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_quarantine(path: &Path, msg: &str) {
    lock_or_poisoned(quarantined_stores()).insert(path.to_path_buf(), msg.to_string());
}

fn replay_quarantine(path: &Path) -> Option<String> {
    lock_or_poisoned(quarantined_stores()).get(path).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh, uniquely named directory per test — the suite is threaded, and
    /// the quarantine bookkeeping is keyed by path.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lmst-jsonstore-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn atomic_write_round_trips_and_leaves_no_temp_file() {
        let dir = temp_dir("roundtrip");
        let p = dir.join("chats.json");
        atomic_write(&p, r#"["a","b"]"#).unwrap();

        let back: Vec<String> = load_json(&p).unwrap().expect("file is present");
        assert_eq!(back, vec!["a".to_string(), "b".to_string()]);
        // The temp file must be gone — a leftover would be indistinguishable
        // from a crashed write and would accumulate on every save.
        assert_eq!(names(&dir), vec!["chats.json".to_string()]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_replaces_an_existing_file_in_place() {
        let dir = temp_dir("replace");
        let p = dir.join("settings.json");
        atomic_write(&p, r#"{"a":1}"#).unwrap();
        atomic_write(&p, r#"{"a":2}"#).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), r#"{"a":2}"#);
        assert_eq!(names(&dir), vec!["settings.json".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_is_a_silent_first_run_not_a_quarantine() {
        let dir = temp_dir("missing");
        let p = dir.join("chats.json");
        let loaded: Option<Vec<String>> = load_json(&p).unwrap();
        assert!(loaded.is_none());
        // Nothing was created, and above all nothing was quarantined.
        assert!(names(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_quarantined_with_its_content_intact_and_defaults_follow() {
        let dir = temp_dir("corrupt");
        let p = dir.join("chats.json");
        fs::write(&p, r#"[{"id":"c1","tit"#).unwrap();

        let err = load_json::<Vec<String>>(&p).unwrap_err();
        let saved = dir.join("chats.corrupt-1.json");
        // The error has to name the quarantine path — that string is what the
        // UI shows the user.
        assert!(
            err.contains(&saved.display().to_string()),
            "error should name the quarantine path, got: {err}"
        );
        assert!(saved.exists());
        // Byte-for-byte: the point of quarantining is preserving evidence.
        assert_eq!(fs::read_to_string(&saved).unwrap(), r#"[{"id":"c1","tit"#);
        assert!(!p.exists(), "the corrupt file is moved, not copied");

        // Only now may a caller fall back to defaults and save them — the write
        // lands on a fresh file and cannot touch the quarantined one.
        atomic_write(&p, "[]").unwrap();
        assert_eq!(fs::read_to_string(&saved).unwrap(), r#"[{"id":"c1","tit"#);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_corruption_takes_the_next_slot_and_keeps_the_first() {
        let dir = temp_dir("second");
        let p = dir.join("chats.json");

        fs::write(&p, "first-garbage").unwrap();
        load_json::<Vec<String>>(&p).unwrap_err();
        fs::write(&p, "second-garbage").unwrap();
        let err = load_json::<Vec<String>>(&p).unwrap_err();

        let first = dir.join("chats.corrupt-1.json");
        let second = dir.join("chats.corrupt-2.json");
        assert!(err.contains(&second.display().to_string()), "got: {err}");
        // The earlier evidence survives untouched — overwriting it would
        // destroy exactly the data quarantining is meant to save.
        assert_eq!(fs::read_to_string(&first).unwrap(), "first-garbage");
        assert_eq!(fs::read_to_string(&second).unwrap(), "second-garbage");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_load_after_quarantine_replays_the_failure_instead_of_faking_a_first_run() {
        let dir = temp_dir("replay");
        let p = dir.join("settings.json");
        fs::write(&p, "not json").unwrap();

        let first = load_json::<serde_json::Value>(&p).unwrap_err();
        // The file is gone now (renamed aside), so a naive second load would
        // report a clean first run and let the caller save over the top.
        let second = load_json::<serde_json::Value>(&p).unwrap_err();
        assert_eq!(first, second);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_utf8_counts_as_corruption() {
        let dir = temp_dir("utf8");
        let p = dir.join("chats.json");
        fs::write(&p, [0xff_u8, 0xfe, 0x00]).unwrap();

        let err = load_json::<Vec<String>>(&p).unwrap_err();
        assert!(err.starts_with("read: "), "got: {err}");
        assert!(dir.join("chats.corrupt-1.json").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn quarantine_target_keeps_the_extension_and_handles_bare_names() {
        let dir = PathBuf::from("C:/data");
        assert_eq!(
            quarantine_target(&dir.join("chats.json"), 1).unwrap(),
            dir.join("chats.corrupt-1.json")
        );
        assert_eq!(
            quarantine_target(&dir.join("bench_runs.json"), 12).unwrap(),
            dir.join("bench_runs.corrupt-12.json")
        );
        assert_eq!(
            quarantine_target(&dir.join("store"), 3).unwrap(),
            dir.join("store.corrupt-3")
        );
    }

    #[test]
    fn temp_sibling_stays_in_the_target_directory() {
        let p = PathBuf::from("C:/data/chats.json");
        let a = temp_sibling(&p).unwrap();
        let b = temp_sibling(&p).unwrap();
        assert_eq!(a.parent(), p.parent(), "rename is only atomic in-place");
        assert_ne!(a, b, "concurrent writers must not share a temp file");
        for t in [&a, &b] {
            let name = t.file_name().unwrap().to_string_lossy().into_owned();
            assert!(name.starts_with("chats.json."), "got: {name}");
            assert!(name.ends_with(".tmp"), "got: {name}");
        }
    }
}
