//! Which OpenVINO device, if any, takes over the GPU whisper.cpp would use.
//!
//! The rule: OpenVINO runs Whisper only on the GPU the Vulkan build's whisper.cpp
//! would pick (`acceleration::whisper_gpu_device`: the first discrete GPU, else the
//! first GPU), and only when that GPU is an Intel one. OpenVINO's GPU plugin lists
//! only Intel GPUs (its OpenCL device query asks for vendor 0x8086), and reports
//! each one's PCI address (`DEVICE_PCI_INFO`), vendor (`DEVICE_ARCHITECTURE`,
//! `GPU: vendor=0x8086 arch=…`), name (`FULL_DEVICE_NAME`) and type
//! (`DEVICE_TYPE`). ggml-vulkan reports the chosen GPU's Vulkan device name, its
//! type and, when the driver offers `VK_EXT_pci_bus_info`, its PCI bus id.
//!
//! 1. With a PCI bus id from Vulkan, the address decides: the OpenVINO GPU at that
//!    address, if it is an Intel one.
//! 2. Without one (the Arc B390's Windows driver offers no `VK_EXT_pci_bus_info`):
//!    the one Intel OpenVINO GPU whose name, without the ` (iGPU)` / ` (dGPU)`
//!    suffix OpenVINO appends, is the Vulkan device name, and whose type agrees.
//!    Both names are the driver's device name. Two GPUs of that name and type
//!    (two identical cards) match nothing: the name cannot tell which one
//!    whisper.cpp uses.
//!
//! So on a hybrid laptop whisper.cpp keeps the discrete NVIDIA or AMD GPU it picks
//! today (neither its address nor its name is an Intel GPU's), and an Intel iGPU
//! plus an Intel Arc card gives the Arc card, like whisper.cpp.

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
    /// `FULL_DEVICE_NAME`, `Intel(R) Arc(TM) B390 GPU (iGPU)`.
    pub full_name: Option<String>,
    /// `DEVICE_TYPE` is `integrated`.
    pub integrated: Option<bool>,
    pub vendor: Option<u32>,
    pub pci: Option<PciAddress>,
}

impl OpenVinoGpu {
    /// The driver's device name: `FULL_DEVICE_NAME` without the suffix the GPU
    /// plugin appends for the device type.
    fn device_name(&self) -> Option<&str> {
        let full = self.full_name.as_deref()?.trim();
        Some(full.strip_suffix(" (iGPU)").or_else(|| full.strip_suffix(" (dGPU)")).unwrap_or(full))
    }
}

/// The GPU whisper.cpp would use, as ggml reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChosenGpu<'a> {
    pub pci_bus_id: Option<&'a str>,
    pub name: &'a str,
    pub integrated: bool,
}

/// How [`openvino_device_for`] matched, for the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchedBy {
    PciAddress,
    NameAndType,
}

/// The OpenVINO device to run Whisper on, given the GPU whisper.cpp would pick
/// (`None` without one) and the OpenVINO GPUs.
pub fn openvino_device_for(chosen: Option<ChosenGpu<'_>>, gpus: &[OpenVinoGpu]) -> Option<(String, MatchedBy)> {
    let chosen = chosen?;
    let intel = |gpu: &&OpenVinoGpu| gpu.vendor == Some(INTEL_VENDOR);
    if let Some(id) = chosen.pci_bus_id {
        let address = PciAddress::from_ggml(id)?;
        return gpus
            .iter()
            .filter(intel)
            .find(|gpu| gpu.pci == Some(address))
            .map(|gpu| (gpu.name.clone(), MatchedBy::PciAddress));
    }
    let mut same = gpus
        .iter()
        .filter(intel)
        .filter(|gpu| gpu.integrated == Some(chosen.integrated) && gpu.device_name() == Some(chosen.name.trim()));
    match (same.next(), same.next()) {
        (Some(gpu), None) => Some((gpu.name.clone(), MatchedBy::NameAndType)),
        _ => None,
    }
}

/// A display adapter as Windows lists it: the driver's device name (the name
/// Vulkan reports too) and the PCI vendor of its hardware id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayAdapter {
    pub name: String,
    pub vendor: Option<u32>,
}

