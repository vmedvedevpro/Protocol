//! The Authenticode check of a downloaded runtime library (#79): beside its
//! pinned hash, a `.dll` must carry a valid signature of the runtime's
//! publisher, so a catalog that pins foreign bytes still cannot make the app
//! load them.
//!
//! `WinVerifyTrust` checks the signature embedded in the file and builds its
//! chain to a root Windows trusts; revocation is not checked (it needs the
//! certificate authority's servers, and the hash pin already fixes the bytes).
//! The signer is the leaf certificate's simple display name, as
//! `Get-AuthenticodeSignature` shows it (`CN=Intel Corporation`).

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use anyhow::{bail, Result};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::Cryptography::{CertGetNameStringW, CERT_NAME_SIMPLE_DISPLAY_TYPE};
use windows_sys::Win32::Security::WinTrust::{
    WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2,
    WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
    WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};

/// Fails unless `path` carries a valid Authenticode signature whose signer is
/// `signer`.
pub fn check_signed_by(path: &Path, signer: &str) -> Result<()> {
    let name = path.file_name().map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into_owned());
    match signer_of(path) {
        Ok(found) if found == signer => Ok(()),
        Ok(found) => bail!("{name} is signed by {found}, not by {signer}"),
        Err(status) => bail!("{name} does not carry a valid signature of {signer} (WinVerifyTrust 0x{status:08X})"),
    }
}

/// The signer of a valid embedded signature, or `WinVerifyTrust`'s status.
fn signer_of(path: &Path) -> std::result::Result<String, u32> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: wide.as_ptr(),
        hFile: std::ptr::null_mut(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    // SAFETY: zeroed is a valid WINTRUST_DATA (null pointers, zero flags);
    // the fields the call reads are set below and `file` and `wide` outlive
    // both calls.
    let mut data: WINTRUST_DATA = unsafe { std::mem::zeroed() };
    data.cbStruct = std::mem::size_of::<WINTRUST_DATA>() as u32;
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE;
    data.dwUnionChoice = WTD_CHOICE_FILE;
    data.Anonymous = WINTRUST_DATA_0 { pFile: &mut file };
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // No window: WTD_UI_NONE.
    let no_window = std::ptr::null_mut();
    // SAFETY: the documented verify-then-close sequence; the state handle is
    // read only between the two calls.
    unsafe {
        let status = WinVerifyTrust(no_window, &mut action, (&mut data as *mut WINTRUST_DATA).cast());
        let signer = if status == 0 { leaf_name(data.hWVTStateData) } else { Err(status as u32) };
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(no_window, &mut action, (&mut data as *mut WINTRUST_DATA).cast());
        signer
    }
}

/// The simple display name of the first signer's leaf certificate.
unsafe fn leaf_name(state: HANDLE) -> std::result::Result<String, u32> {
    const NO_SIGNER: u32 = 0x800B_0100; // TRUST_E_NOSIGNATURE
    let provider = WTHelperProvDataFromStateData(state);
    if provider.is_null() {
        return Err(NO_SIGNER);
    }
    let signer = WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
    if signer.is_null() || (*signer).csCertChain == 0 || (*signer).pasCertChain.is_null() {
        return Err(NO_SIGNER);
    }
    let cert = (*(*signer).pasCertChain).pCert;
    if cert.is_null() {
        return Err(NO_SIGNER);
    }
    let mut buffer = [0u16; 256];
    let written = CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, std::ptr::null(), buffer.as_mut_ptr(), buffer.len() as u32);
    // `written` counts the NUL; 1 means an empty name.
    if written <= 1 {
        return Err(NO_SIGNER);
    }
    Ok(String::from_utf16_lossy(&buffer[..written as usize - 1]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_without_a_signature_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("openvino_c.dll");
        std::fs::write(&path, b"MZ not a signed library").unwrap();
        let error = check_signed_by(&path, "Intel Corporation").unwrap_err().to_string();
        assert!(error.contains("does not carry a valid signature of Intel Corporation"), "{error}");
    }

    /// The real libraries of an installed runtime pass, and are refused for
    /// another publisher. Needs an install (the ignored
    /// `installs_the_catalogs_runtime_from_intel` makes one).
    #[test]
    #[ignore = "needs an installed OpenVINO runtime in OPENVINO_TEST_RUNTIME"]
    fn intels_libraries_are_signed_by_intel() {
        let dir = std::path::PathBuf::from(std::env::var_os("OPENVINO_TEST_RUNTIME").expect("OPENVINO_TEST_RUNTIME"));
        let libraries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|item| item.path())
            .filter(|path| path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("dll")))
            .collect();
        assert_eq!(libraries.len(), 12);
        for library in &libraries {
            check_signed_by(library, "Intel Corporation").unwrap();
        }
        let error = check_signed_by(&libraries[0], "Microsoft Corporation").unwrap_err().to_string();
        assert!(error.contains("is signed by Intel Corporation, not by Microsoft Corporation"), "{error}");
    }
}
