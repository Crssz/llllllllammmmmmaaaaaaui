use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

/// Mutex helper that recovers from poison rather than panicking. A poisoned
/// mutex means a thread panicked while holding the lock, but the data inside
/// is usually still consistent for our use cases (process state, sysinfo
/// cache). We log and continue instead of taking down the app.
pub fn lock_or_poisoned<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| {
        log::error!("mutex poisoned, recovering inner state");
        p.into_inner()
    })
}

/// Canonicalize a user-supplied directory string and verify it resolves to a
/// directory. Rejects non-existent paths and any path traversal escapes that
/// would resolve outside the expected tree (we don't whitelist a parent here —
/// we just refuse symlink chains that don't ultimately point at a directory).
pub fn canonical_dir(input: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(input);
    let canonical = fs::canonicalize(&p).map_err(|e| format!("canonicalize {input}: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {}", canonical.display()));
    }
    Ok(canonical)
}

pub fn chrono_now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Push a directory into recents — de-duplicate, most-recent-first, max 5.
pub fn push_recent(mut dirs: Vec<String>, dir: &str) -> Vec<String> {
    dirs.retain(|d| d != dir);
    dirs.insert(0, dir.to_string());
    let mut q: VecDeque<String> = dirs.into();
    while q.len() > 5 {
        q.pop_back();
    }
    q.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn push_recent_dedupes_and_caps_at_five() {
        let mut v: Vec<String> = vec![];
        for name in ["a", "b", "c", "d", "e", "f"] {
            v = push_recent(v, name);
        }
        assert_eq!(v.len(), 5);
        // Most recent first
        assert_eq!(v[0], "f");
        // Pushing an existing entry moves it to the front
        v = push_recent(v, "c");
        assert_eq!(v[0], "c");
        assert_eq!(v.len(), 5);
    }

    #[test]
    fn push_recent_keeps_order_for_short_lists() {
        let v = push_recent(push_recent(vec![], "a"), "b");
        assert_eq!(v, vec!["b".to_string(), "a".to_string()]);
    }

    #[test]
    fn canonical_dir_rejects_nonexistent() {
        let err = canonical_dir("Z:/definitely-does-not-exist-lllammmui-test");
        assert!(err.is_err());
    }

    #[test]
    fn canonical_dir_accepts_existing_dir() {
        let tmp = std::env::temp_dir();
        let s = tmp.to_string_lossy().into_owned();
        let canonical = canonical_dir(&s).expect("temp dir should be canonicalizable");
        assert!(canonical.is_dir());
    }

    #[test]
    fn lock_or_poisoned_recovers_from_panic() {
        let m = Arc::new(Mutex::new(42_u32));
        let m2 = m.clone();
        let _ = thread::spawn(move || {
            let _guard = m2.lock().unwrap();
            panic!("poison the mutex");
        })
        .join();
        let guard = lock_or_poisoned(&m);
        assert_eq!(*guard, 42);
    }

    #[test]
    fn chrono_now_millis_is_positive_and_monotonic_ish() {
        let a = chrono_now_millis();
        let b = chrono_now_millis();
        assert!(a > 0);
        assert!(b >= a);
    }
}