/// The vendor in a hardware id, `PCI\VEN_8086&DEV_B080&SUBSYS_…`.
pub fn vendor_from_hardware_id(id: &str) -> Option<u32> {
    let upper = id.to_ascii_uppercase();
    let start = upper.find("VEN_")? + 4;
    u32::from_str_radix(upper.get(start..start + 4)?, 16).ok()
}

/// Whether to offer OpenVINO for the GPU whisper.cpp would use before the
/// runtime is installed, when OpenVINO cannot be asked yet (#79): that GPU is
/// an Intel GPU by the vendor of the display adapters Windows lists under its
/// name. A name no adapter has, or adapters of that name of another or an
/// unknown vendor, offer nothing. Once the runtime is installed,
/// [`openvino_device_for`] decides.
pub fn offer_for(chosen: Option<ChosenGpu<'_>>, adapters: &[DisplayAdapter]) -> bool {
    let Some(chosen) = chosen else { return false };
    let mut same = adapters.iter().filter(|adapter| adapter.name.trim() == chosen.name.trim()).peekable();
    same.peek().is_some() && same.all(|adapter| adapter.vendor == Some(INTEL_VENDOR))
}

/// The display adapters in Windows' display class
/// (`{4d36e968-e325-11ce-bfc1-08002be10318}`): `DriverDesc` and the vendor in
/// `MatchingDeviceId`. Entries of adapters no longer present stay listed
/// there; [`offer_for`] matches by name, so they only matter if they share
/// the GPU's name.
#[cfg(windows)]
pub fn display_adapters() -> Vec<DisplayAdapter> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;
    const DISPLAY_CLASS: &str = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let Ok(class) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(DISPLAY_CLASS, KEY_READ | KEY_WOW64_64KEY) else {
        return Vec::new();
    };
    class
        .enum_keys()
        .flatten()
        .filter_map(|key| class.open_subkey_with_flags(key, KEY_READ | KEY_WOW64_64KEY).ok())
        .filter_map(|adapter| {
            let name: String = adapter.get_value("DriverDesc").ok()?;
            let id: Option<String> = adapter.get_value("MatchingDeviceId").ok();
            Some(DisplayAdapter { name, vendor: id.as_deref().and_then(vendor_from_hardware_id) })
        })
        .collect()
}

/// Whether to offer OpenVINO on Linux before the runtime is installed
/// (#178): the GPU whisper.cpp would use has a PCI address from Vulkan
/// (Mesa's drivers offer `VK_EXT_pci_bus_info`), and the kernel lists an
/// Intel device there (`vendor_of`, read from sysfs by [`sysfs_vendor`]).
/// Without an address nothing is offered: Linux keeps no adapter names to
/// match a Vulkan name against, as Windows' registry does.
pub fn offer_by_address(chosen: Option<ChosenGpu<'_>>, vendor_of: impl Fn(PciAddress) -> Option<u32>) -> bool {
    chosen
        .and_then(|chosen| chosen.pci_bus_id)
        .and_then(PciAddress::from_ggml)
        .is_some_and(|address| vendor_of(address) == Some(INTEL_VENDOR))
}

/// The PCI vendor the kernel reports for `address` under `devices`
/// (`/sys/bus/pci/devices`): its `vendor` file, `0x8086`.
pub fn sysfs_vendor(devices: &std::path::Path, address: PciAddress) -> Option<u32> {
    let name = format!("{:04x}:{:02x}:{:02x}.{:x}", address.domain, address.bus, address.device, address.function);
    let text = std::fs::read_to_string(devices.join(name).join("vendor")).ok()?;
    u32::from_str_radix(text.trim().trim_start_matches("0x"), 16).ok()
}

/// Whether Intel's OpenCL driver is registered with the OpenCL loader on
/// Linux. OpenVINO's GPU plugin talks to the GPU through OpenCL alone (it
/// links `libOpenCL.so.1` and never Level Zero), so it needs Intel's OpenCL
/// driver, the compute runtime (NEO), whose library is `libigdrcl.so`.
/// `entries` are what the loader would load ([`icd_entries`]). Without the
/// driver the plugin lists no GPU, and Whisper would stay on Vulkan with
/// nothing said.
pub fn has_intel_driver(entries: &[String]) -> bool {
    entries.iter().any(|entry| entry.contains("libigdrcl"))
}

