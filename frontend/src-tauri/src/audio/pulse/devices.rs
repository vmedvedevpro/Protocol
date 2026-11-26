//! The sound server's inputs and output monitors, as the device select lists
//! them (#216).
//!
//! A device is shown and stored by its description ("Built-in Audio Analog
//! Stereo", "Monitor of Built-in Audio Analog Stereo"): the stored choice is
//! `<description> (input)` like on the other platforms, so it survives a
//! restart and a reconnect, when the server gives the device back under the
//! same description, whatever its index or position. Two devices that share a
//! description (two identical USB microphones) are told apart by the
//! server's own name for them, which carries the port path or serial and is
//! just as stable. Recording opens the source by that name.

use std::ffi::CStr;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{anyhow, Result};
use pulseaudio::protocol::{self, Command};

use super::Connection;

/// One input or output monitor of the server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    /// What the select shows and the preferences store, unique among inputs
    /// and among outputs.
    pub label: String,
    /// The server's name for the source, which a record stream connects to.
    pub source: String,
}

/// What the server lists now.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Listing {
    /// Microphones and other capture devices, in the server's order.
    pub inputs: Vec<Source>,
    /// The monitor of each output: what that output plays.
    pub outputs: Vec<Source>,
    /// The server's default input, by label, when it is one of `inputs`.
    pub default_input: Option<String>,
    /// The monitor of the server's default output, by label.
    pub default_output: Option<String>,
}

impl Listing {
    /// The source a stored label names: the inputs for a microphone, the
    /// outputs for computer audio.
    pub fn source(&self, label: &str, output: bool) -> Option<&Source> {
        let list = if output { &self.outputs } else { &self.inputs };
        list.iter().find(|each| each.label == label)
    }
}

/// The last listing and when it finished. A caller that asks while another
/// listing runs waits for it and takes its answer instead of listing again
/// (Settings, the inputs menu and a recording start all ask at once).
static LAST: Mutex<Option<(Instant, Result<Arc<Listing>, String>)>> = Mutex::new(None);

/// The server's devices, read once per burst of callers. Blocks on the socket
/// for at most a few seconds: call it from a blocking thread.
pub fn current() -> Result<Arc<Listing>> {
    let asked = Instant::now();
    let mut last = LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((finished, answer)) = last.as_ref() {
        // Finished after this call began: it ran while this one waited.
        if *finished >= asked {
            return answer.clone().map_err(|message| anyhow!(message));
        }
    }
    let answer = read().map(Arc::new).map_err(|error| format!("{error:#}"));
    *last = Some((Instant::now(), answer.clone()));
    answer.map_err(|message| anyhow!(message))
}

fn read() -> Result<Listing> {
    let mut connection = Connection::open()?;
    let server: protocol::ServerInfo = connection.roundtrip(Command::GetServerInfo)?;
    let sources: protocol::SourceInfoList = connection.roundtrip(Command::GetSourceInfoList)?;
    Ok(listing(&sources, &server))
}

fn text(value: &CStr) -> String {
    value.to_string_lossy().into_owned()
}

/// Builds the listing from the server's replies. Pure, so the naming rules
/// are tested without a server.
pub fn listing(sources: &[protocol::SourceInfo], server: &protocol::ServerInfo) -> Listing {
    let (monitors, inputs): (Vec<_>, Vec<_>) =
        sources.iter().partition(|source| source.monitor_of_sink_index.is_some());
    let inputs = labelled(&inputs);
    let outputs = labelled(&monitors);

    let default_input = server.default_source_name.as_deref().map(text).and_then(|name| {
        inputs.iter().find(|each| each.source == name).map(|each| each.label.clone())
    });
    // The default output's monitor: the source whose sink is the default sink.
    let default_output = server.default_sink_name.as_deref().map(text).and_then(|sink| {
        let monitor = monitors.iter().find(|source| source.monitor_of_sink_name.as_deref().map(text).as_deref() == Some(sink.as_str()))?;
        let name = text(&monitor.name);
        outputs.iter().find(|each| each.source == name).map(|each| each.label.clone())
    });

    Listing { inputs, outputs, default_input, default_output }
}

