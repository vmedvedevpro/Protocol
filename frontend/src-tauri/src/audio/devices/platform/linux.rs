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

use crate::audio::devices::configuration::{AudioDevice, DeviceType};
use crate::audio::pulse;

/// The one microphone offered when no sound server runs.
pub const ALSA_DEFAULT_INPUT: &str = "ALSA default input";

/// What a stored device opens.
pub enum Capture {
    /// A sound-server source, by the server's name for it.
    SoundServer { source: String },
    /// ALSA's default capture device (no sound server).
    Alsa(cpal::Device, cpal::SupportedStreamConfig),
}

/// The inputs and output monitors the select lists. Blocks on the sound
/// server's socket for a moment: `list_audio_devices` calls it off the
/// async runtime.
pub fn configure_linux_audio(_host: &cpal::Host) -> Result<Vec<AudioDevice>> {
    if !pulse::available() {
        return Ok(vec![AudioDevice::new(ALSA_DEFAULT_INPUT.to_string(), DeviceType::Input)]);
    }
    let listing = pulse::devices::current()?;
    let inputs = listing.inputs.iter().map(|each| AudioDevice::new(each.label.clone(), DeviceType::Input));
    let outputs = listing.outputs.iter().map(|each| AudioDevice::new(each.label.clone(), DeviceType::Output));
    Ok(inputs.chain(outputs).collect())
}

/// The system's default microphone or computer audio: the sound server's
/// default input, or the monitor of its default output.
pub fn default_device(device_type: DeviceType) -> Result<AudioDevice> {
    if !pulse::available() {
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

/// Finds what a stored device opens now. Errors name the device, so a
/// recording start can report it (or fall back to the default, as the
/// other platforms do for a device that is not connected).
pub fn resolve(device: &AudioDevice) -> Result<Capture> {
    if !pulse::available() {
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
    let listing = pulse::devices::current()?;
    let source = listing
        .source(&device.name, device.device_type == DeviceType::Output)
        .ok_or_else(|| anyhow!("'{}' is not connected", device.name))?;
    Ok(Capture::SoundServer { source: source.source.clone() })
}

/// Whether the system has a microphone to record: Linux asks no permission
/// (outside a sandbox portal), so this is whether one is there.
pub fn microphone_present() -> bool {
    match default_device(DeviceType::Input).and_then(|device| resolve(&device)) {
        Ok(_) => true,
        Err(error) => {
            log::warn!("No microphone to record: {error:#}");
            false
        }
    }
}

