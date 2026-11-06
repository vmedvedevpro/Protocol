//! Settings › AI agents (#8): whether `protocol-mcp` may read the meeting
//! library, and how Claude Code and Claude Desktop start it. The switch is a
//! file next to the database (`meeting_library::agent_access`) that the server
//! reads on every call, so the app needs no running state for it.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// The name clients list the server under.
const SERVER_NAME: &str = "protocol";
#[cfg(windows)]
const SERVER_FILE: &str = "protocol-mcp.exe";
#[cfg(not(windows))]
const SERVER_FILE: &str = "protocol-mcp";
/// `protocol --mcp-server` runs the server bundled beside the app (main.rs).
/// Only an AppImage needs it: its files live in a mount whose path changes on
/// every launch, while the AppImage file itself stays put.
pub const MCP_SERVER_ARG: &str = "--mcp-server";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccess {
    pub enabled: bool,
    pub database_path: String,
    /// What a client runs: the program and its arguments.
    pub command: String,
    pub args: Vec<String>,
    /// The server executable exists; a development build may lack it.
    pub server_found: bool,
    /// macOS runs an app opened from Downloads from a random read-only copy
    /// whose path changes on every launch: a command naming it would break.
    pub translocated: bool,
    pub claude_code_command: String,
    pub claude_desktop_config: String,
}

/// The program and arguments that start the server for this app.
fn launch(exe: &Path, appimage: Option<&Path>) -> (PathBuf, Vec<String>) {
    match appimage {
        Some(appimage) => (appimage.to_path_buf(), vec![MCP_SERVER_ARG.to_string()]),
        None => (
            exe.parent().unwrap_or(Path::new(".")).join(SERVER_FILE),
            Vec::new(),
        ),
    }
}

fn claude_code_command(command: &str, args: &[String]) -> String {
    let mut line = format!("claude mcp add --scope user {SERVER_NAME} -- \"{command}\"");
    for arg in args {
        line.push(' ');
        line.push_str(arg);
    }
    line
}

fn claude_desktop_config(command: &str, args: &[String]) -> String {
    let config = serde_json::json!({
        "mcpServers": { SERVER_NAME: { "command": command, "args": args } }
    });
    serde_json::to_string_pretty(&config).unwrap_or_default()
}

fn status_at(data_dir: &Path, exe: &Path, appimage: Option<&Path>) -> AgentAccess {
    let (program, args) = launch(exe, appimage);
    let command = program.to_string_lossy().into_owned();
    AgentAccess {
        enabled: meeting_library::agent_access::is_enabled(data_dir),
        database_path: data_dir.join("meeting_minutes.sqlite").to_string_lossy().into_owned(),
        server_found: program.is_file(),
        translocated: cfg!(target_os = "macos") && command.contains("/AppTranslocation/"),
        claude_code_command: claude_code_command(&command, &args),
        claude_desktop_config: claude_desktop_config(&command, &args),
        command,
        args,
    }
}

fn status() -> Result<AgentAccess, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let appimage = if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    } else {
        None
    };
    Ok(status_at(
        &crate::paths::install_data_root(),
        &exe,
        appimage.as_deref(),
    ))
}

#[tauri::command]
pub fn get_agent_access() -> Result<AgentAccess, String> {
    status()
}

#[tauri::command]
pub fn set_agent_access(enabled: bool) -> Result<AgentAccess, String> {
    meeting_library::agent_access::set_enabled(&crate::paths::install_data_root(), enabled)
        .map_err(|error| format!("Could not save the setting: {error}"))?;
    log::info!("AI agent access {}", if enabled { "on" } else { "off" });
    status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_builds_run_the_server_beside_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path().join("Program Files").join("Protocol");
        std::fs::create_dir_all(&install).unwrap();
        let exe = install.join("protocol.exe");
        let data = install.join("data");
        std::fs::create_dir_all(&data).unwrap();

        let off = status_at(&data, &exe, None);
        assert!(!off.enabled);
        assert!(!off.server_found);
        let server = install.join(SERVER_FILE).to_string_lossy().into_owned();
        assert_eq!(off.command, server);
        assert!(off.args.is_empty());
        assert_eq!(
            off.claude_code_command,
            format!("claude mcp add --scope user protocol -- \"{server}\"")
        );
        let config: serde_json::Value = serde_json::from_str(&off.claude_desktop_config).unwrap();
        assert_eq!(config["mcpServers"]["protocol"]["command"], server.as_str());
        assert_eq!(config["mcpServers"]["protocol"]["args"], serde_json::json!([]));

        std::fs::write(install.join(SERVER_FILE), b"").unwrap();
        meeting_library::agent_access::set_enabled(&data, true).unwrap();
        let on = status_at(&data, &exe, None);
        assert!(on.enabled && on.server_found);
        assert_eq!(
            on.database_path,
            data.join("meeting_minutes.sqlite").to_string_lossy()
        );
    }

    #[test]
    fn an_appimage_runs_itself_with_the_server_flag() {
        let dir = tempfile::tempdir().unwrap();
        let appimage = dir.path().join("Protocol.AppImage");
        std::fs::write(&appimage, b"").unwrap();
        let mounted = Path::new("/tmp/.mount_Protoc1/usr/bin/protocol");

        let status = status_at(dir.path(), mounted, Some(&appimage));
        let path = appimage.to_string_lossy().into_owned();
        assert_eq!(status.command, path);
        assert_eq!(status.args, vec!["--mcp-server".to_string()]);
        assert!(status.server_found);
        assert_eq!(
            status.claude_code_command,
            format!("claude mcp add --scope user protocol -- \"{path}\" --mcp-server")
        );
        let config: serde_json::Value = serde_json::from_str(&status.claude_desktop_config).unwrap();
        assert_eq!(config["mcpServers"]["protocol"]["args"], serde_json::json!(["--mcp-server"]));
    }
}
