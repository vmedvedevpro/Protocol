//! The processor check that runs before anything else in the process (#216,
//! was #194).
//!
//! ggml is built for x86-64-v3 on Windows and Linux (#185, docs/DEVELOPMENT_MAP.md
//! › ggml CPU baseline): AVX2, FMA, F16C, BMI1/2, LZCNT and MOVBE on top of
//! SSE4.2. On an older processor the first such instruction stops the
//! process with an illegal instruction, with nothing on screen to say why.
//! ggml is linked into the executable, and its C++ static initializers run
//! before `main`, so the check cannot wait for `main`: the binary registers
//! `check_before_start` with `cpu_check_before_static_initializers!` in a
//! section the loader runs ahead of every static initializer, the
//! executable's `.preinit_array` on Linux and `.CRT$XCB` on Windows (the CRT
//! runs `.CRT$XCA`..`.CRT$XCZ` in name order; C++ and Rust initializers use
//! `.CRT$XCU` and `.CRT$XCT`). The speech and summary runtimes (OpenVINO
//! GenAI, llama-helper) load later still.
//!
//! The check itself is Rust built for the plain x86-64 baseline: Cargo sets
//! no `target-cpu` for these builds (only ggml's CMake gets the `GGML_*`
//! flags), and the release legs' baseline check reads the executable.
//! It uses CPUID and XGETBV and nothing else before deciding.

/// The instruction sets ggml's x86-64-v3 build may use, as CPUID reports them.
#[cfg_attr(not(target_arch = "x86_64"), allow(dead_code))]
const REQUIRED: &[(&str, Bit)] = &[
    ("SSE3", Bit::Leaf1Ecx(0)),
    ("SSSE3", Bit::Leaf1Ecx(9)),
    ("SSE4.1", Bit::Leaf1Ecx(19)),
    ("SSE4.2", Bit::Leaf1Ecx(20)),
    ("POPCNT", Bit::Leaf1Ecx(23)),
    ("CMPXCHG16B", Bit::Leaf1Ecx(13)),
    ("MOVBE", Bit::Leaf1Ecx(22)),
    ("AVX", Bit::Leaf1Ecx(28)),
    ("FMA", Bit::Leaf1Ecx(12)),
    ("F16C", Bit::Leaf1Ecx(29)),
    ("AVX2", Bit::Leaf7Ebx(5)),
    ("BMI1", Bit::Leaf7Ebx(3)),
    ("BMI2", Bit::Leaf7Ebx(8)),
    ("LZCNT", Bit::Extended1Ecx(5)),
];

/// The ones that use the 256-bit registers, which also need the operating
/// system to save them (OSXSAVE, and XCR0's SSE and AVX state bits).
const NEED_YMM_STATE: &[&str] = &["AVX", "FMA", "F16C", "AVX2"];

#[derive(Clone, Copy)]
enum Bit {
    Leaf1Ecx(u32),
    Leaf7Ebx(u32),
    Extended1Ecx(u32),
}

/// CPUID's registers for one leaf and subleaf: eax, ebx, ecx, edx.
pub type Registers = [u32; 4];

/// The required features this processor lacks, in `REQUIRED`'s order; empty
/// when it can run Protocol. `cpuid` and `xcr0` are the processor's (or a
/// test's fake): `xcr0` is only called when CPUID reports OSXSAVE.
pub fn missing_features(cpuid: impl Fn(u32, u32) -> Registers, xcr0: impl Fn() -> u64) -> Vec<&'static str> {
    let max_leaf = cpuid(0, 0)[0];
    let max_extended = cpuid(0x8000_0000, 0)[0];
    let leaf1 = if max_leaf >= 1 { cpuid(1, 0) } else { [0; 4] };
    let leaf7 = if max_leaf >= 7 { cpuid(7, 0) } else { [0; 4] };
    let extended1 = if max_extended >= 0x8000_0001 { cpuid(0x8000_0001, 0) } else { [0; 4] };

    const OSXSAVE: u32 = 1 << 27;
    // XCR0 bit 1 is SSE (xmm) state, bit 2 AVX (upper ymm) state.
    let ymm_state = leaf1[2] & OSXSAVE != 0 && xcr0() & 0b110 == 0b110;

    REQUIRED
        .iter()
        .filter(|(name, bit)| {
            let present = match *bit {
                Bit::Leaf1Ecx(n) => leaf1[2] >> n & 1 == 1,
                Bit::Leaf7Ebx(n) => leaf7[1] >> n & 1 == 1,
                Bit::Extended1Ecx(n) => extended1[2] >> n & 1 == 1,
            };
            !present || (NEED_YMM_STATE.contains(name) && !ymm_state)
        })
        .map(|(name, _)| *name)
        .collect()
}

