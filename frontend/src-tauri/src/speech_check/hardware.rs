//! What the Speech check's report says about this computer (#233). It reads
//! what the app's own device decisions read, plus what a developer needs to
//! place a report: the OS, the processor, the GPUs and their drivers.
//! Nothing here names the user, the computer or an audio device.

use super::report::{Gpu, System};

pub fn system() -> System {
    let mut info = sysinfo::System::new();
    info.refresh_cpu_all();
    info.refresh_memory();
    let processor = info
        .cpus()
        .first()
        .map(|cpu| cpu.brand().trim().to_string())
        .filter(|brand| !brand.is_empty())
        .unwrap_or_else(|| std::env::consts::ARCH.to_string());
    #[cfg(target_arch = "x86_64")]
    let (avx2, avx512) = (Some(std::is_x86_feature_detected!("avx2")), Some(std::is_x86_feature_detected!("avx512f")));
    #[cfg(not(target_arch = "x86_64"))]
    let (avx2, avx512) = (None, None);
    let linux = cfg!(target_os = "linux");
    let environment = |name: &str| std::env::var(name).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    let (onnx_runtime, onnx_providers) = onnx_runtime();
    System {
        protocol_version: env!("CARGO_PKG_VERSION").to_string(),
        package: package(),
        whisper_build: crate::whisper_engine::acceleration::WhisperCompiledBackend::current().as_str().to_string(),
        os: std::env::consts::OS.to_string(),
        os_version: sysinfo::System::os_version().unwrap_or_default(),
        distribution: if linux { sysinfo::System::long_os_version() } else { None },
        desktop: if linux { environment("XDG_CURRENT_DESKTOP") } else { None },
        session: if linux { environment("XDG_SESSION_TYPE") } else { None },
        processor,
        threads: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        avx2,
        avx512,
        ram_gb: (info.total_memory() as f64 / 1_073_741_824.0 * 10.0).round() / 10.0,
        gpus: gpus(),
        vulkan_devices: vulkan_devices(),
        intel_opencl: intel_opencl(),
        npu: npu(),
        onnx_runtime,
        onnx_providers,
    }
}

/// How this copy was installed, from the marker the bundler writes into the
/// executable (`updater::support`).
fn package() -> String {
    use tauri::utils::config::BundleType;
    match tauri::utils::platform::bundle_type() {
        Some(BundleType::Deb) => "deb".into(),
        Some(BundleType::Rpm) => "rpm".into(),
        Some(BundleType::AppImage) => "AppImage".into(),
        Some(BundleType::Nsis) => "installer (NSIS)".into(),
        Some(BundleType::Msi) => "installer (MSI)".into(),
        Some(BundleType::App | BundleType::Dmg) => "macOS app".into(),
        _ if cfg!(debug_assertions) => "development build".into(),
        _ => "not installed by a package".into(),
    }
}

fn vendor_name(vendor: u32) -> Option<&'static str> {
    match vendor {
        0x8086 => Some("Intel"),
        0x10de => Some("NVIDIA"),
        0x1002 | 0x1022 => Some("AMD"),
        0x106b => Some("Apple"),
        0x1af4 => Some("virtio"),
        0x15ad => Some("VMware"),
        0x1414 => Some("Microsoft"),
        _ => None,
    }
}

