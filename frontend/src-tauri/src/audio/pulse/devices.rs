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
//!
//! A stored label is looked up as `Listing::find` describes: exactly, by the
//! server's name in its brackets, and in the forms Linux stored before #216
//! (ALSA PCM names), each only where it names one device without doubt.

use std::ffi::CStr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{anyhow, Result};
use pulseaudio::protocol::{self, Command};

use super::Connection;
use crate::audio::devices::platform::linux::ALSA_DEFAULT_INPUT;

/// One input or output monitor of the server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    /// What the select shows and the preferences store, unique among inputs
    /// and among outputs.
    pub label: String,
    /// The server's name for the source, which a record stream connects to.
    pub source: String,
    /// The description the label is made of (the name when there is none).
    pub description: String,
    /// The ALSA card and PCM device behind the source (`alsa.card`,
    /// `alsa.device`), which PipeWire and PulseAudio both set for ALSA
    /// hardware: what an ALSA name stored before #216 is matched by.
    pub alsa: Option<(u32, Option<u32>)>,
}

/// What a stored label finds in a listing.
#[derive(Debug, PartialEq, Eq)]
pub enum Lookup<'a> {
    Found(&'a Source),
    /// The label fits this many sources, none of them for certain.
    Ambiguous(usize),
    Missing,
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
    /// The source with exactly this label: the inputs for a microphone, the
    /// outputs for computer audio.
    pub fn source(&self, label: &str, output: bool) -> Option<&Source> {
        self.list(output).iter().find(|each| each.label == label)
    }

    fn list(&self, output: bool) -> &[Source] {
        if output { &self.outputs } else { &self.inputs }
    }

    /// The source a stored label names now. Labels change when a twin comes
    /// or goes, and Linux stored ALSA names before #216; each rule below
    /// accepts a label only where it names one device without doubt, so a
    /// device that is not there is reported rather than replaced by another.
    /// `card_index` turns an ALSA card id ("sofhdadsp") into its number.
    pub fn find(&self, label: &str, output: bool, card_index: impl Fn(&str) -> Option<u32>) -> Lookup<'_> {
        let list = self.list(output);
        if let Some(found) = self.source(label, output) {
            return Lookup::Found(found);
        }
        // "Yeti [alsa_input.usb-…-A1…]", stored while its twin was connected:
        // the server's name is the device, labelled "Yeti" once the twin is
        // gone. Another device with the same description is not it.
        if let Some(name) = bracketed(label) {
            return list.iter().find(|each| each.source == name).map_or(Lookup::Missing, Lookup::Found);
        }
        // "Yeti", stored while one was connected: with its twin plugged in
        // since, both are "Yeti [...]" and either could be the one.
        let sharing = list.iter().filter(|each| each.description == label).count();
        if sharing > 1 {
            return Lookup::Ambiguous(sharing);
        }
        if output { self.legacy_output(label) } else { self.legacy_input(label, card_index) }
    }

    /// An input stored as cpal's ALSA host named it. `default`, `pulse` and
    /// `pipewire` are ALSA's routes into the sound server's default source,
    /// and "ALSA default input" is what the select offers without a server:
    /// each records the default input. A hardware PCM (`hw:CARD=X,DEV=N`,
    /// `plughw:`, `dsnoop:`, `front:`, `sysdefault:CARD=X`) is the input on
    /// that card and device, when exactly one is. ALSA's plugin PCMs
    /// (`lavrate`, `speex`, `upmix`, …) name no device.
    fn legacy_input(&self, label: &str, card_index: impl Fn(&str) -> Option<u32>) -> Lookup<'_> {
        if ["default", "pulse", "pipewire", ALSA_DEFAULT_INPUT].contains(&label) {
            return self
                .default_input
                .as_deref()
                .and_then(|default| self.source(default, false))
                .map_or(Lookup::Missing, Lookup::Found);
        }
        let Some((card, device)) = alsa_pcm(label) else { return Lookup::Missing };
        let Some(card) = card_index(card) else { return Lookup::Missing };
        let on_card: Vec<_> = self
            .inputs
            .iter()
            .filter(|each| matches!(each.alsa, Some((c, d)) if c == card && (device.is_none() || d == device)))
            .collect();
        match on_card.as_slice() {
            [] => Lookup::Missing,
            [one] => Lookup::Found(*one),
            many => Lookup::Ambiguous(many.len()),
        }
    }

    /// Computer audio stored before #216 as "<ALSA name> (System Audio)",
    /// listed only for an ALSA PCM whose name had "monitor" in it (no
    /// sound-server monitor did). It is that output's monitor when the rest
    /// is a monitor's server name or label now.
    fn legacy_output(&self, label: &str) -> Lookup<'_> {
        let Some(name) = label.strip_suffix(" (System Audio)") else { return Lookup::Missing };
        self.outputs
            .iter()
            .find(|each| each.source == name || each.label == name)
            .map_or(Lookup::Missing, Lookup::Found)
    }
}

