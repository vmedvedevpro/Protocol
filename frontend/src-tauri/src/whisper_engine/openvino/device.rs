//! Which OpenVINO device, if any, takes over the GPU whisper.cpp would use.
//!
//! The rule: OpenVINO runs Whisper only on the GPU the Vulkan build's whisper.cpp
//! would pick (`acceleration::whisper_gpu_device`: the first discrete GPU, else the
//! first GPU), and only when that GPU is an Intel one. OpenVINO's GPU plugin lists
//! only Intel GPUs (its OpenCL device query asks for vendor 0x8086), and reports
//! each one's PCI address (`DEVICE_PCI_INFO`) and vendor (`DEVICE_ARCHITECTURE`,
//! `GPU: vendor=0x8086 arch=…`). ggml-vulkan reports the PCI bus id of each Vulkan
//! device (`ggml_backend_dev_props::device_id`, `0000:00:02.0`). The two match by
//! address. So on a hybrid laptop whisper.cpp keeps the discrete NVIDIA or AMD GPU
//! it picks today, and an Intel iGPU plus an Intel Arc card gives the Arc card,
//! like whisper.cpp. Without a PCI bus id from Vulkan nothing matches, and
//! whisper.cpp keeps the GPU.

/// The Intel PCI vendor id.
pub const INTEL_VENDOR: u32 = 0x8086;

/// A PCI address: domain, bus, device, function.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PciAddress {
    pub domain: u32,
    pub bus: u32,
    pub device: u32,
    pub function: u32,
}

impl PciAddress {
    /// ggml's form, `domain:bus:device.function` in hex (`0000:00:02.0`).
    pub fn from_ggml(id: &str) -> Option<Self> {
        let (domain, rest) = id.split_once(':')?;
        let (bus, rest) = rest.split_once(':')?;
        let (device, function) = rest.split_once('.')?;
        let hex = |s: &str| u32::from_str_radix(s.trim(), 16).ok();
        Some(Self { domain: hex(domain)?, bus: hex(bus)?, device: hex(device)?, function: hex(function)? })
    }

    /// OpenVINO's `DEVICE_PCI_INFO` as a string: `{domain: 0 bus: 0 device: 0x2 function: 0}`.
    /// Numbers are decimal unless they start with `0x`.
    pub fn from_openvino(info: &str) -> Option<Self> {
        let field = |name: &str| -> Option<u32> {
            let start = info.find(&format!("{name}:"))? + name.len() + 1;
            let value = info[start..].split_whitespace().next()?.trim_end_matches(['}', ',']);
            match value.strip_prefix("0x") {
                Some(hex) => u32::from_str_radix(hex, 16).ok(),
                None => value.parse().ok(),
            }
        };
        Some(Self { domain: field("domain")?, bus: field("bus")?, device: field("device")?, function: field("function")? })
    }
}

/// The vendor in OpenVINO's GPU `DEVICE_ARCHITECTURE`, `GPU: vendor=0x8086 arch=v30.0.4`.
pub fn vendor_from_architecture(architecture: &str) -> Option<u32> {
    let value = architecture.split("vendor=").nth(1)?.split_whitespace().next()?;
    u32::from_str_radix(value.strip_prefix("0x").unwrap_or(value), 16).ok()
}

/// What the device rule needs of one OpenVINO device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenVinoGpu {
    /// `GPU`, `GPU.0`, `GPU.1`: the name a pipeline is created on.
    pub name: String,
    pub vendor: Option<u32>,
    pub pci: Option<PciAddress>,
}

/// The OpenVINO device to run Whisper on, given the PCI bus id of the GPU
/// whisper.cpp would pick (`None` when ggml reports none) and the OpenVINO GPUs.
pub fn openvino_device_for(chosen_gpu: Option<&str>, gpus: &[OpenVinoGpu]) -> Option<String> {
    let chosen = PciAddress::from_ggml(chosen_gpu?)?;
    gpus.iter()
        .find(|gpu| gpu.pci == Some(chosen) && gpu.vendor == Some(INTEL_VENDOR))
        .map(|gpu| gpu.name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(name: &str, vendor: u32, device: u32, bus: u32) -> OpenVinoGpu {
        OpenVinoGpu {
            name: name.into(),
            vendor: Some(vendor),
            pci: Some(PciAddress { domain: 0, bus, device, function: 0 }),
        }
    }

    #[test]
    fn addresses_parse_in_both_forms() {
        let address = PciAddress { domain: 0, bus: 0, device: 2, function: 0 };
        assert_eq!(PciAddress::from_ggml("0000:00:02.0"), Some(address));
        // The form the Arc B390 reports through the C API (2026.4.1).
        assert_eq!(PciAddress::from_openvino("{domain: 0 bus: 0 device: 0x2 function: 0}"), Some(address));
        assert_eq!(PciAddress::from_ggml("0000:03:00.0").map(|a| a.bus), Some(3));
        assert_eq!(PciAddress::from_openvino("{domain: 0 bus: 0x1a device: 0 function: 0}").map(|a| a.bus), Some(26));
        assert_eq!(PciAddress::from_ggml("garbage"), None);
        assert_eq!(PciAddress::from_openvino(""), None);
    }

    #[test]
    fn the_vendor_comes_from_the_architecture_string() {
        assert_eq!(vendor_from_architecture("GPU: vendor=0x8086 arch=v30.0.4"), Some(INTEL_VENDOR));
        assert_eq!(vendor_from_architecture("intel64"), None);
    }

    #[test]
    fn an_intel_igpu_that_whisper_cpp_picks_runs_on_openvino() {
        let gpus = [gpu("GPU", INTEL_VENDOR, 2, 0)];
        assert_eq!(openvino_device_for(Some("0000:00:02.0"), &gpus).as_deref(), Some("GPU"));
    }

    #[test]
    fn a_hybrid_laptop_keeps_its_discrete_nvidia_gpu_on_whisper_cpp() {
        // whisper.cpp picks the first discrete GPU (the NVIDIA card on bus 1);
        // OpenVINO lists only the Intel iGPU.
        let gpus = [gpu("GPU", INTEL_VENDOR, 2, 0)];
        assert_eq!(openvino_device_for(Some("0000:01:00.0"), &gpus), None);
    }

    #[test]
    fn an_intel_arc_card_beside_an_intel_igpu_runs_on_the_card() {
        let gpus = [gpu("GPU.0", INTEL_VENDOR, 2, 0), gpu("GPU.1", INTEL_VENDOR, 0, 3)];
        assert_eq!(openvino_device_for(Some("0000:03:00.0"), &gpus).as_deref(), Some("GPU.1"));
    }

    #[test]
    fn without_a_pci_bus_id_from_vulkan_nothing_matches() {
        let gpus = [gpu("GPU", INTEL_VENDOR, 2, 0)];
        assert_eq!(openvino_device_for(None, &gpus), None);
    }

    #[test]
    fn a_device_of_another_vendor_never_matches() {
        let gpus = [gpu("GPU", 0x10de, 2, 0)];
        assert_eq!(openvino_device_for(Some("0000:00:02.0"), &gpus), None);
    }
}