/// Linux: the kernel's DRM devices (`/sys/class/drm/cardN`), each with its
/// PCI vendor and device, its kernel driver and, when the module states one
/// (NVIDIA's does, the in-tree ones do not), its version. Mesa's name and
/// version are not readable without a Vulkan or OpenGL context of its own.
#[cfg(target_os = "linux")]
fn gpus() -> Vec<Gpu> {
    let read = |path: std::path::PathBuf| std::fs::read_to_string(path).ok().map(|text| text.trim().to_string());
    let mut cards: Vec<_> = std::fs::read_dir("/sys/class/drm")
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.strip_prefix("card").is_some_and(|rest| !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit())))
        .collect();
    cards.sort();
    cards
        .into_iter()
        .filter_map(|card| {
            let device = std::path::Path::new("/sys/class/drm").join(&card).join("device");
            let vendor = read(device.join("vendor")).and_then(|text| u32::from_str_radix(text.trim_start_matches("0x"), 16).ok())?;
            let id = read(device.join("device")).unwrap_or_default();
            let address = std::fs::canonicalize(&device).ok().and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned()));
            let driver = std::fs::read_link(device.join("driver"))
                .ok()
                .and_then(|link| link.file_name().map(|name| name.to_string_lossy().into_owned()));
            let driver_version = driver.as_deref().and_then(|driver| {
                read(std::path::Path::new("/sys/module").join(driver).join("version"))
                    .or_else(|| (driver == "nvidia").then(|| read("/proc/driver/nvidia/version".into())).flatten())
            });
            Some(Gpu {
                name: format!("PCI {vendor:04x}:{} at {}", id.trim_start_matches("0x"), address.unwrap_or(card)),
                vendor: vendor_name(vendor).map(str::to_string),
                driver,
                driver_version,
            })
        })
        .collect()
}

/// Windows: the display adapters in the display class, as
/// `openvino::device::display_adapters` reads them, with each driver's
/// version. The class keeps a key for every adapter ever installed, so only
/// the keys a present device names as its driver are read.
#[cfg(windows)]
fn gpus() -> Vec<Gpu> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;
    const DISPLAY_CLASS: &str = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let Ok(class) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(DISPLAY_CLASS, KEY_READ | KEY_WOW64_64KEY) else {
        return Vec::new();
    };
    // Without SetupAPI's list every key is read, as before: a removed adapter
    // listed is better than none.
    let present = present_display_keys();
    class
        .enum_keys()
        .flatten()
        .filter(|key| present.as_ref().is_none_or(|present| present.contains(&key.to_ascii_lowercase())))
        .filter_map(|key| class.open_subkey_with_flags(key, KEY_READ | KEY_WOW64_64KEY).ok())
        .filter_map(|adapter| {
            let name: String = adapter.get_value("DriverDesc").ok()?;
            let id: Option<String> = adapter.get_value("MatchingDeviceId").ok();
            let vendor = id.as_deref().and_then(crate::whisper_engine::openvino::device::vendor_from_hardware_id);
            let driver_version: Option<String> = adapter.get_value("DriverVersion").ok();
            Some(Gpu { name, vendor: vendor.and_then(vendor_name).map(str::to_string), driver: None, driver_version })
        })
        .collect()
}

/// The display class's subkeys (`0000`, `0001`…) of the present display
/// devices: SetupAPI's `SPDRP_DRIVER` is `{4d36e968-…}\0001` for each, as
/// `npu/detect.rs` lists the present neural processors.
#[cfg(windows)]
fn present_display_keys() -> Option<Vec<String>> {
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDeviceRegistryPropertyW, DIGCF_PRESENT,
        GUID_DEVCLASS_DISPLAY, SPDRP_DRIVER, SP_DEVINFO_DATA,
    };
    let mut keys = Vec::new();
    // SAFETY: the device list is destroyed before returning; the property call
    // gets a buffer of the size it is told, in bytes.
    unsafe {
        let list = SetupDiGetClassDevsW(&GUID_DEVCLASS_DISPLAY, std::ptr::null(), std::ptr::null_mut(), DIGCF_PRESENT);
        if list == -1 {
            log::warn!("[speech check] cannot list the display adapters: {}", std::io::Error::last_os_error());
            return None;
        }
        let mut index = 0;
        loop {
            let mut device: SP_DEVINFO_DATA = std::mem::zeroed();
            device.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
            if SetupDiEnumDeviceInfo(list, index, &mut device) == 0 {
                break;
            }
            index += 1;
            let mut driver = [0u16; 256];
            let mut needed = 0u32;
            let bytes = (driver.len() * 2) as u32;
            if SetupDiGetDeviceRegistryPropertyW(list, &device, SPDRP_DRIVER, std::ptr::null_mut(), driver.as_mut_ptr().cast(), bytes, &mut needed) != 0 {
                let length = driver.iter().position(|&unit| unit == 0).unwrap_or(driver.len());
                if let Some(key) = String::from_utf16_lossy(&driver[..length]).rsplit('\\').next() {
                    keys.push(key.to_ascii_lowercase());
                }
            }
        }
        SetupDiDestroyDeviceInfoList(list);
    }
    Some(keys)
}