/// The server's name in a label that carries one: "Yeti [name]" → "name".
fn bracketed(label: &str) -> Option<&str> {
    let (_, name) = label.strip_suffix(']')?.rsplit_once(" [")?;
    (!name.is_empty()).then_some(name)
}

/// The card and device of an ALSA hardware PCM name: `hw:CARD=X,DEV=N`
/// (cpal's names) or `hw:X,N`, and the same for `plughw`, `dsnoop`, `front`
/// and `sysdefault` (a card only).
fn alsa_pcm(name: &str) -> Option<(&str, Option<u32>)> {
    let (plugin, arguments) = name.split_once(':')?;
    if !["hw", "plughw", "dsnoop", "front", "sysdefault"].contains(&plugin) {
        return None;
    }
    let (mut card, mut device) = (None, None);
    for (position, argument) in arguments.split(',').enumerate() {
        match (argument.split_once('='), position) {
            (Some(("CARD", value)), _) => card = Some(value),
            (Some(("DEV", value)), _) => device = Some(value.parse().ok()?),
            (None, 0) => card = Some(argument),
            (None, 1) => device = Some(argument.parse().ok()?),
            _ => return None,
        }
    }
    Some((card.filter(|card| !card.is_empty())?, device))
}

/// The number of an ALSA card by its id: `/proc/asound/<id>` is a link to
/// `card<N>`. A number is taken as it is.
pub fn alsa_card_index(card: &str) -> Option<u32> {
    if let Ok(index) = card.parse() {
        return Some(index);
    }
    if card.is_empty() || !card.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    let target = std::fs::read_link(Path::new("/proc/asound").join(card)).ok()?;
    target.to_str()?.strip_prefix("card")?.parse().ok()
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
    let described: Vec<(String, String, Option<(u32, Option<u32>)>)> = sources
        .iter()
        .map(|source| {
            let name = text(&source.name);
            let description = source.description.as_deref().map(text).filter(|text| !text.trim().is_empty());
            let alsa = number(&source.props, c"alsa.card").map(|card| (card, number(&source.props, c"alsa.device")));
            (description.unwrap_or_else(|| name.clone()), name, alsa)
        })
        .collect();
    described
        .iter()
        .map(|(description, name, alsa)| {
            let shared = described.iter().filter(|(other, _, _)| other == description).count() > 1;
            Source {
                label: if shared { format!("{description} [{name}]") } else { description.clone() },
                source: name.clone(),
                description: description.clone(),
                alsa: *alsa,
            }
        })
        .collect()
}