/// What the OpenCL loader (ocl-icd) would load, as texts naming libraries:
/// each library in `filenames` (`OCL_ICD_FILENAMES`, separated by `:`), and
/// the contents of the `.icd` files in `vendors` (`OCL_ICD_VENDORS`, a folder
/// or one `.icd` file, else `/etc/OpenCL/vendors`), or that path itself when
/// it names a library. Both variables are taken together, so a setup that
/// uses either is not called missing.
pub fn icd_entries(vendors: Option<&std::ffi::OsStr>, filenames: Option<&std::ffi::OsStr>) -> Vec<String> {
    let mut entries: Vec<String> = filenames
        .map(|list| list.to_string_lossy().split(':').filter(|name| !name.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
    let place = vendors.map_or_else(|| std::path::PathBuf::from("/etc/OpenCL/vendors"), std::path::PathBuf::from);
    if place.is_dir() {
        let read = std::fs::read_dir(&place).into_iter().flatten().flatten();
        entries.extend(
            read.filter(|item| item.path().extension().is_some_and(|extension| extension == "icd"))
                .filter_map(|item| std::fs::read_to_string(item.path()).ok()),
        );
    } else if place.extension().is_some_and(|extension| extension == "icd") {
        entries.extend(std::fs::read_to_string(&place).ok());
    } else if place.is_file() {
        entries.push(place.to_string_lossy().into_owned());
    }
    entries
}

/// Whether a load error is the dynamic loader not finding the OpenCL loader
/// GenAI and the GPU plugin link (`libOpenCL.so.1: cannot open shared object
/// file`).
pub fn names_missing_loader(error: &str) -> bool {
    error.contains("libOpenCL.so.1")
}

/// What Settings says when Intel's OpenCL driver is not registered. The
/// driver's package depends on the loader's, so it is the one to name.
pub fn driver_message() -> String {
    "Running Whisper on the Intel GPU needs Intel's OpenCL driver: install the intel-opencl-icd package (intel-compute-runtime on Fedora and Arch), then restart Protocol".to_string()
}

/// What Settings says when the OpenCL loader itself is missing.
pub fn loader_message() -> String {
    "Running Whisper on the Intel GPU needs the OpenCL loader: install the ocl-icd-libopencl1 package (ocl-icd on Fedora and Arch), then restart Protocol".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_offer_needs_an_intel_adapter_of_the_gpus_name() {
        let adapter = |name: &str, vendor| DisplayAdapter { name: name.to_string(), vendor };
        let arc = ChosenGpu { pci_bus_id: None, name: "Intel(R) Arc(TM) B390 GPU", integrated: true };
        let adapters = [
            // A stale entry of a GPU no longer there, as Windows keeps them.
            adapter("Intel(R) Arc(TM) B370 GPU", vendor_from_hardware_id(r"PCI\VEN_8086&DEV_B081")),
            adapter("Honor Virtual Display Device", vendor_from_hardware_id(r"IndirectDSP\VirtualDisplayDriver")),
            adapter("Intel(R) Arc(TM) B390 GPU", vendor_from_hardware_id(r"PCI\VEN_8086&DEV_B080&SUBSYS_209C1EE7")),
        ];
        assert!(offer_for(Some(arc), &adapters));
        assert!(!offer_for(None, &adapters));
        // A hybrid laptop: whisper.cpp uses the NVIDIA GPU.
        let nvidia = ChosenGpu { pci_bus_id: None, name: "NVIDIA GeForce RTX 4060 Laptop GPU", integrated: false };
        let hybrid = [adapter("Intel(R) Graphics", Some(INTEL_VENDOR)), adapter("NVIDIA GeForce RTX 4060 Laptop GPU", Some(0x10de))];
        assert!(!offer_for(Some(nvidia), &hybrid));
        // A name Windows does not list, or lists without a vendor.
        assert!(!offer_for(Some(arc), &hybrid));
        assert!(!offer_for(Some(arc), &[adapter("Intel(R) Arc(TM) B390 GPU", None)]));
        assert_eq!(vendor_from_hardware_id("pci\\ven_10de&dev_28e0"), Some(0x10de));
    }

    const B390: &str = "Intel(R) Arc(TM) B390 GPU";

    fn gpu(name: &str, full_name: &str, integrated: bool, vendor: u32, bus: u32, device: u32) -> OpenVinoGpu {
        OpenVinoGpu {
            name: name.into(),
            full_name: Some(full_name.into()),
            integrated: Some(integrated),
            vendor: Some(vendor),
            pci: Some(PciAddress { domain: 0, bus, device, function: 0 }),
        }
    }

    fn b390() -> OpenVinoGpu {
        gpu("GPU", "Intel(R) Arc(TM) B390 GPU (iGPU)", true, INTEL_VENDOR, 0, 2)
    }

    fn chosen<'a>(pci_bus_id: Option<&'a str>, name: &'a str, integrated: bool) -> Option<ChosenGpu<'a>> {
        Some(ChosenGpu { pci_bus_id, name, integrated })
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
    fn with_an_address_the_address_decides() {
        let found = openvino_device_for(chosen(Some("0000:00:02.0"), "another name", false), &[b390()]);
        assert_eq!(found, Some(("GPU".to_string(), MatchedBy::PciAddress)));
        // An address that is not an OpenVINO GPU's is not overruled by the name.
        assert_eq!(openvino_device_for(chosen(Some("0000:01:00.0"), B390, true), &[b390()]), None);
    }

    #[test]
    fn without_an_address_the_b390_matches_by_name_and_type() {
        // This laptop: the B390's driver offers no VK_EXT_pci_bus_info.
        let found = openvino_device_for(chosen(None, B390, true), &[b390()]);
        assert_eq!(found, Some(("GPU".to_string(), MatchedBy::NameAndType)));
        assert_eq!(openvino_device_for(chosen(None, B390, false), &[b390()]), None, "type must agree");
    }

    #[test]
    fn two_identical_cards_without_an_address_match_nothing() {
        let card = |name: &str, bus| gpu(name, "Intel(R) Arc(TM) A770 Graphics (dGPU)", false, INTEL_VENDOR, bus, 0);
        let gpus = [b390(), card("GPU.1", 3), card("GPU.2", 4)];
        assert_eq!(openvino_device_for(chosen(None, "Intel(R) Arc(TM) A770 Graphics", false), &gpus), None);
        // With addresses the same pair is told apart.
        let found = openvino_device_for(chosen(Some("0000:04:00.0"), "Intel(R) Arc(TM) A770 Graphics", false), &gpus);
        assert_eq!(found, Some(("GPU.2".to_string(), MatchedBy::PciAddress)));
    }

    #[test]
    fn a_hybrid_laptop_keeps_its_discrete_nvidia_gpu_on_whisper_cpp() {
        // whisper.cpp picks the first discrete GPU (the NVIDIA card on bus 1);
        // OpenVINO lists only the Intel iGPU.
        let nvidia = "NVIDIA GeForce RTX 4060 Laptop GPU";
        assert_eq!(openvino_device_for(chosen(Some("0000:01:00.0"), nvidia, false), &[b390()]), None);
        assert_eq!(openvino_device_for(chosen(None, nvidia, false), &[b390()]), None);
    }

    #[test]
    fn an_intel_arc_card_beside_an_intel_igpu_runs_on_the_card() {
        let arc = gpu("GPU.1", "Intel(R) Arc(TM) B580 Graphics (dGPU)", false, INTEL_VENDOR, 3, 0);
        let gpus = [gpu("GPU.0", "Intel(R) Graphics (iGPU)", true, INTEL_VENDOR, 0, 2), arc];
        let by_address = openvino_device_for(chosen(Some("0000:03:00.0"), "x", false), &gpus);
        assert_eq!(by_address.map(|found| found.0).as_deref(), Some("GPU.1"));
        let by_name = openvino_device_for(chosen(None, "Intel(R) Arc(TM) B580 Graphics", false), &gpus);
        assert_eq!(by_name.map(|found| found.0).as_deref(), Some("GPU.1"));
    }

    #[test]
    fn without_a_chosen_gpu_nothing_matches() {
        assert_eq!(openvino_device_for(None, &[b390()]), None);
    }

    #[test]
    fn a_device_of_another_vendor_never_matches() {
        let other = gpu("GPU", "Intel(R) Arc(TM) B390 GPU (iGPU)", true, 0x10de, 0, 2);
        assert_eq!(openvino_device_for(chosen(Some("0000:00:02.0"), B390, true), &[other.clone()]), None);
        assert_eq!(openvino_device_for(chosen(None, B390, true), &[other]), None);
    }

    #[test]
    fn on_linux_the_offer_needs_an_intel_device_at_the_gpus_address() {
        let intel_at_02 = |address: PciAddress| (address == PciAddress { domain: 0, bus: 0, device: 2, function: 0 }).then_some(INTEL_VENDOR);
        assert!(offer_by_address(chosen(Some("0000:00:02.0"), "Intel(R) Arc(tm) B390 (PTL)", true), intel_at_02));
        // An NVIDIA card at another address, an Intel name without an address,
        // a device sysfs does not list, and no GPU offer nothing.
        assert!(!offer_by_address(chosen(Some("0000:01:00.0"), "NVIDIA GeForce RTX 4060", false), intel_at_02));
        assert!(!offer_by_address(chosen(None, "Intel(R) Arc(tm) B390 (PTL)", true), intel_at_02));
        assert!(!offer_by_address(chosen(Some("0000:00:02.0"), "x", true), |_| None));
        assert!(!offer_by_address(None, intel_at_02));
    }

    #[test]
    fn the_vendor_is_read_from_sysfs() {
        let devices = tempfile::tempdir().unwrap();
        let dir = devices.path().join("0000:00:02.0");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("vendor"), "0x8086\n").unwrap();
        let address = PciAddress::from_ggml("0000:00:02.0").unwrap();
        assert_eq!(sysfs_vendor(devices.path(), address), Some(INTEL_VENDOR));
        assert_eq!(sysfs_vendor(devices.path(), PciAddress::from_ggml("0000:01:00.0").unwrap()), None);
    }

    #[test]
    fn the_missing_opencl_piece_is_named() {
        assert!(has_intel_driver(&["/usr/lib/x86_64-linux-gnu/intel-opencl/libigdrcl.so\n".to_string()]));
        assert!(!has_intel_driver(&[]));
        // Another vendor's driver (Mesa's rusticl) does not run the GPU plugin.
        assert!(!has_intel_driver(&["libRusticlOpenCL.so.1".to_string()]));
        assert!(names_missing_loader("libOpenCL.so.1: cannot open shared object file: No such file or directory"));
        assert!(!names_missing_loader("libopenvino.so: invalid ELF header"));
        assert!(driver_message().contains("install the intel-opencl-icd package"));
        assert!(loader_message().contains("install the ocl-icd-libopencl1 package (ocl-icd on Fedora and Arch)"));
    }

    #[test]
    fn the_icd_entries_follow_the_loaders_variables() {
        let root = tempfile::tempdir().unwrap();
        let vendors = root.path().join("vendors");
        std::fs::create_dir(&vendors).unwrap();
        std::fs::write(vendors.join("intel.icd"), "/opt/neo/libigdrcl.so\n").unwrap();
        std::fs::write(vendors.join("notes.txt"), "libigdrcl").unwrap();
        assert_eq!(icd_entries(Some(vendors.as_os_str()), None), ["/opt/neo/libigdrcl.so\n"]);
        // One .icd file, or a library named directly.
        assert_eq!(icd_entries(Some(vendors.join("intel.icd").as_os_str()), None), ["/opt/neo/libigdrcl.so\n"]);
        let library = root.path().join("libigdrcl.so");
        std::fs::write(&library, b"").unwrap();
        assert!(has_intel_driver(&icd_entries(Some(library.as_os_str()), None)));
        // OCL_ICD_FILENAMES alone, beside an empty vendors folder.
        let empty = root.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        let listed = icd_entries(Some(empty.as_os_str()), Some(std::ffi::OsStr::new("/a/libOther.so:/opt/neo/libigdrcl.so")));
        assert!(has_intel_driver(&listed), "{listed:?}");
        assert!(!has_intel_driver(&icd_entries(Some(empty.as_os_str()), None)));
    }
}
