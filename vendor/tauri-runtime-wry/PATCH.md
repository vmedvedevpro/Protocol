# Windows Event-Loop Target Ownership

This directory vendors the published `tauri-runtime-wry` 2.12.3 crate, not an
upstream development branch.

## Provenance

- Registry archive: `tauri-runtime-wry-2.12.3.crate`
- SHA-256: `e1aa9d8b7a120f879f44fdc1053f7b7dbf416bf0bbc6a72b714dec46b782b52f`
- Upstream commit: `993038c49185307dfc895ab7657d77ca0d5ed7c7`
- Upstream directory: `crates/tauri-runtime-wry`
- `LICENSE-APACHE-2.0`, `LICENSE-MIT`, and `.cargo_vcs_info.json` are unchanged.

The patch was first written against 2.11.4 (v0.2.14) and ported to 2.12.3 for
the Tauri 2.12 update (#33). Upstream had not fixed the race by then (checked
2026-10-26):

- https://github.com/tauri-apps/tauri/issues/15408 (open)
- https://github.com/tauri-apps/tauri/issues/15793 (closed as a duplicate of 15408)
- https://github.com/tauri-apps/tauri/issues/15785 (open)
- https://github.com/tauri-apps/tauri/pull/15411 (open, not merged)
- https://github.com/tauri-apps/tao/pull/1290 (closed without merging)

The local patch is Windows-only. It must not adopt the cross-platform raw display
handle lifetime extension in PR 15411 or change Tao's internal `Rc` to `Arc`.

### What 2.12 changed under the patch

- Upstream PR 15630 routes the runtime handle's monitor queries
  (`primary_monitor`, `monitor_from_point`, `available_monitors`) to the
  event-loop thread on every platform and makes them return `Result`. The 2.11.4
  patch had added Windows-only messages for the same purpose; they are dropped,
  and the upstream messages are used instead.
- Upstream PR 14805 moved the unsafe `Send`/`Sync` implementations from
  `DispatcherMainThreadContext` to `Context`. The patch's safety comments moved
  with them.
- `send_user_message` became a `Context` method, and `run`/`run_return` now move
  the `Context` into the event handler instead of borrowing `Wry`.

## Ownership Contract

`Wry` owns one strong `Arc<WindowsWindowTarget<T>>`. Its payload owns the Tao
target cloned at initialization, on the event-loop creation thread. `Wry` remains
neither Send nor Sync. The target field precedes event_loop, so dispatch expires
before native event-loop teardown can reenter. It also precedes context, so in
never-run and run_iteration destruction dispatch expires before the context is
torn down; `run`/`run_return` instead hand the context to Tao, which drops it
while the owner and the native loop are still alive (see below).

Every cloned Windows context contains only a private `std::sync::Weak` to that
payload. Context/dispatcher/runtime-handle cloning and destruction on workers
therefore change atomic weak counts, never Tao's inner non-atomic Rc counts.
Final weak deallocation on a worker cannot run the already-destroyed payload's
destructor. The existing unsafe context Send/Sync implementations are retained;
no new unsafe implementations or raw access were introduced.

The sole production upgrade is in `Context::send_user_message`, after comparing
the current Rust ThreadId to the event-loop creation ThreadId. The upgraded Arc
is local to synchronous dispatch and cannot escape through a public
field/accessor. The worker branch only reads atomic liveness metadata and sends a
proxy message. The metadata check is not a shutdown barrier: an in-flight send
can race loop closure and remains subject to the existing proxy/channel error
behavior.

Runtime-handle monitor queries go to the event-loop thread through upstream's
messages and return owned `Monitor` values. After owner destruction they fail
with `EventLoopClosed`; a reply lost when the loop closes maps to
`FailedToReceiveMessage`, except in upstream's `WryHandle::monitor_from_point`,
which unwraps its reply. Wry's own monitor and cursor queries borrow its
event_loop directly (`Wry::window_target`).

`DisplayHandle::windows()` is a safe, pointer-free constructor from the locked
raw-window-handle 0.6.2 dependency. It remains valid after Wry is destroyed and
does not require an upgrade, a raw handle message, or a fabricated lifetime. It
does not provide or extend the lifetime of an HWND.

## Run And Shutdown Semantics

Windows `run` calls the existing `run_return`, then exits the process with its
returned code. It still does not return normally. This deliberately runs Wry's
field destructors before process exit; upstream's consuming Tao run moves
event_loop out of Wry and can exit without dropping it. More importantly, a
callback/setup panic now unwinds with event_loop still inside Wry, behind the
target owner, instead of destroying a moved-out native event_loop before the
owner. Panics are not swallowed.

