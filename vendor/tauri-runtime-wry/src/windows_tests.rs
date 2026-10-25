// Copyright 2026 Meetily - Actually Free contributors
// SPDX-License-Identifier: Apache-2.0 OR MIT

use super::*;
use std::{
  panic::{catch_unwind, AssertUnwindSafe},
  process::{Command, Stdio},
  sync::{atomic::AtomicUsize, Barrier},
  thread,
  time::{Duration, Instant},
};

// This !Send/!Sync witness is a field of the actual Arc payload, after the Tao
// target. Observing Wry's drop alone would miss a last owner retained by a worker.
pub(super) struct DropWitness {
  owner: ThreadId,
  drops: Arc<AtomicUsize>,
  on_drop: RefCell<Option<Box<dyn FnOnce()>>>,
}

impl DropWitness {
  pub(super) fn new() -> Self {
    Self {
      owner: current_thread().id(),
      drops: Arc::new(AtomicUsize::new(0)),
      on_drop: RefCell::new(None),
    }
  }
}

impl Drop for DropWitness {
  fn drop(&mut self) {
    assert_eq!(
      current_thread().id(),
      self.owner,
      "target dropped off-thread"
    );
    assert_eq!(self.drops.fetch_add(1, Ordering::SeqCst), 0);
    if let Some(on_drop) = self.on_drop.get_mut().take() {
      on_drop();
    }
    println!("WINDOWS_TARGET_DROPPED_ON_OWNER");
  }
}

fn observe_target(runtime: &Wry<()>) -> Arc<AtomicUsize> {
  let handle = runtime.handle();
  let weak = runtime.context.main_thread.window_target.clone();
  let proxy = runtime.event_loop.create_proxy();
  *runtime._window_target.drop_witness.on_drop.borrow_mut() = Some(Box::new(move || {
    assert!(weak.upgrade().is_none());
    assert_expired(&handle);
    // The native message target must still exist when our strong owner expires.
    // This catches moving event_loop out of Wry on the consuming run panic path.
    assert!(
      proxy
        .send_event(Message::Task(Box::new(|| panic!(
          "task ran during teardown"
        ))))
        .is_ok(),
      "native event loop was destroyed before its context owner expired"
    );
  }));
  runtime._window_target.drop_witness.drops.clone()
}

fn assert_expired(handle: &WryHandle<()>) {
  assert!(matches!(
    handle.run_on_main_thread(|| panic!("expired task ran")),
    Err(Error::EventLoopClosed)
  ));
  assert!(matches!(
    handle.cursor_position(),
    Err(Error::EventLoopClosed)
  ));
  assert!(matches!(
    handle.primary_monitor(),
    Err(Error::EventLoopClosed)
  ));
  assert!(matches!(
    handle.monitor_from_point(0.0, 0.0),
    Err(Error::EventLoopClosed)
  ));
  assert!(matches!(
    handle.available_monitors(),
    Err(Error::EventLoopClosed)
  ));
  assert!(matches!(
    handle.display_handle().unwrap().as_raw(),
    raw_window_handle::RawDisplayHandle::Windows(_)
  ));
}

#[test]
fn windows_target_lifecycle() {
  const SCENARIO: &str = "MEETILY_WRY_TEST_SCENARIO";
  if let Ok(scenario) = std::env::var(SCENARIO) {
    run_scenario(&scenario);
    return;
  }

  // Tao supports one event loop per process. Isolate native state and put a hard
  // bound on hangs, including synchronous queries waiting for a stopped pump.
  for scenario in [
    "never-run",
    "iterations",
    "concurrent",
    "panic-return",
    "panic-run",
    "panic-dispatch",
    "run-exit",
    "webview-ipc",
    "two-webview-ipc-stress",
  ] {
    let mut child = Command::new(std::env::current_exe().unwrap())
      .args([
        "--exact",
        "windows_tests::windows_target_lifecycle",
        "--nocapture",
        "--test-threads=1",
      ])
      .env(SCENARIO, scenario)
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
      .unwrap();
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut timed_out = false;
    while child.try_wait().unwrap().is_none() {
      if Instant::now() >= deadline {
        child.kill().unwrap();
        timed_out = true;
        break;
      }
      thread::sleep(Duration::from_millis(50));
    }
    let output = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    println!("{scenario}:\n{stdout}{stderr}");
    assert!(!timed_out, "{scenario} timed out");
    assert!(
      output.status.success(),
      "{scenario} failed: {}",
      output.status
    );
    assert!(
      stdout.contains("WINDOWS_TARGET_DROPPED_ON_OWNER"),
      "{scenario} skipped target destruction"
    );
  }
}

