// Audio capture implementations module

pub mod microphone;
pub mod backend_config;
pub mod per_app;

#[cfg(target_os = "macos")]
pub mod core_audio;

#[cfg(target_os = "macos")]
pub use core_audio::{CoreAudioCapture, CoreAudioStream};

// Re-export backend configuration
pub use backend_config::{
    AudioCaptureBackend, BackendConfig, BACKEND_CONFIG,
    get_current_backend, set_current_backend, get_available_backends
};