//! Save logs waits until every line logged so far is in the file (#234),
//! against a folder that already holds an earlier launch's save marker. Its
//! own test binary, since the log takes the process's one global logger.

use std::fs;
use std::time::{Duration, Instant};

#[test]
fn a_save_waits_for_its_own_lines_past_an_earlier_launchs_marker() {
    let dir = tempfile::tempdir().unwrap();
    // An earlier launch's file, which this launch continues, with that
    // launch's first save in it.
    let file = dir.path().join("protocol_r2026-01-01_00-00-00.log");
    fs::write(&file, "2026-01-01T00:00:00.000+00:00 INFO  app_lib::app_log: Saving the logs (process 1, save 1)\n").unwrap();
    app_lib::app_log::init_in(dir.path());

    for line in 0..300 {
        log::info!("line {line} before the save");
    }
    // The wait ends on this launch's own marker, well before the timeout; an
    // earlier launch's would end it at once, before the lines are written
    // (`app_log::tests` checks that one apart, since this writer is rarely
    // slow enough to show it).
    let started = Instant::now();
    app_lib::app_log::flush_and_wait(dir.path(), Duration::from_secs(10));
    assert!(started.elapsed() < Duration::from_secs(5), "the wait timed out without finding its marker");

    // Read before shutdown: what the wait promises is in the file already.
    let text = fs::read_to_string(&file).unwrap();
    app_lib::app_log::shutdown();
    let pid = std::process::id();
    assert!(text.contains("line 299 before the save"), "the wait returned before the last line");
    assert!(text.contains(&format!("Saving the logs (process {pid}, save 1)")));
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "the launch continued the earlier file");
}