fn run_scenario(scenario: &str) {
  let mut runtime = Wry::<()>::new_any_thread(RuntimeInitArgs::default()).unwrap();
  let drops = observe_target(&runtime);
  let handle = runtime.handle();
  let weak = runtime.context.main_thread.window_target.clone();

  match scenario {
    "never-run" => {
      // Queue real Context-owning tasks without ever pumping them. Native loop
      // destruction must discard the queue while worker-held handles survive.
      let sender = handle.clone();
      thread::spawn(move || {
        for _ in 0..100 {
          let retained = sender.clone();
          sender
            .run_on_main_thread(move || {
              drop(retained);
              panic!("never-run task executed");
            })
            .unwrap();
        }
      })
      .join()
      .unwrap();
      drop(runtime);
    }
    "iterations" => {
      for _ in 0..3 {
        runtime.run_iteration(|_| {});
        assert!(weak.upgrade().is_some());
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        handle.run_on_main_thread(|| {}).unwrap();
      }
      drop(runtime);
    }
    "concurrent" => concurrent_runtime(runtime, drops.clone()),
    "panic-return" | "panic-run" | "panic-dispatch" => {
      // Wake GetMessage even when the Ready/setup callback panics during poll().
      handle.send_event(Message::UserEvent(())).unwrap();
      let consuming_run = scenario == "panic-run";
      let nested_dispatch = scenario == "panic-dispatch";
      let nested = handle.clone();
      let panicked = catch_unwind(AssertUnwindSafe(move || {
        let callback = move |event| {
          if matches!(event, RunEvent::Ready) {
            if nested_dispatch {
              nested
                .run_on_main_thread(|| panic!("intentional inline dispatch panic"))
                .unwrap();
            }
            panic!("intentional setup callback panic");
          }
        };
        if consuming_run {
          runtime.run(callback);
        } else {
          runtime.run_return(callback);
        }
      }));
      assert!(panicked.is_err(), "callback panic was swallowed");
    }
    "run-exit" => {
      handle.request_exit(0).unwrap();
      runtime.run(|_| {});
      panic!("Windows run returned instead of exiting");
    }
    "webview-ipc" => webview_ipc(runtime, drops.clone(), 1, 500),
    "two-webview-ipc-stress" => webview_ipc(runtime, drops.clone(), 2, 25_000),
    _ => panic!("unknown scenario {scenario}"),
  }

  assert_eq!(drops.load(Ordering::SeqCst), 1);
  assert!(weak.upgrade().is_none());
  assert_expired(&handle);
  // These are real runtime/context clones, not a model using a substitute Arc.
  thread::spawn(move || {
    for _ in 0..10_000 {
      drop(handle.clone());
      drop(handle.context.clone());
    }
    assert_expired(&handle);
  })
  .join()
  .unwrap();
}

struct QueryObserver {
  owner: ThreadId,
  queries: Arc<AtomicUsize>,
}

impl Plugin<()> for QueryObserver {
  fn on_event(
    &mut self,
    event: &Event<Message<()>>,
    _event_loop: &EventLoopWindowTarget<Message<()>>,
    _proxy: &TaoEventLoopProxy<Message<()>>,
    _control_flow: &mut ControlFlow,
    _context: EventLoopIterationContext<'_, ()>,
    _web_context: &WebContextStore,
  ) -> bool {
    if matches!(
      event,
      Event::UserEvent(Message::EventLoopWindowTarget(
        EventLoopWindowTargetMessage::PrimaryMonitor(_)
          | EventLoopWindowTargetMessage::MonitorFromPoint(_, _)
          | EventLoopWindowTargetMessage::AvailableMonitors(_)
      ))
    ) {
      assert_eq!(current_thread().id(), self.owner);
      self.queries.fetch_add(1, Ordering::SeqCst);
    }
    false
  }
}

