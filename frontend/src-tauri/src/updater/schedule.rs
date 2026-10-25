//! When automatic checks run.
//!
//! A check is due 24 h after the last completed one. A failed check retries
//! after 1 h, then 2 h, 4 h and 6 h (cap). Both are wall-clock comparisons made
//! on a 10-minute tick, so sleep, hibernation and a tray app running for weeks
//! behave the same. The history is persisted, so restarts do not reset it.

use super::prefs::Prefs;
use std::time::Duration;

const HOUR_MS: i64 = 60 * 60 * 1000;
pub const CHECK_INTERVAL_MS: i64 = 24 * HOUR_MS;
const MAX_BACKOFF_MS: i64 = 6 * HOUR_MS;

/// The first evaluation after launch, so startup work and a just-relaunched
/// installer are out of the way.
pub const FIRST_TICK: Duration = Duration::from_secs(2 * 60);
pub const TICK: Duration = Duration::from_secs(10 * 60);

pub fn backoff_ms(failures: u32) -> i64 {
    if failures == 0 {
        return 0;
    }
    let doubled = HOUR_MS.saturating_mul(1i64 << failures.saturating_sub(1).min(16));
    doubled.min(MAX_BACKOFF_MS)
}

/// Timestamps from the future (the clock was moved back) are treated as "now",
/// so the next check is a full interval away instead of never, and never a loop.
pub fn normalize(prefs: &mut Prefs, now: i64) -> bool {
    let mut changed = false;
    for stamp in [&mut prefs.last_checked_at, &mut prefs.last_attempt_at] {
        if stamp.is_some_and(|value| value > now) {
            *stamp = Some(now);
            changed = true;
        }
    }
    changed
}

pub fn next_due(prefs: &Prefs, now: i64) -> i64 {
    if prefs.failures > 0 {
        if let Some(attempt) = prefs.last_attempt_at {
            return attempt.saturating_add(backoff_ms(prefs.failures));
        }
    }
    prefs
        .last_checked_at
        .map_or(now, |checked| checked.saturating_add(CHECK_INTERVAL_MS))
}

/// Whether an automatic check should run now. Support, onboarding and the
/// running operation are checked by the caller.
pub fn is_due(prefs: &Prefs, now: i64) -> bool {
    prefs.auto_check && now >= next_due(prefs, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefs(last_checked: Option<i64>, last_attempt: Option<i64>, failures: u32) -> Prefs {
        Prefs {
            auto_check: true,
            last_checked_at: last_checked,
            last_attempt_at: last_attempt,
            failures,
        }
    }

    #[test]
    fn never_checked_is_due_at_once() {
        assert!(is_due(&prefs(None, None, 0), 1_000));
    }

    #[test]
    fn due_24_hours_after_the_last_completed_check() {
        let checked = 1_000_000;
        let p = prefs(Some(checked), Some(checked), 0);
        assert!(!is_due(&p, checked + CHECK_INTERVAL_MS - 1));
        assert!(is_due(&p, checked + CHECK_INTERVAL_MS));
    }

    #[test]
    fn failures_back_off_1_2_4_then_6_hours() {
        assert_eq!(
            [1, 2, 3, 4, 5, 40].map(backoff_ms),
            [HOUR_MS, 2 * HOUR_MS, 4 * HOUR_MS, 6 * HOUR_MS, 6 * HOUR_MS, 6 * HOUR_MS]
        );
        let attempt = 5_000_000;
        let p = prefs(Some(1), Some(attempt), 2);
        assert!(!is_due(&p, attempt + 2 * HOUR_MS - 1));
        assert!(is_due(&p, attempt + 2 * HOUR_MS));
    }

    #[test]
    fn the_switch_turns_automatic_checks_off() {
        let mut p = prefs(None, None, 0);
        p.auto_check = false;
        assert!(!is_due(&p, i64::MAX / 2));
    }

    #[test]
    fn a_clock_moved_back_waits_one_interval_instead_of_forever() {
        let now = 10 * HOUR_MS;
        let mut p = prefs(Some(now + 100 * HOUR_MS), Some(now + 100 * HOUR_MS), 0);
        assert!(normalize(&mut p, now));
        assert_eq!(p.last_checked_at, Some(now));
        assert!(!is_due(&p, now + 1));
        assert!(is_due(&p, now + CHECK_INTERVAL_MS));
        assert!(!normalize(&mut p, now));
    }
}