fn labelled(sources: &[&protocol::SourceInfo]) -> Vec<Source> {
    let described: Vec<(String, String)> = sources
        .iter()
        .map(|source| {
            let name = text(&source.name);
            let description = source.description.as_deref().map(text).filter(|text| !text.trim().is_empty());
            (description.unwrap_or_else(|| name.clone()), name)
        })
        .collect();
    described
        .iter()
        .map(|(description, name)| {
            let shared = described.iter().filter(|(other, _)| other == description).count() > 1;
            Source {
                label: if shared { format!("{description} [{name}]") } else { description.clone() },
                source: name.clone(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    fn source(index: u32, name: &str, description: &str, monitor_of: Option<&str>) -> protocol::SourceInfo {
        protocol::SourceInfo {
            index,
            name: CString::new(name).unwrap(),
            description: Some(CString::new(description).unwrap()),
            monitor_of_sink_index: monitor_of.map(|_| index + 100),
            monitor_of_sink_name: monitor_of.map(|sink| CString::new(sink).unwrap()),
            ..Default::default()
        }
    }

    fn server(source: &str, sink: &str) -> protocol::ServerInfo {
        protocol::ServerInfo {
            default_source_name: Some(CString::new(source).unwrap()),
            default_sink_name: Some(CString::new(sink).unwrap()),
            ..Default::default()
        }
    }

    // What this laptop's PipeWire 1.6 lists (pactl list sources, shortened).
    fn laptop() -> Vec<protocol::SourceInfo> {
        vec![
            source(61, "alsa_output.pci.HiFi__HDMI1__sink.monitor", "Monitor of HD Audio HDMI / DisplayPort 1 Output", Some("alsa_output.pci.HiFi__HDMI1__sink")),
            source(62, "alsa_output.pci.HiFi__Speaker__sink.monitor", "Monitor of HD Audio Speaker", Some("alsa_output.pci.HiFi__Speaker__sink")),
            source(63, "alsa_input.pci.HiFi__Mic1__source", "HD Audio Digital Microphone", None),
        ]
    }

    #[test]
    fn inputs_and_output_monitors_are_listed_by_description() {
        let listing = listing(&laptop(), &server("alsa_input.pci.HiFi__Mic1__source", "alsa_output.pci.HiFi__Speaker__sink"));
        assert_eq!(listing.inputs, vec![Source { label: "HD Audio Digital Microphone".into(), source: "alsa_input.pci.HiFi__Mic1__source".into() }]);
        assert_eq!(
            listing.outputs.iter().map(|each| each.label.as_str()).collect::<Vec<_>>(),
            ["Monitor of HD Audio HDMI / DisplayPort 1 Output", "Monitor of HD Audio Speaker"],
        );
        assert_eq!(listing.default_input.as_deref(), Some("HD Audio Digital Microphone"));
        assert_eq!(listing.default_output.as_deref(), Some("Monitor of HD Audio Speaker"));
        assert_eq!(
            listing.source("Monitor of HD Audio Speaker", true).map(|each| each.source.as_str()),
            Some("alsa_output.pci.HiFi__Speaker__sink.monitor"),
        );
        // A monitor is not a microphone, nor a microphone an output.
        assert_eq!(listing.source("Monitor of HD Audio Speaker", false), None);
        assert_eq!(listing.source("HD Audio Digital Microphone", true), None);
    }

    #[test]
    fn devices_sharing_a_description_are_told_apart_by_the_servers_name_not_by_position() {
        let mut sources = laptop();
        sources.push(source(70, "alsa_input.usb-Blue_Yeti_A1-00.analog-stereo", "Yeti Stereo Microphone Analog Stereo", None));
        sources.push(source(71, "alsa_input.usb-Blue_Yeti_B2-00.analog-stereo", "Yeti Stereo Microphone Analog Stereo", None));
        let first = listing(&sources, &server("alsa_input.usb-Blue_Yeti_B2-00.analog-stereo", "none"));

        let labels: Vec<_> = first.inputs.iter().map(|each| each.label.as_str()).collect();
        assert_eq!(labels, [
            "HD Audio Digital Microphone",
            "Yeti Stereo Microphone Analog Stereo [alsa_input.usb-Blue_Yeti_A1-00.analog-stereo]",
            "Yeti Stereo Microphone Analog Stereo [alsa_input.usb-Blue_Yeti_B2-00.analog-stereo]",
        ]);
        assert_eq!(first.default_input.as_deref(), Some(labels[2]));
        assert_eq!(first.default_output, None);

        // The second one reconnects first, under a new index: its label stays.
        sources.swap(3, 4);
        sources[3].index = 80;
        let again = listing(&sources, &server("none", "none"));
        assert_eq!(again.source(labels[2], false).map(|each| each.source.as_str()), Some("alsa_input.usb-Blue_Yeti_B2-00.analog-stereo"));
    }

    #[test]
    fn a_source_without_a_description_is_listed_by_its_name() {
        let mut bare = source(5, "virtual_mic", "", None);
        bare.description = None;
        let listing = listing(&[bare], &server("virtual_mic", "none"));
        assert_eq!(listing.inputs[0].label, "virtual_mic");
        assert_eq!(listing.default_input.as_deref(), Some("virtual_mic"));
    }

    // Reads this machine's sound server. Ignored by default: it needs a
    // running PipeWire or PulseAudio session.
    #[test]
    #[ignore]
    fn lists_the_running_sound_server() {
        let listing = current().expect("a sound server runs");
        eprintln!("{listing:#?}");
        assert!(!listing.inputs.is_empty() || !listing.outputs.is_empty());
    }
}