fn concurrent_runtime(runtime: Wry<()>, drops: Arc<AtomicUsize>) {
  let queries = Arc::new(AtomicUsize::new(0));
  runtime
    .context
    .plugins
    .lock()
    .unwrap()
    .push(Box::new(QueryObserver {
      owner: current_thread().id(),
      queries: queries.clone(),
    }));
  let window = runtime
    .create_window(
      PendingWindow::new(WindowBuilderWrapper::new().visible(false), "native-test").unwrap(),
      None::<fn(RawWindow)>,
    )
    .unwrap();
  let handle = runtime.handle();
  let expected = format!("{:?}", runtime.available_monitors());
  assert_eq!(format!("{:?}", handle.available_monitors().unwrap()), expected);
  assert_eq!(
    format!("{:?}", handle.primary_monitor().unwrap()),
    format!("{:?}", runtime.primary_monitor())
  );
  assert_eq!(
    format!("{:?}", handle.monitor_from_point(0.0, 0.0).unwrap()),
    format!("{:?}", runtime.monitor_from_point(0.0, 0.0))
  );

  let start = Arc::new(Barrier::new(5));
  let completed = Arc::new(AtomicUsize::new(0));
  let released = Arc::new(AtomicBool::new(false));
  let owner = current_thread().id();
  let workers: Vec<_> = (0..4)
    .map(|_| {
      let handle = handle.clone();
      let window = window.clone();
      let start = start.clone();
      let completed = completed.clone();
      let released = released.clone();
      let drops = drops.clone();
      let expected = expected.clone();
      thread::spawn(move || {
        start.wait();
        for _ in 0..20_000 {
          drop(handle.clone());
          drop(window.clone());
          drop(handle.context.clone());
        }
        for _ in 0..8 {
          assert_eq!(format!("{:?}", handle.available_monitors().unwrap()), expected);
          let _ = handle.primary_monitor();
          let _ = handle.monitor_from_point(0.0, 0.0);
          // WindowDispatch already marshals to the UI thread, and its replies
          // carry converted Monitor values, not another event-loop/Rc owner.
          window.dispatcher.current_monitor().unwrap();
          window.dispatcher.primary_monitor().unwrap();
          window.dispatcher.monitor_from_point(0.0, 0.0).unwrap();
          assert_eq!(
            format!("{:?}", window.dispatcher.available_monitors().unwrap()),
            expected
          );
          handle.cursor_position().unwrap();
          let nested = handle.clone();
          handle
            .run_on_main_thread(move || {
              assert_eq!(current_thread().id(), owner);
              nested.run_on_main_thread(|| {}).unwrap();
            })
            .unwrap();
        }
        if completed.fetch_add(1, Ordering::SeqCst) == 3 {
          window.dispatcher.destroy().unwrap();
        }
        // Continue atomic weak refcount traffic across the owner's destruction.
        while !released.load(Ordering::SeqCst) {
          drop(handle.clone());
          drop(window.clone());
          thread::yield_now();
        }
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert_expired(&handle);
        assert!(matches!(
          window.dispatcher.primary_monitor(),
          Err(Error::EventLoopClosed)
        ));
      })
    })
    .collect();

  let windows = runtime.context.main_thread.windows.clone();
  assert_eq!(
    runtime.run_return(move |event| {
      if matches!(event, RunEvent::Ready) {
        start.wait();
      }
      for _ in 0..100 {
        drop(handle.clone());
        drop(window.clone());
      }
    }),
    0
  );
  assert!(
    windows.0.borrow().is_empty(),
    "native window did not finish destruction"
  );
  released.store(true, Ordering::SeqCst);
  for worker in workers {
    worker.join().unwrap();
  }
  assert_eq!(queries.load(Ordering::SeqCst), 4 * 8 * 3);
}

fn webview_ipc(runtime: Wry<()>, drops: Arc<AtomicUsize>, window_count: usize, messages: usize) {
  use tauri_runtime::webview::WebviewAttributes;
  use tauri_utils::config::WebviewUrl;

  assert!(
    runtime.context.webview_runtime_installed,
    "WebView2 is required for this native test"
  );
  let profile = std::env::current_exe()
    .unwrap()
    .parent()
    .unwrap()
    .join("runtime-test-webview-profile");
  let url = "runtimeprobe://localhost/";
  let (tx, rx) = channel();
  let mut test_windows = Vec::new();
  for index in 0..window_count {
    let label = format!("ipc-test-{index}");
    let attributes = WebviewAttributes::new(WebviewUrl::External(url.parse().unwrap()))
      .incognito(true)
      .data_directory(profile.clone());
    let mut webview = PendingWebview::new(attributes, label.clone()).unwrap();
    webview.url = url.into();
    webview.register_uri_scheme_protocol("runtimeprobe", move |_, _, respond| {
      let html = format!(
        "<!doctype html><html><body><script>let sent=0;function batch(){{for(let i=0;i<100&&sent<{messages};i++,sent++)window.ipc.postMessage('target-lifetime-test');if(sent<{messages})setTimeout(batch,0);}}batch();</script></body></html>"
      );
      respond(http::Response::builder()
        .header("Content-Type", "text/html")
        .body(std::borrow::Cow::Owned(html.into_bytes()))
        .unwrap());
    });
    let sender = tx.clone();
    webview.ipc_handler = Some(Box::new(move |webview, _request| {
      sender.send(webview).unwrap();
    }));
    let mut pending =
      PendingWindow::new(WindowBuilderWrapper::new().visible(false), label).unwrap();
    pending.set_webview(webview);
    test_windows.push(
      runtime
        .create_window(pending, None::<fn(RawWindow)>)
        .unwrap(),
    );
  }
  drop(tx);
  let released = Arc::new(AtomicBool::new(false));
  let worker_release = released.clone();
  let worker = thread::spawn(move || {
    for _ in 0..messages * window_count {
      let webview = rx.recv_timeout(Duration::from_secs(30)).unwrap();
      for _ in 0..100 {
        drop(webview.clone());
      }
      drop(webview);
    }
    for window in &test_windows {
      window.dispatcher.destroy().unwrap();
    }
    while !worker_release.load(Ordering::SeqCst) {
      for window in &test_windows {
        drop(window.clone());
      }
      thread::yield_now();
    }
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    for window in &test_windows {
      assert_expired(&WryHandle {
        context: window.dispatcher.context.clone(),
      });
    }
    println!(
      "Completed {} IPC messages across {window_count} webviews",
      messages * window_count
    );
  });
  let windows = runtime.context.main_thread.windows.clone();
  runtime.run_return(|_| {});
  assert!(
    windows.0.borrow().is_empty(),
    "WebView2 window did not finish destruction"
  );
  released.store(true, Ordering::SeqCst);
  worker.join().unwrap();
}