/// The message shown on an unsupported processor.
pub fn message(missing: &[&str]) -> String {
    format!(
        "Protocol cannot run on this processor.\n\n\
         It needs a 64-bit processor with AVX2 (x86-64-v3): an Intel Core from 2013 \
         (Haswell) or later, or an AMD processor from 2015 (Excavator) or later. \
         Some later Pentium, Celeron and Atom models lack AVX2 too.\n\n\
         This processor lacks: {}.",
        missing.join(", ")
    )
}

/// This processor's missing features.
#[cfg(target_arch = "x86_64")]
pub fn this_processor_missing() -> Vec<&'static str> {
    use std::arch::x86_64::__cpuid_count;
    missing_features(
        |leaf, subleaf| {
            // SAFETY: CPUID exists on every x86-64 processor (the intrinsic
            // is safe since Rust 1.94; `unsafe` keeps 1.92 building).
            #[allow(unused_unsafe)]
            let r = unsafe { __cpuid_count(leaf, subleaf) };
            [r.eax, r.ebx, r.ecx, r.edx]
        },
        // SAFETY: called only when CPUID reports OSXSAVE, so XGETBV exists
        // and the operating system has enabled it.
        || unsafe { xgetbv0() },
    )
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "xsave")]
unsafe fn xgetbv0() -> u64 {
    std::arch::x86_64::_xgetbv(0)
}

/// Runs from the loader, before static initializers and `main`: on a
/// processor that cannot run ggml it shows the message and ends the process.
/// Nothing here may assume Rust's runtime has started.
///
/// On Linux `envp` is the environment the loader hands `.preinit_array`
/// functions. `environ` is still null there (glibc 2.44: the loader runs the
/// executable's preinit functions before libc.so's own initializer sets it;
/// glibc bug 30424), so `std::env` reads an empty environment, and a dialog
/// started with it finds no display (`DISPLAY`, `WAYLAND_DISPLAY`) and shows
/// nothing. Nothing here may `dlopen` either (same bug).
///
/// # Safety
/// `envp` is null or a null-terminated array of NUL-terminated strings, as
/// the loader passes it.
#[cfg(all(target_arch = "x86_64", target_os = "linux"))]
pub unsafe fn check_before_start(envp: *const *const std::ffi::c_char) {
    let missing = this_processor_missing();
    if missing.is_empty() {
        return;
    }
    // SAFETY: as the caller promises.
    let environment = unsafe { environment(envp) };
    fail(&message(&missing), |text| show(text, &environment));
}

#[cfg(all(target_arch = "x86_64", windows))]
pub fn check_before_start() {
    let missing = this_processor_missing();
    if missing.is_empty() {
        return;
    }
    fail(&message(&missing), show);
}

#[cfg(all(target_arch = "x86_64", any(windows, target_os = "linux")))]
fn fail(text: &str, show: impl FnOnce(&str)) -> ! {
    {
        use std::io::Write;
        let _ = writeln!(std::io::stderr(), "{text}");
    }
    show(text);
    std::process::exit(1);
}

/// The `NAME=value` pairs of a loader-supplied `envp`.
///
/// # Safety
/// As for `check_before_start`.
#[cfg(unix)]
pub unsafe fn environment(envp: *const *const std::ffi::c_char) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    use std::os::unix::ffi::OsStrExt;
    let mut pairs = Vec::new();
    if envp.is_null() {
        return pairs;
    }
    let mut entry = envp;
    // SAFETY: the array ends with a null pointer and each entry is a C string.
    while let Some(text) = unsafe { (*entry).as_ref() } {
        let bytes = unsafe { std::ffi::CStr::from_ptr(text) }.to_bytes();
        if let Some(split) = bytes.iter().position(|&byte| byte == b'=') {
            let (name, value) = (&bytes[..split], &bytes[split + 1..]);
            pairs.push((std::ffi::OsStr::from_bytes(name).to_owned(), std::ffi::OsStr::from_bytes(value).to_owned()));
        }
        entry = unsafe { entry.add(1) };
    }
    pairs
}

