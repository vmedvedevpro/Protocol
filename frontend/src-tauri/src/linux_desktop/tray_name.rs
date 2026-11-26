//! The tray icon's name on hover (#215).
//!
//! The panel names a tray icon on hover from its StatusNotifierItem's
//! `ToolTip` property (KDE Plasma 6, GNOME's AppIndicator extension).
//! Tauri's tray on Linux is libayatana-appindicator (through tray-icon), whose
//! item exports `Title` (GLib's application name, set in `tray.rs`) but no
//! `ToolTip` at all, and Plasma 6 does not fall back to `Title`: hovering
//! Protocol's icon showed nothing while Bitwarden's, which sets `ToolTip`,
//! showed its name.
//!
//! libayatana-appindicator registers its item on GLib's shared session-bus
//! connection, the one `gio::bus_get_sync` returns in this process. A filter
//! on that connection adds `ToolTip` to the item's replies to
//! `Properties.GetAll("org.kde.StatusNotifierItem")`, which is how both panels
//! read the item: it notes each such call as it comes in and, when the reply
//! to it goes out, adds a `ToolTip` with the app's name as its title.

use std::collections::HashSet;
use std::sync::Mutex;

use gtk::gio;
use gtk::glib::{self, ToVariant};

const ITEM_PATH_PREFIX: &str = "/org/ayatana/NotificationItem/";
const ITEM_INTERFACE: &str = "org.kde.StatusNotifierItem";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";

/// The `ToolTip` value: icon name, icon pixmaps, title, description
/// (`(sa(iiay)ss)` in the StatusNotifierItem spec).
fn tooltip(name: &str) -> glib::Variant {
    let pixmaps: Vec<(i32, i32, Vec<u8>)> = Vec::new();
    ("", pixmaps, name, "").to_variant()
}

/// The reply body `(a{sv})` with `ToolTip` added, if `body` is one.
fn with_tooltip(body: &glib::Variant, tooltip: &glib::Variant) -> Option<glib::Variant> {
    if body.type_().as_str() != "(a{sv})" {
        return None;
    }
    let properties = glib::VariantDict::new(Some(&body.child_value(0)));
    if !properties.contains("ToolTip") {
        properties.insert_value("ToolTip", tooltip);
    }
    Some(glib::Variant::tuple_from_iter([properties.end()]))
}

/// Adds the filter. Call once, before the tray is created.
pub fn install(name: &str) {
    let connection = match gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) {
        Ok(connection) => connection,
        Err(error) => {
            log::warn!("Linux tray: no session bus, the icon gets no name on hover ({error})");
            return;
        }
    };
    let tooltip = tooltip(name);
    // GetAll calls to the item awaiting their reply, by caller and serial.
    // The filter runs on GDBus's worker thread for incoming messages and on
    // the sending thread for outgoing ones.
    let pending: Mutex<HashSet<(String, u32)>> = Mutex::new(HashSet::new());
    // The filter lives as long as the connection, which is the process's.
    let _ = connection.add_filter(move |_, message, incoming| {
        if incoming {
            let is_item_get_all = message.message_type() == gio::DBusMessageType::MethodCall
                && message.interface().as_deref() == Some(PROPERTIES)
                && message.member().as_deref() == Some("GetAll")
                && message
                    .path()
                    .is_some_and(|path| path.starts_with(ITEM_PATH_PREFIX))
                && message
                    .body()
                    .and_then(|body| body.try_child_value(0))
                    .and_then(|interface| interface.str().map(str::to_owned))
                    .as_deref()
                    == Some(ITEM_INTERFACE);
            if is_item_get_all {
                if let Some(sender) = message.sender() {
                    pending
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .insert((sender.to_string(), message.serial()));
                }
            }
            return Some(message.clone());
        }
        // A reply ends the call either way; an error reply is let through
        // unchanged, but must not leave its call pending for good.
        let message_type = message.message_type();
        if message_type != gio::DBusMessageType::MethodReturn && message_type != gio::DBusMessageType::Error {
            return Some(message.clone());
        }
        let Some(destination) = message.destination() else {
            return Some(message.clone());
        };
        let key = (destination.to_string(), message.reply_serial());
        let was_pending = pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&key);
        if !was_pending || message_type != gio::DBusMessageType::MethodReturn {
            return Some(message.clone());
        }
        // An outgoing message is locked; send a modified copy instead.
        let body = message.body().and_then(|body| with_tooltip(&body, &tooltip));
        match (body, message.copy()) {
            (Some(body), Ok(copy)) => {
                copy.set_body(&body);
                Some(copy)
            }
            _ => Some(message.clone()),
        }
    });
    log::info!("Linux tray: the icon is named {name:?} on hover");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_all_replies_gain_the_tooltip_and_keep_the_rest() {
        let properties = glib::VariantDict::new(None);
        properties.insert_value("Title", &"Protocol".to_variant());
        let body = glib::Variant::tuple_from_iter([properties.end()]);

        let changed = with_tooltip(&body, &tooltip("Protocol")).expect("an a{sv} reply");
        let changed = glib::VariantDict::new(Some(&changed.child_value(0)));
        assert_eq!(
            changed.lookup_value("Title", None).and_then(|title| title.get::<String>()),
            Some("Protocol".to_owned())
        );
        let tip = changed.lookup_value("ToolTip", None).expect("a ToolTip");
        assert_eq!(tip.type_().as_str(), "(sa(iiay)ss)");
        assert_eq!(tip.child_value(2).get::<String>(), Some("Protocol".to_owned()));
    }

    #[test]
    fn other_replies_are_left_alone() {
        assert!(with_tooltip(&("x",).to_variant(), &tooltip("Protocol")).is_none());
    }
}
