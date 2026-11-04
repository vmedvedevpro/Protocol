//! Whether this PC has an Intel NPU, known without Intel's runtime (#66), so
//! Settings can offer the NPU before anything is downloaded: a present
//! device of Windows' "Neural processors" setup class (ComputeAccelerator)
//! from Intel's PCI vendor. The class is the NPU driver's, so a device
//! without its driver does not count: OpenVINO could not use it either.
//! With the runtime loaded, the NPU plugin's `AVAILABLE_DEVICES` decides.

use std::sync::OnceLock;

use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDeviceInstanceIdW, DIGCF_PRESENT,
    GUID_DEVCLASS_COMPUTEACCELERATOR, SP_DEVINFO_DATA,
};

/// The instance IDs of the present devices of the ComputeAccelerator class.
fn accelerators() -> Vec<String> {
    let mut found = Vec::new();
    // SAFETY: the device list is destroyed before returning; each call gets
    // buffers of the sizes it is told.
    unsafe {
        let list = SetupDiGetClassDevsW(&GUID_DEVCLASS_COMPUTEACCELERATOR, std::ptr::null(), std::ptr::null_mut(), DIGCF_PRESENT);
        if list == -1 {
            log::warn!("[npu] cannot list the neural processors: {}", std::io::Error::last_os_error());
            return found;
        }
        let mut index = 0;
        loop {
            let mut device: SP_DEVINFO_DATA = std::mem::zeroed();
            device.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
            if SetupDiEnumDeviceInfo(list, index, &mut device) == 0 {
                break;
            }
            index += 1;
            let mut id = [0u16; 512];
            let mut needed = 0u32;
            if SetupDiGetDeviceInstanceIdW(list, &device, id.as_mut_ptr(), id.len() as u32, &mut needed) != 0 {
                let length = id.iter().position(|&unit| unit == 0).unwrap_or(id.len());
                found.push(String::from_utf16_lossy(&id[..length]));
            }
        }
        SetupDiDestroyDeviceInfoList(list);
    }
    found
}

/// Whether one of `ids` is an Intel device on PCI.
fn intel_among(ids: &[String]) -> bool {
    ids.iter().any(|id| id.to_ascii_uppercase().starts_with("PCI\\VEN_8086&"))
}

/// Whether an Intel NPU with its driver is present. Read once per process:
/// the NPU is part of the processor.
pub fn present() -> bool {
    static PRESENT: OnceLock<bool> = OnceLock::new();
    *PRESENT.get_or_init(|| {
        #[cfg(test)]
        if let Ok(forced) = std::env::var("NPU_TEST_PRESENT") {
            return forced == "1";
        }
        let ids = accelerators();
        let present = intel_among(&ids);
        log::info!("[npu] neural processors: {ids:?}; an Intel NPU is {}", if present { "present" } else { "absent" });
        present
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_intel_pci_device_counts() {
        let ids = |list: &[&str]| list.iter().map(|id| id.to_string()).collect::<Vec<_>>();
        assert!(intel_among(&ids(&["PCI\\VEN_8086&DEV_B03E&SUBSYS_00000000&REV_04\\3&11583659&0&58"])));
        assert!(intel_among(&ids(&["pci\\ven_8086&dev_7d1d\\x"])));
        assert!(!intel_among(&ids(&["PCI\\VEN_1022&DEV_1502\\x", "ACPI\\VEN_8086\\x"])));
        assert!(!intel_among(&[]));
    }

    #[test]
    fn listing_the_neural_processors_does_not_fail() {
        // Whatever this PC has; the call itself must come back.
        let found = accelerators();
        println!("{found:?}");
    }
}