/// One message box from the system, before any window toolkit has started.
#[cfg(all(target_arch = "x86_64", windows))]
fn show(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (body, title) = (wide(text), wide("Protocol"));
    // SAFETY: both strings are NUL-terminated UTF-16 that outlive the call.
    unsafe { MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
}

/// The desktop's own dialog tool: GTK is not started this early, and KDE
/// and GNOME both ship one (kdialog, zenity). Without either, the message
/// went to stderr above, which a terminal or the journal shows.
#[cfg(all(target_arch = "x86_64", target_os = "linux"))]
fn show(text: &str, environment: &[(std::ffi::OsString, std::ffi::OsString)]) {
    let kde = environment
        .iter()
        .any(|(name, value)| name == "XDG_CURRENT_DESKTOP" && value.to_string_lossy().to_ascii_uppercase().contains("KDE"));
    let kdialog = || {
        let mut command = std::process::Command::new("kdialog");
        command.args(["--title", "Protocol", "--error", text]);
        command
    };
    let zenity = || {
        let mut command = std::process::Command::new("zenity");
        // zenity reads Pango markup; the message has none of & < >.
        command.args(["--error", "--title=Protocol", "--width=420", &format!("--text={text}")]);
        command
    };
    let tools: [&dyn Fn() -> std::process::Command; 2] = if kde { [&kdialog, &zenity] } else { [&zenity, &kdialog] };
    for tool in tools {
        let mut command = tool();
        // The loader's environment, not `environ` (see `check_before_start`),
        // without what the AppImage points at its own libraries and modules,
        // which the system's dialog tool must not load.
        const APPIMAGE_ONLY: [&str; 10] = ["LD_LIBRARY_PATH", "LD_PRELOAD", "GTK_PATH", "GTK_EXE_PREFIX", "GTK_DATA_PREFIX", "GDK_PIXBUF_MODULE_FILE", "GDK_PIXBUF_MODULEDIR", "GIO_MODULE_DIR", "GSETTINGS_SCHEMA_DIR", "QT_PLUGIN_PATH"];
        command.env_clear();
        command.envs(environment.iter().filter(|(name, _)| !APPIMAGE_ONLY.iter().any(|skip| name == skip)).map(|(name, value)| (name, value)));
        if command.status().is_ok() {
            return;
        }
    }
}

/// Registers `check_before_start` to run before every static initializer of
/// the executable. Expanded in `main.rs`: the sections only work in the
/// executable itself (`.preinit_array` is ignored in shared objects).
#[macro_export]
macro_rules! cpu_check_before_static_initializers {
    () => {
        #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
        #[used]
        #[link_section = ".preinit_array"]
        static CPU_CHECK: extern "C" fn(::std::ffi::c_int, *const *const ::std::ffi::c_char, *const *const ::std::ffi::c_char) = {
            // glibc calls preinit functions with argc, argv and envp.
            extern "C" fn check(_argc: ::std::ffi::c_int, _argv: *const *const ::std::ffi::c_char, envp: *const *const ::std::ffi::c_char) {
                // SAFETY: the loader passes the process's envp.
                unsafe { $crate::cpu_support::check_before_start(envp) };
            }
            check
        };

        #[cfg(all(target_arch = "x86_64", windows))]
        #[used]
        #[link_section = ".CRT$XCB"]
        static CPU_CHECK: extern "C" fn() = {
            extern "C" fn check() {
                $crate::cpu_support::check_before_start();
            }
            check
        };
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake processor: leaf 1 ecx, leaf 7 ebx, extended leaf 1 ecx, XCR0.
    fn processor(leaf1_ecx: u32, leaf7_ebx: u32, extended1_ecx: u32, xcr0: u64) -> Vec<&'static str> {
        missing_features(
            move |leaf, _| match leaf {
                0 => [7, 0, 0, 0],
                1 => [0, 0, leaf1_ecx, 0],
                7 => [0, leaf7_ebx, 0, 0],
                0x8000_0000 => [0x8000_0001, 0, 0, 0],
                0x8000_0001 => [0, 0, extended1_ecx, 0],
                _ => [0; 4],
            },
            move || xcr0,
        )
    }

    const OSXSAVE: u32 = 1 << 27;
    // What a Haswell reports: every v2 and v3 bit of leaf 1, AVX2/BMI1/BMI2, LZCNT.
    const HASWELL_LEAF1: u32 = 1 | 1 << 9 | 1 << 12 | 1 << 13 | 1 << 19 | 1 << 20 | 1 << 22 | 1 << 23 | OSXSAVE | 1 << 28 | 1 << 29;
    const HASWELL_LEAF7: u32 = 1 << 3 | 1 << 5 | 1 << 8;
    const LZCNT: u32 = 1 << 5;

    #[test]
    fn a_haswell_runs() {
        assert!(processor(HASWELL_LEAF1, HASWELL_LEAF7, LZCNT, 0b111).is_empty());
    }

    #[test]
    fn sandy_bridge_lacks_the_v3_features() {
        // AVX but no FMA, F16C, MOVBE, AVX2, BMI or LZCNT (Core i7-2600).
        let leaf1 = HASWELL_LEAF1 & !(1 << 12 | 1 << 22 | 1 << 29);
        assert_eq!(processor(leaf1, 0, 0, 0b111), ["MOVBE", "FMA", "F16C", "AVX2", "BMI1", "BMI2", "LZCNT"]);
    }

    #[test]
    fn a_pentium_without_avx_lacks_them_all() {
        // A Pentium Gold of 2017: SSE4.2 and BMI, no AVX at all.
        let leaf1 = HASWELL_LEAF1 & !(1 << 12 | 1 << 28 | 1 << 29);
        assert_eq!(processor(leaf1, 1 << 3, LZCNT, 0b111), ["AVX", "FMA", "F16C", "AVX2", "BMI2"]);
    }

    #[test]
    fn avx_the_operating_system_does_not_save_counts_as_missing() {
        // A Haswell in a VM whose hypervisor keeps the ymm state off.
        assert_eq!(processor(HASWELL_LEAF1, HASWELL_LEAF7, LZCNT, 0b011), NEED_YMM_STATE);
        assert_eq!(processor(HASWELL_LEAF1 & !OSXSAVE, HASWELL_LEAF7, LZCNT, 0b111), NEED_YMM_STATE);
    }

    #[test]
    fn the_message_names_what_is_missing() {
        let text = message(&["AVX2", "FMA"]);
        assert!(text.starts_with("Protocol cannot run on this processor."));
        assert!(text.ends_with("This processor lacks: AVX2, FMA."));
    }

    #[test]
    #[cfg(unix)]
    fn the_loaders_envp_is_read_as_pairs() {
        let entries = [c"DISPLAY=:0".as_ptr(), c"XDG_CURRENT_DESKTOP=KDE".as_ptr(), c"EMPTY=".as_ptr(), c"A=b=c".as_ptr(), std::ptr::null()];
        // SAFETY: a null-terminated array of C strings, as the loader passes.
        let pairs = unsafe { environment(entries.as_ptr()) };
        let pairs: Vec<(&str, &str)> = pairs.iter().map(|(name, value)| (name.to_str().unwrap(), value.to_str().unwrap())).collect();
        assert_eq!(pairs, [("DISPLAY", ":0"), ("XDG_CURRENT_DESKTOP", "KDE"), ("EMPTY", ""), ("A", "b=c")]);
        assert!(unsafe { environment(std::ptr::null()) }.is_empty());
    }

    #[test]
    #[cfg(target_arch = "x86_64")]
    fn this_machine_runs_the_tests() {
        // The test binary's ggml is built for the same baseline.
        assert_eq!(this_processor_missing(), Vec::<&str>::new());
    }
}
