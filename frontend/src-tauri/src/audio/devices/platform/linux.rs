//! Linux audio devices (#216).
//!
//! With a sound server (PipeWire through `pipewire-pulse`, or PulseAudio,
//! which every desktop distribution runs) the devices are the server's
//! inputs and output monitors, named and opened as `audio::pulse` describes.
//! Without one, only ALSA's `default` device is offered: listing ALSA's PCMs
//! opens each of them, and its plugin and raw hardware PCMs (`dmix`,
//! `plughw:…`) are no choice a person can make. ALSA has no monitor of what
//! plays, so there is no computer audio then.

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait};

use crate::audio::devices::configuration::{AmbiguousDevice, AudioDevice, DeviceType, MissingDevice};
use crate::audio::pulse;
use crate::audio::pulse::devices::Lookup;

/// The one microphone offered when no sound server runs.
pub const ALSA_DEFAULT_INPUT: &str = "ALSA default input";

/// What a stored device opens.
pub enum Capture {
    /// A sound-server source, by the server's name for it.
    SoundServer { source: String },
    /// ALSA's default capture device (no sound server).
    Alsa(cpal::Device, cpal::SupportedStreamConfig),
}

/// Whether a sound server runs; an error when `PULSE_SERVER` names none
/// that can be reached (`pulse::socket_path`). Only with no server at all is
/// ALSA's default input offered: the issue asks the select to stay usable on
/// a system with ALSA alone, and a misconfigured server must not look like
/// one.
fn sound_server_runs() -> Result<bool> {
    Ok(pulse::socket_path()?.is_some())
}

/// The inputs and output monitors the select lists. Blocks on the sound
/// server's socket for a moment: `list_audio_devices` calls it off the
/// async runtime. A failure is logged here and reaches the select.
pub fn configure_linux_audio(_host: &cpal::Host) -> Result<Vec<AudioDevice>> {
    let listed = (|| {
        if !sound_server_runs()? {
            return Ok(vec![AudioDevice::new(ALSA_DEFAULT_INPUT.to_string(), DeviceType::Input)]);
        }
        let listing = pulse::devices::current()?;
        let inputs = listing.inputs.iter().map(|each| AudioDevice::new(each.label.clone(), DeviceType::Input));
        let outputs = listing.outputs.iter().map(|each| AudioDevice::new(each.label.clone(), DeviceType::Output));
        Ok(inputs.chain(outputs).collect())
    })();
    if let Err(error) = &listed {
        log::error!("Cannot list audio devices: {error:#}");
    }
    listed
}

/// The system's default microphone or computer audio: the sound server's
/// default input, or the monitor of its default output.
pub fn default_device(device_type: DeviceType) -> Result<AudioDevice> {
    if !sound_server_runs()? {
        return match device_type {
            DeviceType::Input => Ok(AudioDevice::new(ALSA_DEFAULT_INPUT.to_string(), DeviceType::Input)),
            DeviceType::Output => Err(anyhow!(
                "computer audio needs PipeWire or PulseAudio, and neither is running"
            )),
        };
    }
    let listing = pulse::devices::current()?;
    let label = match device_type {
        DeviceType::Input => listing.default_input.clone().ok_or_else(|| anyhow!("the sound server has no default microphone")),
        DeviceType::Output => listing.default_output.clone().ok_or_else(|| anyhow!("the sound server has no default output to record")),
    }?;
    Ok(AudioDevice::new(label, device_type))
}

/// The sound-server source a stored device names now (`Listing::find`).
fn lookup(device: &AudioDevice) -> Result<pulse::devices::Source> {
    let listing = pulse::devices::current()?;
    match listing.find(&device.name, device.device_type == DeviceType::Output, pulse::devices::alsa_card_index) {
        Lookup::Found(source) => Ok(source.clone()),
        Lookup::Ambiguous(count) => Err(AmbiguousDevice { name: device.name.clone(), count }.into()),
        Lookup::Missing => Err(MissingDevice { name: device.name.clone() }.into()),
    }
}

/// Finds what a stored device opens now. Errors name the device, so a
/// recording start can report it (or fall back to the default, as the
/// other platforms do for a device that is not connected, and say so).
pub fn resolve(device: &AudioDevice) -> Result<Capture> {
    if !sound_server_runs()? {
        anyhow::ensure!(
            device.device_type == DeviceType::Input && device.name == ALSA_DEFAULT_INPUT,
            "'{}' needs PipeWire or PulseAudio, and neither is running",
            device.name
        );
        let alsa = cpal::default_host()
            .default_input_device()
            .ok_or_else(|| anyhow!("ALSA has no default capture device"))?;
        let config = alsa
            .default_input_config()
            .map_err(|error| anyhow!("ALSA's default capture device cannot record: {error}"))?;
        return Ok(Capture::Alsa(alsa, config));
    }
    Ok(Capture::SoundServer { source: lookup(device)?.source })
}

/// A stored device as the select lists it now: a label stored in an older
/// form (an ALSA name, a twin's bracket that no longer applies) becomes the
/// current label of the device it names, so the recording, its level meter
/// and the select all call it the same. Errors as `resolve`.
pub fn current_name(device: &AudioDevice) -> Result<AudioDevice> {
    if !sound_server_runs()? {
        resolve(device)?;
        return Ok(device.clone());
    }
    Ok(AudioDevice::new(lookup(device)?.label, device.device_type.clone()))
}

/// Whether the system has a microphone to record: Linux asks no permission
/// (outside a sandbox portal), so this is whether one is there. A sound
/// server that `PULSE_SERVER` points at but cannot be reached is an error,
/// not a missing microphone.
pub fn microphone_present() -> Result<bool> {
    sound_server_runs()?;
    match default_device(DeviceType::Input).and_then(|device| resolve(&device)) {
        Ok(_) => Ok(true),
        Err(error) => {
            log::warn!("No microphone to record: {error:#}");
            Ok(false)
        }
    }
}
