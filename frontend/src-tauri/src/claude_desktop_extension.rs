//! Settings > AI agents > Add to Claude Desktop (#8): a Claude Desktop
//! extension (`.mcpb`, manifest 0.3) that runs the protocol-mcp installed
//! beside this app. The bundle holds only its manifest and icon, so the server
//! stays the installed one and Protocol's updates update it too. Claude
//! Desktop keeps its own copy of the manifest with this path in it: after
//! Protocol moves, the extension has to be added again, and the path last
//! added is kept to say so.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

const BUNDLE_FILE: &str = "Protocol.mcpb";
/// What was last added, next to the database it serves.
const ADDED_FILE: &str = "claude-desktop-extension.json";
const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");
const REPOSITORY: &str = "https://github.com/vmedvedevpro/Protocol";

/// Claude Desktop runs on Windows and macOS only.
pub const SUPPORTED: bool = cfg!(any(windows, target_os = "macos"));

#[derive(Debug, Serialize, Deserialize)]
struct Added {
    command: String,
}

/// The extension was added for a server path that is no longer this app's.
pub fn moved(data_dir: &Path, command: &str) -> bool {
    std::fs::read(data_dir.join(ADDED_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Added>(&bytes).ok())
        .is_some_and(|added| added.command != command)
}

pub fn manifest(version: &str, command: &str, args: &[String]) -> serde_json::Value {
    let tools: Vec<serde_json::Value> = meeting_library::agent_access::TOOLS
        .iter()
        .map(|(name, description)| serde_json::json!({ "name": name, "description": description }))
        .collect();
    let platform = if cfg!(target_os = "macos") { "darwin" } else { "win32" };
    serde_json::json!({
        "manifest_version": "0.3",
        "name": "protocol",
        "display_name": "Protocol",
        "version": version,
        "description": "Read-only access to the meetings you recorded in Protocol: transcripts, summaries, notes, action items, people and groups.",
        "long_description": "Claude can list, search and read the meetings on this computer while Protocol > Settings > AI agents is on. It cannot change anything or play audio. Whatever Claude reads is sent to Anthropic under your account.",
        "author": { "name": "vmedvedevpro", "url": "https://github.com/vmedvedevpro" },
        "repository": { "type": "git", "url": REPOSITORY },
        "homepage": REPOSITORY,
        "documentation": format!("{REPOSITORY}/blob/main/docs/MCP_SERVER.md"),
        "icon": "icon.png",
        "server": {
            "type": "binary",
            // The installed server, outside the bundle. `mcpb pack` refuses
            // that; Claude Desktop runs `mcp_config.command` as written.
            "entry_point": command,
            "mcp_config": { "command": command, "args": args },
        },
        "tools": tools,
        "compatibility": { "platforms": [platform] },
        "privacy_policies": [format!("{REPOSITORY}/blob/main/PRIVACY_POLICY.md")],
        "license": "MIT",
    })
}

fn write_bundle(path: &Path, manifest: &serde_json::Value) -> Result<(), String> {
    let fail = |error: &dyn std::fmt::Display| format!("Could not write {}: {error}", path.display());
    let file = std::fs::File::create(path).map_err(|error| fail(&error))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    let manifest = serde_json::to_vec_pretty(manifest).map_err(|error| fail(&error))?;
    for (name, bytes) in [("manifest.json", manifest.as_slice()), ("icon.png", ICON)] {
        zip.start_file(name, options).map_err(|error| fail(&error))?;
        zip.write_all(bytes).map_err(|error| fail(&error))?;
    }
    zip.finish().map_err(|error| fail(&error))?;
    Ok(())
}

/// Hands the bundle to whatever opens `.mcpb` files: Claude Desktop, which
/// shows its install dialog.
fn open(bundle: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::{ffi::OsStr, os::windows::ffi::OsStrExt, os::windows::process::CommandExt, ptr};
        use windows_sys::Win32::UI::{
            Shell::{AssocQueryStringW, ShellExecuteW, ASSOCF_INIT_IGNOREUNKNOWN, ASSOCSTR_FRIENDLYAPPNAME},
            WindowsAndMessaging::SW_SHOWNORMAL,
        };

        // The Microsoft Store build of Claude Desktop (4.23118, checked for #8)
        // registers only claude: links, no file type, and ShellExecute on an
        // extension nothing claims fails or brings up Windows' app picker. Then
        // the folder is shown instead, for Install Extension in Claude Desktop.
        let extension: Vec<u16> = OsStr::new(".mcpb").encode_wide().chain(Some(0)).collect();
        let mut length = 0u32;
        let claimed = unsafe {
            AssocQueryStringW(
                ASSOCF_INIT_IGNOREUNKNOWN,
                ASSOCSTR_FRIENDLYAPPNAME,
                extension.as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                &mut length,
            )
        } >= 0;
        if !claimed {
            // raw_arg: explorer reads /select,"path" and not a quoted whole.
            let _ = std::process::Command::new("explorer.exe")
                .raw_arg(format!("/select,\"{}\"", bundle.display()))
                .spawn();
            return Err("Claude Desktop on this computer does not open extension files by itself, so the \
                 folder with Protocol.mcpb is open instead."
                .to_string());
        }

        let operation: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = bundle.as_os_str().encode_wide().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(ptr::null_mut(), operation.as_ptr(), target.as_ptr(), ptr::null(), ptr::null(), SW_SHOWNORMAL)
        };
        if result as isize <= 32 {
            return Err(format!(
                "No app on this computer opens Claude Desktop extensions (error {}). Is Claude Desktop installed?",
                result as isize
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let output = std::process::Command::new("open")
            .arg(bundle)
            .output()
            .map_err(|error| format!("Could not open the extension: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "No app on this computer opens Claude Desktop extensions. Is Claude Desktop installed? ({})",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedExtension {
    /// The bundle, for installing it by hand when nothing opened it.
    pub bundle: String,
    /// Claude Desktop was asked to open it; false when nothing could.
    pub opened: bool,
    pub open_error: Option<String>,
}

#[tauri::command]
pub fn add_to_claude_desktop(app: tauri::AppHandle) -> Result<AddedExtension, String> {
    use tauri::Manager;

    if !SUPPORTED {
        return Err("Claude Desktop runs on Windows and macOS only.".to_string());
    }
    let access = crate::agent_access::get_agent_access()?;
    if !access.enabled {
        return Err("Turn on access for AI agents first.".to_string());
    }
    if access.translocated || !access.server_found {
        return Err("Protocol's server cannot be found at a lasting location.".to_string());
    }
    let data_dir = crate::paths::install_data_root();
    let exe_dir = PathBuf::from(&access.command).parent().map(Path::to_path_buf);
    // A data folder beside the app is named outright, so the extension reads
    // exactly the library this app does.
    let mut args = access.args.clone();
    if exe_dir.is_some_and(|dir| dir.join("data") == data_dir) {
        args.extend(["--db".to_string(), access.database_path.clone()]);
    }

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("mcpb");
    std::fs::create_dir_all(&dir).map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
    let bundle = dir.join(BUNDLE_FILE);
    let version = app.package_info().version.to_string();
    write_bundle(&bundle, &manifest(&version, &access.command, &args))?;
    let added = serde_json::to_vec_pretty(&Added { command: access.command.clone() }).map_err(|error| error.to_string())?;
    std::fs::write(data_dir.join(ADDED_FILE), added).map_err(|error| error.to_string())?;

    let opened = open(&bundle);
    log::info!("Claude Desktop extension written to {} (opened: {})", bundle.display(), opened.is_ok());
    Ok(AddedExtension {
        bundle: bundle.to_string_lossy().into_owned(),
        opened: opened.is_ok(),
        open_error: opened.err(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// The properties manifest 0.3 allows (`additionalProperties: false`) and
    /// requires, from mcpb's `schemas/mcpb-manifest-v0.3.schema.json`.
    const ALLOWED: [&str; 28] = [
        "$schema", "dxt_version", "manifest_version", "name", "display_name", "version", "description",
        "long_description", "author", "repository", "homepage", "documentation", "support", "icon", "icons",
        "screenshots", "localization", "server", "tools", "tools_generated", "prompts", "prompts_generated",
        "keywords", "license", "privacy_policies", "compatibility", "user_config", "_meta",
    ];

    #[test]
    fn the_bundle_runs_the_installed_server() {
        let dir = tempfile::tempdir().unwrap();
        let command = r"C:\Users\Someone\AppData\Local\vmedvedevpro\Protocol\protocol-mcp.exe";
        let args = vec!["--db".to_string(), r"C:\Users\Someone\AppData\Local\vmedvedevpro\Protocol\data\meeting_minutes.sqlite".to_string()];
        let manifest = manifest("0.6.0", command, &args);

        let object = manifest.as_object().unwrap();
        for key in object.keys() {
            assert!(ALLOWED.contains(&key.as_str()), "{key} is not a manifest 0.3 property");
        }
        for key in ["name", "version", "description", "author", "server"] {
            assert!(object.contains_key(key), "{key} is required");
        }
        assert_eq!(manifest["manifest_version"], "0.3");
        assert_eq!(manifest["author"]["name"], "vmedvedevpro");
        let server = manifest["server"].as_object().unwrap();
        assert_eq!(server.len(), 3, "server takes type, entry_point and mcp_config only");
        assert_eq!(server["type"], "binary");
        assert_eq!(server["entry_point"], command);
        assert_eq!(server["mcp_config"]["command"], command);
        assert_eq!(server["mcp_config"]["args"], serde_json::json!(args));
        assert_eq!(manifest["tools"].as_array().unwrap().len(), 8);

        let bundle = dir.path().join(BUNDLE_FILE);
        write_bundle(&bundle, &manifest).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&bundle).unwrap()).unwrap();
        let mut names: Vec<String> = zip.file_names().map(str::to_string).collect();
        names.sort();
        assert_eq!(names, ["icon.png", "manifest.json"]);
        let mut written = String::new();
        zip.by_name("manifest.json").unwrap().read_to_string(&mut written).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&written).unwrap(), manifest);
    }

    #[test]
    fn a_moved_app_is_noticed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!moved(dir.path(), "/Applications/Protocol.app/Contents/MacOS/protocol-mcp"));
        std::fs::write(
            dir.path().join(ADDED_FILE),
            serde_json::to_vec(&Added { command: "/Users/me/Downloads/Protocol.app/Contents/MacOS/protocol-mcp".into() }).unwrap(),
        )
        .unwrap();
        assert!(moved(dir.path(), "/Applications/Protocol.app/Contents/MacOS/protocol-mcp"));
        assert!(!moved(dir.path(), "/Users/me/Downloads/Protocol.app/Contents/MacOS/protocol-mcp"));
    }
}