`run_return` moves the context into the event handler. Tao drops that handler
when its loop ends (`reset_runner`, also before resuming a callback panic), while
the target owner and the native loop still exist; Wry's remaining fields then
drop in declaration order, target owner first. The same field order handles
never-run destruction. run_iteration does not revoke the owner: the runtime
remains usable between iterations. No target is leaked, and no destructor is
queued onto a possibly stopped loop.

## Scope And Limitations

- Non-Windows ownership, monitor calls, display handles, and run behavior remain
  unchanged. This patch does not fix X11/Wayland display connection lifetimes.
- Windows runtime `tracing` is rejected at compile time. ActiveTraceSpanStore
  still contains another Rc cloned through the Send context. Enabling tracing
  requires a separate ownership fix, not removal of this guard. Application use
  of the tracing crate is distinct from tauri/tauri-runtime-wry's tracing feature.
- A worker monitor query requires a pumping event loop. Never join a worker
  waiting for such a query from the UI thread, or call it before starting the
  loop and synchronously wait on that worker. Main-thread queries remain inline.
- Routed tasks/getters fail closed after owner destruction. Raw public event
  proxies and the preexisting direct request_exit/send_event APIs retain their
  upstream lifecycle behavior; this is not a redesign of every shutdown API.
- Existing WindowsStore/WebContext sharing, public low-level context surfaces,
  and the borrowed window-handle API are outside this target-ownership fix. This
  is not a soundness certification of the entire upstream runtime.
