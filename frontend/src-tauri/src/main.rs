#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

// ggml-vulkan's direct Vulkan calls, answered here so the executable does not
// link `libvulkan.so.1` and starts without it (whisper_engine/vulkan.rs). In
// the binary, not the library: the linker takes them from an object file
// before it reaches `-lvulkan`, which `--as-needed` then drops.
#[cfg(all(target_os = "linux", feature = "vulkan"))]
app_lib::export_vulkan_symbols!();

// Before any static initializer, ggml's included: a processor ggml's
// x86-64-v3 build cannot run gets one plain message instead of an illegal
// instruction (cpu_support.rs).
app_lib::cpu_check_before_static_initializers!();

fn main() {
    // A short-lived copy of the app reports TCC's uncached Audio Capture status
    // (see audio/permissions.rs). Exit before logging or Tauri start.
    #[cfg(target_os = "macos")]
    if std::env::args().nth(1).as_deref() == Some(app_lib::audio::permissions::AUDIO_CAPTURE_STATUS_ARG) {
        app_lib::audio::permissions::print_audio_capture_status_and_exit();
    }

    // `"$APPIMAGE" --mcp-server`: an MCP client runs the meeting server
    // bundled beside the app (agent_access.rs). exec keeps this process, so
    // the AppImage mount lives as long as the server and stdio stays the
    // client's. Exit before logging, which would write to stdout.
    #[cfg(target_os = "linux")]
    if std::env::args().nth(1).as_deref() == Some(app_lib::agent_access::MCP_SERVER_ARG) {
        use std::os::unix::process::CommandExt;
        let server = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("protocol-mcp")));
        let Some(server) = server else {
            eprintln!("protocol: cannot find protocol-mcp next to this executable");
            std::process::exit(1);
        };
        let error = std::process::Command::new(&server)
            .args(std::env::args_os().skip(2))
            .exec();
        eprintln!("protocol: cannot start {}: {error}", server.display());
        std::process::exit(1);
    }

    // The log folder and stderr, before anything else logs (app_log/mod.rs).
    app_lib::app_log::init();
    app_lib::run();
}