/// A numeric property ("0"), as the server sends it: text with a NUL.
fn number(props: &protocol::Props, key: &CStr) -> Option<u32> {
    let bytes = props.get_bytes(key)?;
    std::str::from_utf8(bytes).ok()?.trim_end_matches('\0').trim().parse().ok()
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
        assert_eq!(
            listing.inputs.iter().map(|each| (each.label.as_str(), each.source.as_str())).collect::<Vec<_>>(),
            [("HD Audio Digital Microphone", "alsa_input.pci.HiFi__Mic1__source")],
        );
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

    fn on_card(mut info: protocol::SourceInfo, card: &str, device: &str) -> protocol::SourceInfo {
        info.props.set_bytes(c"alsa.card", CString::new(card).unwrap().as_bytes_with_nul());
        info.props.set_bytes(c"alsa.device", CString::new(device).unwrap().as_bytes_with_nul());
        info
    }

    fn twins() -> Vec<protocol::SourceInfo> {
        let mut sources = laptop();
        sources.push(source(70, "alsa_input.usb-Blue_Yeti_A1-00.analog-stereo", "Yeti Stereo Microphone Analog Stereo", None));
        sources.push(source(71, "alsa_input.usb-Blue_Yeti_B2-00.analog-stereo", "Yeti Stereo Microphone Analog Stereo", None));
        sources
    }

    const YETI: &str = "Yeti Stereo Microphone Analog Stereo";
    const A1: &str = "alsa_input.usb-Blue_Yeti_A1-00.analog-stereo";

    fn found<'a>(lookup: Lookup<'a>) -> Option<&'a str> {
        match lookup {
            Lookup::Found(source) => Some(source.source.as_str()),
            _ => None,
        }
    }

    fn no_cards(_: &str) -> Option<u32> {
        None
    }

    #[test]
    fn a_twin_label_follows_its_device_when_the_other_twin_comes_or_goes() {
        let both = listing(&twins(), &server("none", "none"));
        let mut sources = twins();
        sources.pop();
        let one = listing(&sources, &server("none", "none"));
        assert_eq!(one.inputs[1].label, YETI);

        // Stored while both were there; now only A1 is: it is A1, "Yeti" now.
        let stored = format!("{YETI} [{A1}]");
        assert_eq!(found(one.find(&stored, false, no_cards)), Some(A1));
        // Stored for B2, which is gone: A1 is the same model, not the device.
        assert_eq!(one.find(&format!("{YETI} [alsa_input.usb-Blue_Yeti_B2-00.analog-stereo]"), false, no_cards), Lookup::Missing);
        // Stored as "Yeti" with one connected; the twin came since: either could be it.
        assert_eq!(found(one.find(YETI, false, no_cards)), Some(A1));
        assert_eq!(both.find(YETI, false, no_cards), Lookup::Ambiguous(2));
        assert_eq!(found(both.find(&stored, false, no_cards)), Some(A1));
        // A monitor's label is not looked for among the inputs.
        assert_eq!(both.find("Monitor of HD Audio Speaker", false, no_cards), Lookup::Missing);
    }

    #[test]
    fn alsa_names_stored_before_the_sound_server_listing_map_to_one_device_or_none() {
        let mut sources = laptop();
        let mic = sources.pop().unwrap();
        sources.push(on_card(mic, "0", "6"));
        sources.push(on_card(source(64, "alsa_input.pci.HiFi__Headset__source", "HD Audio Headset Microphone", None), "0", "0"));
        sources.push(on_card(source(72, "alsa_input.usb-Jabra-00.mono", "Jabra Evolve2 Mono", None), "2", "0"));
        let listing = listing(&sources, &server("alsa_input.pci.HiFi__Headset__source", "none"));
        let cards = |id: &str| match id {
            "sofhdadsp" => Some(0),
            "Evolve2" => Some(2),
            "2" => Some(2),
            _ => None,
        };
        let find = |label: &str| listing.find(label, false, cards);

        // ALSA's routes into the server, and the no-server choice: the default input.
        for route in ["default", "pulse", "pipewire", ALSA_DEFAULT_INPUT] {
            assert_eq!(found(find(route)), Some("alsa_input.pci.HiFi__Headset__source"), "{route}");
        }
        // A hardware PCM: the one input on that card and device.
        assert_eq!(found(find("hw:CARD=sofhdadsp,DEV=6")), Some("alsa_input.pci.HiFi__Mic1__source"));
        assert_eq!(found(find("plughw:CARD=sofhdadsp,DEV=0")), Some("alsa_input.pci.HiFi__Headset__source"));
        assert_eq!(found(find("dsnoop:CARD=Evolve2,DEV=0")), Some("alsa_input.usb-Jabra-00.mono"));
        assert_eq!(found(find("hw:2,0")), Some("alsa_input.usb-Jabra-00.mono"));
        assert_eq!(found(find("sysdefault:CARD=Evolve2")), Some("alsa_input.usb-Jabra-00.mono"));
        // A card with two inputs and no device named; a device nothing records; an unknown card.
        assert_eq!(find("sysdefault:CARD=sofhdadsp"), Lookup::Ambiguous(2));
        assert_eq!(find("hw:CARD=sofhdadsp,DEV=3"), Lookup::Missing);
        assert_eq!(find("hw:CARD=Gone,DEV=0"), Lookup::Missing);
        // Plugin PCMs name no device.
        for plugin in ["lavrate", "speex", "upmix", "usbstream:CARD=sofhdadsp", "hw:CARD=sofhdadsp,SUBDEV=1"] {
            assert_eq!(find(plugin), Lookup::Missing, "{plugin}");
        }
        // Without a default input the routes find nothing.
        let without = super::listing(&sources, &server("none", "none"));
        assert_eq!(without.find("default", false, cards), Lookup::Missing);
    }

    #[test]
    fn computer_audio_stored_before_the_sound_server_listing_is_matched_only_by_a_monitor_name() {
        let listing = listing(&laptop(), &server("none", "alsa_output.pci.HiFi__Speaker__sink"));
        let monitor = "alsa_output.pci.HiFi__Speaker__sink.monitor";
        assert_eq!(found(listing.find(&format!("{monitor} (System Audio)"), true, no_cards)), Some(monitor));
        assert_eq!(found(listing.find("Monitor of HD Audio Speaker (System Audio)", true, no_cards)), Some(monitor));
        assert_eq!(listing.find("dmix_monitor (System Audio)", true, no_cards), Lookup::Missing);
        // An old input form is not computer audio.
        assert_eq!(listing.find("default", true, no_cards), Lookup::Missing);
    }

    #[test]
    fn alsa_card_ids_resolve_through_proc_asound() {
        assert_eq!(alsa_card_index("3"), Some(3));
        assert_eq!(alsa_card_index("../card0"), None);
        assert_eq!(alsa_card_index(""), None);
        assert_eq!(alsa_card_index("NoSuchCardHere"), None);
    }

    #[test]
    fn sources_carry_their_alsa_card_and_device() {
        let sources = [on_card(source(63, "mic", "Mic", None), "0", "6"), source(5, "virtual_mic", "Virtual", None)];
        let listing = listing(&sources, &server("none", "none"));
        assert_eq!(listing.inputs[0].alsa, Some((0, Some(6))));
        assert_eq!(listing.inputs[1].alsa, None);
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
