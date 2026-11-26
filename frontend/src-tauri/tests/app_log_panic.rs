//! A panic reaches the app's log with its message and place (#234). Its own
//! test binary, since the log takes the process's one global logger.

use std::fs;

#[test]
fn a_panic_reaches_the_log_with_its_message_and_place() {
    let dir = tempfile::tempdir().unwrap();
    app_lib::app_log::init_in(dir.path());
    std::panic::set_hook(Box::new(|info| app_lib::app_log::record_panic(info)));

    let worker = std::thread::Builder::new()
        .name("worker".into())
        .spawn(|| panic!("boom at {}", 42))
        .unwrap();
    assert!(worker.join().is_err());
    let _ = std::panic::take_hook();
    app_lib::app_log::shutdown();

    let text: String = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|value| value == "log"))
        .map(|path| fs::read_to_string(path).unwrap())
        .collect();
    assert!(text.contains("INFO  app_lib::app_log: Protocol "), "{text}");
    let line = text
        .lines()
        .find(|line| line.contains("ERROR panic: thread 'worker' panicked at"))
        .unwrap_or_else(|| panic!("no panic line in {text}"));
    assert!(line.contains("app_log_panic.rs:") && line.ends_with(": boom at 42"), "{line}");
}