/// macOS: the chip runs Metal; no list is read.
#[cfg(not(any(windows, target_os = "linux")))]
fn gpus() -> Vec<Gpu> {
    Vec::new()
}

/// The GPUs ggml's registry lists, as `<name>: <description>` (`Vulkan0:
/// Intel(R) Arc(tm) B390 (PTL)`). The registry names a device but not its
/// Vulkan driver; the GPU lines give the kernel driver. Asking ggml looks
/// for its devices inside the Vulkan guard, as every model load does first.
#[cfg(feature = "vulkan")]
fn vulkan_devices() -> Vec<String> {
    use whisper_rs::whisper_rs_sys as sys;
    crate::whisper_engine::vulkan::look_for_devices();
    let text = |pointer: *const std::ffi::c_char| {
        // SAFETY: ggml's strings live as long as its devices and are copied here.
        (!pointer.is_null()).then(|| unsafe { std::ffi::CStr::from_ptr(pointer) }.to_string_lossy().into_owned())
    };
    // SAFETY: as `acceleration::ggml_device_kinds`: registry calls on the
    // handles the registry returns, for indices below its count.
    unsafe {
        (0..sys::ggml_backend_dev_count())
            .map(|index| sys::ggml_backend_dev_get(index))
            .filter(|device| {
                matches!(
                    sys::ggml_backend_dev_type(*device),
                    sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_GPU | sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_IGPU
                )
            })
            .filter_map(|device| match (text(sys::ggml_backend_dev_name(device)), text(sys::ggml_backend_dev_description(device))) {
                (Some(name), Some(description)) => Some(format!("{name}: {description}")),
                (name, description) => name.or(description),
            })
            .collect()
    }
}

#[cfg(not(feature = "vulkan"))]
fn vulkan_devices() -> Vec<String> {
    Vec::new()
}

#[cfg(target_os = "linux")]
fn intel_opencl() -> Option<bool> {
    use crate::whisper_engine::openvino::device;
    let entries = device::icd_entries(std::env::var_os("OCL_ICD_VENDORS").as_deref(), std::env::var_os("OCL_ICD_FILENAMES").as_deref());
    Some(device::has_intel_driver(&entries))
}

#[cfg(not(target_os = "linux"))]
fn intel_opencl() -> Option<bool> {
    None
}

/// Windows: whether an Intel NPU is there and the state #66 gives it.
#[cfg(windows)]
fn npu() -> Option<String> {
    let status = crate::parakeet_engine::npu::state::status();
    Some(if status.present { format!("Intel NPU, {:?}", status.state).to_lowercase() } else { "none".into() })
}

#[cfg(not(windows))]
fn npu() -> Option<String> {
    None
}

/// ONNX Runtime's version and the execution providers it was built with,
/// among those the app uses; whether a session gets one is the step's business.
fn onnx_runtime() -> (String, Vec<String>) {
    use ort::ep::ExecutionProvider;
    if let Err(error) = crate::onnx_runtime::environment() {
        return (format!("not available: {error}"), Vec::new());
    }
    let version = match crate::onnx_runtime::version() {
        Some(version) => format!("{version} ({})", ort::info()),
        None => ort::info().to_string(),
    };
    let mut providers = Vec::new();
    if ort::ep::CPU::is_available().unwrap_or(false) {
        providers.push("CPU".to_string());
    }
    #[cfg(windows)]
    if ort::ep::DirectML::is_available().unwrap_or(false) {
        providers.push("DirectML".to_string());
    }
    (version, providers)
}
