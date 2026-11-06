//! Where the app keeps `meeting_minutes.sqlite`, found the way the app's
//! `paths::install_data_root` decides it, but without creating or probing
//! anything: the server never writes.
//!
//! Order: `--db`, then `PROTOCOL_MCP_DB`, then `<folder of this executable>/data`
//! when the database is there (Windows and Linux installs whose folder is
//! writable, as the per-user Windows install is), then the OS data folder under
//! `vmedvedevpro/Protocol` (macOS always; read-only install folders such as
//! `/usr/bin` or an AppImage mount).

use std::path::{Path, PathBuf};

pub const DB_FILE: &str = "meeting_minutes.sqlite";
pub const DB_ENV: &str = "PROTOCOL_MCP_DB";
/// `paths.rs`: `FALLBACK_PUBLISHER` / `FALLBACK_APP_NAME`.
const FALLBACK_SUBDIR: [&str; 2] = ["vmedvedevpro", "Protocol"];
#[cfg(not(target_os = "macos"))]
const PORTABLE_SUBDIR: &str = "data";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Located {
    /// The database file exists here.
    Found(PathBuf),
    /// No database at any of these paths, in the order they were tried.
    Missing(Vec<PathBuf>),
}

/// What the resolution looks at; `from_environment` fills it for real runs.
#[derive(Debug, Clone, Default)]
pub struct Inputs {
    pub flag: Option<PathBuf>,
    pub env: Option<PathBuf>,
    pub exe_dir: Option<PathBuf>,
    pub os_data_dir: Option<PathBuf>,
}

impl Inputs {
    pub fn from_environment(flag: Option<PathBuf>) -> Self {
        Inputs {
            flag,
            env: std::env::var_os(DB_ENV)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            exe_dir: std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf)),
            os_data_dir: dirs::data_dir().or_else(dirs::home_dir),
        }
    }
}

pub fn locate(inputs: &Inputs) -> Located {
    // An explicit path is the only candidate: falling back from a path the
    // user named to another database would answer about the wrong library.
    if let Some(explicit) = inputs.flag.as_ref().or(inputs.env.as_ref()) {
        return if explicit.is_file() {
            Located::Found(explicit.clone())
        } else {
            Located::Missing(vec![explicit.clone()])
        };
    }

    let mut tried = Vec::new();
    #[cfg(not(target_os = "macos"))]
    if let Some(exe_dir) = &inputs.exe_dir {
        tried.push(exe_dir.join(PORTABLE_SUBDIR).join(DB_FILE));
    }
    #[cfg(target_os = "macos")]
    let _ = &inputs.exe_dir;
    if let Some(data_dir) = &inputs.os_data_dir {
        let mut path = data_dir.clone();
        for part in FALLBACK_SUBDIR {
            path.push(part);
        }
        tried.push(path.join(DB_FILE));
    }
    match tried.iter().find(|path| path.is_file()) {
        Some(found) => Located::Found(found.clone()),
        None => Located::Missing(tried),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    fn snapshot(root: &Path) -> Vec<PathBuf> {
        let mut entries = Vec::new();
        for entry in walk(root) {
            entries.push(entry.strip_prefix(root).unwrap().to_path_buf());
        }
        entries.sort();
        entries
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                out.extend(walk(&path));
            }
            out.push(path);
        }
        out
    }

    #[test]
    fn an_explicit_path_wins_and_is_never_replaced_by_another_library() {
        let root = tempfile::tempdir().unwrap();
        let installed = root.path().join("install");
        let flag = root.path().join("chosen.sqlite");
        let env = root.path().join("env.sqlite");
        touch(&installed.join("data").join(DB_FILE));
        touch(&env);

        let mut inputs = Inputs {
            flag: Some(flag.clone()),
            env: Some(env.clone()),
            exe_dir: Some(installed.clone()),
            os_data_dir: None,
        };
        assert_eq!(locate(&inputs), Located::Missing(vec![flag.clone()]));
        touch(&flag);
        assert_eq!(locate(&inputs), Located::Found(flag));

        inputs.flag = None;
        assert_eq!(locate(&inputs), Located::Found(env));
    }

    #[test]
    fn the_install_folder_comes_before_the_os_data_folder() {
        let root = tempfile::tempdir().unwrap();
        let exe_dir = root.path().join("install");
        let os_data = root.path().join("os-data");
        let fallback = os_data.join("vmedvedevpro").join("Protocol").join(DB_FILE);
        let portable = exe_dir.join("data").join(DB_FILE);
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&os_data).unwrap();
        let inputs = Inputs {
            flag: None,
            env: None,
            exe_dir: Some(exe_dir.clone()),
            os_data_dir: Some(os_data.clone()),
        };

        let before = snapshot(root.path());
        let missing = locate(&inputs);
        // Nothing is created while looking, unlike paths.rs's writability probe.
        assert_eq!(snapshot(root.path()), before);
        #[cfg(not(target_os = "macos"))]
        assert_eq!(missing, Located::Missing(vec![portable.clone(), fallback.clone()]));
        #[cfg(target_os = "macos")]
        assert_eq!(missing, Located::Missing(vec![fallback.clone()]));

        touch(&fallback);
        assert_eq!(locate(&inputs), Located::Found(fallback.clone()));
        touch(&portable);
        #[cfg(not(target_os = "macos"))]
        assert_eq!(locate(&inputs), Located::Found(portable));
        #[cfg(target_os = "macos")]
        assert_eq!(locate(&inputs), Located::Found(fallback));
    }
}