- Inherited upstream panic paths (not reached by Protocol's code): the
  event-loop reply handlers (monitors, cursor position) unwrap their reply send,
  so a message carrying an already dropped receiver panics the UI thread. The
  typed getters always wait for the reply; only raw senders
  (`WryHandle::send_event`, the public `Context::proxy`) could deliver such a
  message. On the worker side, upstream's `WryHandle::monitor_from_point` unwraps
  its reply, so a shutdown race that discards the queued message panics the
  calling thread (the 2.11.4 patch returned `None`; `create_tao_window` already
  had the same pattern). Protocol queries monitors through window dispatchers,
  which return an error instead. The 2.11.4 regression for a discarded receiver
  was removed with the patch's own messages.
- WindowDispatch monitor getters marshal through WindowMessage, and their replies
  already carry converted `Monitor` values, not Tao handles or an
  EventLoopWindowTarget.
- The application source, audio pipeline, minibar polling, and Tao are unmodified.
  History of the 2.11.4 patch: a full CUDA/custom-protocol application build
  passed; the reporting user tried that patched build, said it worked fine so far,
  and authorized the v0.2.14 release. Trial duration is unconfirmed; no completed
  multi-hour recording soak is claimed for either version. Long-duration field
  validation remains outstanding.

## Regression Tests

`src/windows_tests.rs` is explicitly registered as a Windows-only unit-test
module from lib.rs, despite the published manifest's `autotests = false`.
Each native scenario runs in its own subprocess (Tao supports one event loop per
process), with a 90-second parent timeout. No installed application is launched.

The real target Arc payload contains a test-only !Send/!Sync DropWitness, after
the Tao target. It asserts owner-thread, exactly-once destruction and observes
that the weak target has expired while the native message target still exists.
Worker-held real WryHandle/Context/DetachedWindow clones survive runtime teardown.
This tests the actual runtime ownership, not just an Arc/Weak stand-in.

Scenarios cover never-run queued tasks; repeated run_iteration; four concurrent
clone/drop workers with native hidden-window teardown; all three worker monitor
queries observed on the UI thread; worker WindowDispatch monitor getters; nested
inline dispatch (including panic with an upgraded owner in scope); run_return
and consuming run setup-panic unwinding; normal run process exit; 500 real
hidden-WebView2 IPC messages; and a two-WebView stress case with 50,000 IPC
messages and five million background webview clones/drops. After owner
destruction every routed handle query, including the three monitor queries,
must fail with `EventLoopClosed`.
The pages send messages in asynchronous batches through an in-process custom
protocol, never the network. Incognito profiles live under the isolated test
target dir. These are synthetic windows, not recordings of user audio.
Three compile-fail doctests cover target privacy and Wry's !Send/!Sync properties.

Not covered: worker-side `create_window`/`create_webview`, which 2.12 makes
wait for the UI thread's reply, across owner expiry, and a lost
`monitor_from_point` reply.

These are short deterministic lifecycle/traffic tests, not a multi-hour race
proof or an end-to-end Meetily recording test. They require a Windows desktop
and installed WebView2. Expected panic-scenario diagnostics appear on stderr.
They do not exercise Tauri AppManager's full protocol/responder integration,
multi-hour minibar churn, audio finalization, or non-Windows native libraries.

Run from the workspace root using the local MSVC-only wrapper (no CUDA/app build
helper). Build output is isolated in this vendor directory's ignored `target/`:

```text
vendor\tauri-runtime-wry\check-windows.cmd check --offline --locked -p tauri-runtime-wry
vendor\tauri-runtime-wry\check-windows.cmd test --offline --locked -p tauri-runtime-wry --lib windows_tests::windows_target_lifecycle -- --nocapture --test-threads=1
vendor\tauri-runtime-wry\check-windows.cmd test --offline --locked -p tauri-runtime-wry --doc
vendor\tauri-runtime-wry\check-windows.cmd check --offline --locked -p tauri-runtime-wry --features common-controls-v6,macos-private-api
vendor\tauri-runtime-wry\check-windows.cmd test --offline --locked --release -p tauri-runtime-wry --lib windows_tests::windows_target_lifecycle -- --nocapture --test-threads=1
vendor\tauri-runtime-wry\check-windows.cmd test --offline --locked --release -p tauri-runtime-wry --features devtools --doc
cargo tree --offline --locked -i tauri-runtime-wry -e features
```

`check-windows.cmd` calls `cargo` from `PATH`. In a shell started before the
Rust toolchain was installed, run the same cargo arguments through the
machine's native-environment helper with `CARGO_TARGET_DIR` set to this
directory's `target`.

Use the separate release lib/doc commands above. An aggregate `test --release`
without devtools passes the native tests but fails rustdoc's crate checking with
E0407: rustdoc selects the upstream debug-assertions-gated devtools methods while
the release tauri-runtime dependency omits them. RUSTDOCFLAGS disabling debug
assertions did not fix that on this toolchain. Explicit devtools for the doc-only
invocation aligns both existing trait surfaces; all three release doctests then
pass. This does not change the app's enabled features or production code.

The negative check below must fail with the explicit Windows tracing diagnostic,
not a dependency-resolution or compiler setup error:

```text
vendor\tauri-runtime-wry\check-windows.cmd check --offline --locked -p tauri-runtime-wry --features tracing
```

Release tests with `common-controls-v6` also need the activation manifest normally
embedded by Tauri's application build. Without it, the standalone test EXE fails
before main with 0xc0000139 because upstream release dialogs import
TaskDialogIndirect. The following PowerShell setup supplies that manifest only
to test builds; it does not change the runtime source or application build:

```powershell
$env:CARGO_ENCODED_RUSTFLAGS = @(
  '-C', 'link-arg=/MANIFEST:EMBED',
  '-C', "link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
) -join [char]31
.\vendor\tauri-runtime-wry\check-windows.cmd test --offline --locked --release -p tauri-runtime-wry --features common-controls-v6,macos-private-api --lib windows_tests::windows_target_lifecycle -- --nocapture --test-threads=1
```

Use that environment only for the package test invocation, not an application
build. Nine native subprocess scenarios pass with these release/app feature
settings. The same scenarios also run with the package's default features.

The workspace root owns the crates.io path patch and lockfile. The vendor is a
workspace member so package-only feature tests can use that same lock; explicit
default-members preserve the original application/helper build selection.
Root Cargo.lock removes this package's source/checksum and records its existing
optional tracing edge plus wry's existing optional tracing edge, as required by
Cargo's workspace-member feature resolution. This does not enable runtime
tracing in the app. The vendor's published Cargo.lock is preserved as upstream
provenance and is not the application workspace lockfile.

## Local Verification

2.12.3 port, verified 2026-10-26 on Windows x64 with rustc/Cargo 1.99.1 and the
VS 2022 Build Tools vcvars64 environment: the package check (also with
`common-controls-v6,macos-private-api`), the nine native scenarios in debug,
release, and release with the app's features and the manifest above, and the
three compile-fail doctests (debug, and release with devtools) passed. The
Windows tracing negative check failed at the explicit guard. The app's
dependency tree resolves this vendored package with the `common-controls-v6`,
`dbus`, `macos-private-api`, and `x11` features and no runtime tracing. Every
file other than `src/lib.rs` and the added `src/windows_tests.rs`, `PATCH.md`,
and `check-windows.cmd` matches the registry archive above (compared ignoring
line endings, which Git converts in a Windows checkout).

The 2.11.4 patch also had independent read-only reviews, which found no new
blocker in the bounded target-ownership fix; their concern about WindowDispatch
monitor payload ownership was resolved by checking Tao's Windows isize-only
handle. An independent read-only review of the 2.12.3 port (2026-10-26) found
no defect: no worker-side path reaches the Tao target, tauri 2.12.5 and the
plugins use only `Wry`, `WryHandle`, `create_tao_window`, raw `send_event` and
`wry_plugin`, and the owner still expires before the native loop in every exit
and unwind path. Its notes are reflected above (inherited panic paths, test
gaps).

Remove this override only after an upstream release provides equivalent
thread-affine target ownership, safe Windows display handles, and unwind-safe
destruction, and these regressions pass against that release.
