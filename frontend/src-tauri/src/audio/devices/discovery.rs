use anyhow::Result;
#[cfg(not(target_os = "linux"))]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
#[cfg(not(target_os = "linux"))]
use log::error;

use super::configuration::AudioDevice;
#[cfg(not(target_os = "linux"))]
use super::configuration::DeviceType;
use super::platform;

/// List all available audio devices on the system
pub async fn list_audio_devices() -> Result<Vec<AudioDevice>> {
    // The sound server's list, read on a blocking thread. Callers that ask
    // while a listing runs share its answer (audio/pulse/devices.rs). The
    // default host's other devices are not added: on Linux that would open
    // every ALSA PCM again (#216).
    #[cfg(target_os = "linux")]
    {
        return tokio::task::spawn_blocking(|| platform::configure_linux_audio(&cpal::default_host()))
            .await
            .map_err(|error| anyhow::anyhow!("the device listing stopped: {error}"))?;
    }

    #[cfg(not(target_os = "linux"))]
    let host = cpal::default_host();

    // Platform-specific device enumeration
    #[cfg(not(target_os = "linux"))]
    let mut devices = {
        #[cfg(target_os = "windows")]
        {
            platform::configure_windows_audio(&host)?
        }

        #[cfg(target_os = "macos")]
        {
            platform::configure_macos_audio(&host)?
        }
    };

    // Add any additional devices from the default host
    #[cfg(not(target_os = "linux"))]
    if let Ok(other_devices) = host.devices() {
        for device in other_devices {
            if let Ok(name) = device.name() {
                if !devices.iter().any(|d| d.name == name) {
                    devices.push(AudioDevice::new(name, DeviceType::Output));
                }
            }
        }
    }

    #[cfg(not(target_os = "linux"))]
    Ok(devices)
}

/// Trigger audio permission request on platforms that require it
/// Returns Ok(true) if permission is granted, Ok(false) if denied, Err if something went wrong
///
/// Linux asks no permission; opening a device here would only open ALSA's
/// default PCM behind the sound server's back (#216), so it answers whether
/// a microphone is there.
#[cfg(target_os = "linux")]
pub fn trigger_audio_permission() -> Result<bool> {
    let present = platform::linux::microphone_present()
        .inspect_err(|error| log::error!("[trigger_audio_permission] Linux: {error:#}"))?;
    log::info!("[trigger_audio_permission] Linux: a microphone is present: {present}");
    Ok(present)
}

#[cfg(not(target_os = "linux"))]
pub fn trigger_audio_permission() -> Result<bool> {
    use log::info;

    let host = cpal::default_host();
    let device = match host.default_input_device() {
        Some(d) => d,
        None => {
            info!("[trigger_audio_permission] No default input device found - permission likely denied");
            return Ok(false);
        }
    };

    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            info!("[trigger_audio_permission] Failed to get input config: {} - permission likely denied", e);
            return Ok(false);
        }
    };

    // Build and start an input stream to trigger the permission request
    let stream = match device.build_input_stream(
        &config.into(),
        |_data: &[f32], _: &cpal::InputCallbackInfo| {
            // Do nothing, we just want to trigger the permission request
        },
        |err| error!("Error in audio stream: {}", err),
        None,
    ) {
        Ok(s) => s,
        Err(e) => {
            info!("[trigger_audio_permission] Failed to build input stream: {} - permission likely denied", e);
            return Ok(false);
        }
    };

    // Start the stream to actually trigger the permission dialog
    if let Err(e) = stream.play() {
        info!("[trigger_audio_permission] Failed to play stream: {} - permission likely denied", e);
        return Ok(false);
    }

    // Sleep briefly to allow the permission dialog to appear and for stream to actually work
    std::thread::sleep(std::time::Duration::from_millis(500));

    // If we got here, permission was granted
    info!("[trigger_audio_permission] Stream played successfully - permission granted");

    // Stop the stream
    drop(stream);

    Ok(true)
}