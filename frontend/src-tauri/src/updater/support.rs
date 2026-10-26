//! Which copies of Protocol update themselves.
//!
//! The bundler patches a marker into the main executable of each bundle
//! (`tauri::utils::platform::bundle_type`), and the updater feed is keyed by
//! it. Executables it never patched (`cargo build`, `tauri build --no-bundle`
//! as used by the QA toolkit, a copied exe) report no bundle and stay off; so do
//! debug builds. On macOS the marker always reads `app`, so the executable must
//! also sit inside an `.app` bundle.

use serde::Serialize;
use tauri::utils::config::BundleType;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallKind {
    Nsis,
    Msi,
    App,
    AppImage,
    Deb,
    Rpm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OffReason {
    /// A development build.
    Dev,
    /// Not installed by a Protocol installer.
    NotInstalled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Support {
    /// Checks, downloads and installs.
    Updatable { install: InstallKind },
    /// Checks and shows a link (system packages update through their package).
    ManualOnly { install: InstallKind },
    Off { reason: OffReason },
}

impl Support {
    pub fn checks(self) -> bool {
        !matches!(self, Support::Off { .. })
    }

    pub fn installs(self) -> bool {
        matches!(self, Support::Updatable { .. })
    }
}

pub fn detect() -> Support {
    classify(
        cfg!(debug_assertions),
        tauri::utils::platform::bundle_type(),
        in_app_bundle(),
    )
}

pub(crate) fn classify(debug: bool, bundle: Option<BundleType>, in_app_bundle: bool) -> Support {
    if debug {
        return Support::Off { reason: OffReason::Dev };
    }
    let not_installed = Support::Off { reason: OffReason::NotInstalled };
    match bundle {
        Some(BundleType::Nsis) => Support::Updatable { install: InstallKind::Nsis },
        Some(BundleType::AppImage) => Support::Updatable { install: InstallKind::AppImage },
        Some(BundleType::App | BundleType::Dmg) if in_app_bundle => {
            Support::Updatable { install: InstallKind::App }
        }
        Some(BundleType::App | BundleType::Dmg) => not_installed,
        // Linux packages belong to the package manager; MSI is not shipped.
        Some(BundleType::Deb) => Support::ManualOnly { install: InstallKind::Deb },
        Some(BundleType::Rpm) => Support::ManualOnly { install: InstallKind::Rpm },
        Some(BundleType::Msi) => Support::ManualOnly { install: InstallKind::Msi },
        None => not_installed,
    }
}

/// macOS: `Protocol.app/Contents/MacOS/protocol`. Elsewhere irrelevant.
fn in_app_bundle() -> bool {
    std::env::current_exe().ok().is_some_and(|exe| {
        exe.parent()
            .filter(|dir| dir.ends_with("Contents/MacOS"))
            .and_then(|dir| dir.parent()?.parent())
            .and_then(|bundle| bundle.extension())
            .is_some_and(|extension| extension == "app")
    })
}

/// The feed key a manual-only install reads version and notes from: the
/// release feed has no `.deb` entry on purpose (#15), only the AppImage.
pub fn manual_only_feed_target(support: Support) -> Option<&'static str> {
    match support {
        Support::ManualOnly { install: InstallKind::Deb | InstallKind::Rpm } => Some("linux-x86_64-appimage"),
        Support::ManualOnly { install: InstallKind::Msi } => Some("windows-x86_64-nsis"),
        _ => None,
    }
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_types_by_profile() {
        let cases = [
            (false, Some(BundleType::Nsis), false, Support::Updatable { install: InstallKind::Nsis }),
            (false, Some(BundleType::AppImage), false, Support::Updatable { install: InstallKind::AppImage }),
            (false, Some(BundleType::App), true, Support::Updatable { install: InstallKind::App }),
            (false, Some(BundleType::App), false, Support::Off { reason: OffReason::NotInstalled }),
            (false, Some(BundleType::Deb), false, Support::ManualOnly { install: InstallKind::Deb }),
            (false, Some(BundleType::Rpm), false, Support::ManualOnly { install: InstallKind::Rpm }),
            (false, Some(BundleType::Msi), false, Support::ManualOnly { install: InstallKind::Msi }),
            (false, None, false, Support::Off { reason: OffReason::NotInstalled }),
            (true, Some(BundleType::Nsis), false, Support::Off { reason: OffReason::Dev }),
        ];
        for (debug, bundle, in_app, expected) in cases {
            assert_eq!(classify(debug, bundle.clone(), in_app), expected, "{bundle:?} debug={debug}");
        }
    }

    #[test]
    fn manual_installs_read_the_appimage_entry() {
        assert_eq!(
            manual_only_feed_target(Support::ManualOnly { install: InstallKind::Deb }),
            Some("linux-x86_64-appimage")
        );
        assert_eq!(manual_only_feed_target(Support::Updatable { install: InstallKind::Nsis }), None);
    }

    #[test]
    fn support_serializes_with_a_kind_tag() {
        let value = serde_json::to_value(Support::Off { reason: OffReason::NotInstalled }).unwrap();
        assert_eq!(value, serde_json::json!({ "kind": "off", "reason": "notInstalled" }));
    }
}
