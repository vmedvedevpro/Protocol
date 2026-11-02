//! Binding to OpenVINO GenAI's C API for Whisper (GenAI 2026.4.1:
//! `openvino/genai/c/whisper_pipeline.h`, `whisper_generation_config.h`) and to the
//! two OpenVINO C calls the device rule needs (`openvino/c/ov_core.h`).
//!
//! The runtime is downloaded on each PC (`model_catalog::runtime`) and loaded at run
//! time from its folder in the app's data, by absolute path, so the app starts and
//! whisper.cpp runs without it, and no other copy is ever picked up from PATH. Two
//! limits of the C API shape the wrapper:
//!
//! - It returns only a status code. The C++ exception's text is dropped (the
//!   GenAI C functions do not record it for `ov_get_last_err_msg`), so errors here
//!   name the call and the status, and callers add what they were doing.
//! - `ov_genai_whisper_generation_config_get_generation_config` returns a copy of
//!   the base config, so `num_beams` or `max_new_tokens` cannot be changed through
//!   it. A config read from JSON (`GenerationConfig::from_json`) can set them.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};

type Status = i32;
type Opaque = c_void;

/// The level of GenAI's C API this binding calls: the functions bound below,
/// with the signatures GenAI 2026.4.1's headers give them. The catalog's
/// runtime entry states the level of the runtime it pins (`api`), and a
/// runtime of another level is neither installed nor loaded: a C signature
/// can change under the same symbol name, so a symbol that resolves does not
/// make a runtime usable. Raise it with a binding change a new runtime needs;
/// the catalog then pins a runtime per level, and older apps keep theirs.
pub const API_LEVEL: u32 = 1;

/// The library the binding loads first; its imports pull in `openvino_genai.dll`,
/// `openvino_c.dll`, `openvino.dll` and TBB from the same folder.
pub const GENAI_C_LIBRARY: &str = "openvino_genai_c.dll";
const OPENVINO_C_LIBRARY: &str = "openvino_c.dll";

#[derive(Debug, thiserror::Error)]
pub enum GenAiError {
    #[error("the OpenVINO runtime could not be loaded from {path}: {source}")]
    Load { path: PathBuf, source: libloading::Error },
    #[error("OpenVINO {call} failed with status {status} ({})", status_name(*status))]
    Call { call: &'static str, status: Status },
    #[error("{0}")]
    Invalid(String),
}

/// `ov_status_e` from `openvino/c/ov_common.h`.
pub fn status_name(status: Status) -> &'static str {
    match status {
        -1 => "general error",
        -2 => "not implemented",
        -3 => "network not loaded",
        -4 => "parameter mismatch",
        -5 => "not found",
        -6 => "out of bounds",
        -7 => "unexpected",
        -14 => "invalid C parameter",
        -15 => "unknown C error",
        -16 => "C method not implemented",
        -17 => "exception",
        _ => "unknown status",
    }
}

fn check(call: &'static str, status: Status) -> Result<(), GenAiError> {
    if status == 0 { Ok(()) } else { Err(GenAiError::Call { call, status }) }
}

fn c_string(value: &str) -> Result<CString, GenAiError> {
    CString::new(value).map_err(|_| GenAiError::Invalid(format!("{value:?} contains a NUL byte")))
}

/// Reads a string through the C API's two-call protocol: the size (with the NUL)
/// first, then the bytes.
unsafe fn read_string(
    call: &'static str,
    mut get: impl FnMut(*mut c_char, *mut usize) -> Status,
) -> Result<String, GenAiError> {
    let mut size = 0usize;
    check(call, get(std::ptr::null_mut(), &mut size))?;
    let mut buffer = vec![0u8; size.max(1)];
    check(call, get(buffer.as_mut_ptr().cast(), &mut size))?;
    Ok(CStr::from_bytes_until_nul(&buffer).map(|text| text.to_string_lossy().into_owned()).unwrap_or_default())
}

/// `path` as GenAI's C API takes a path. GenAI 2026.4.1 builds a
/// `std::filesystem::path` from the `const char*` (`whisper_pipeline.cpp`,
/// `whisper_generation_config.cpp`), which MSVC does not read as UTF-8 but in
/// the code page `__std_fs_code_page` picks: a data folder under a Cyrillic
/// user name would not be found. An ASCII path reads the same in every code
/// page, so the path goes as it is when it is ASCII, else by its 8.3 short
/// name when that is ASCII, and only then in that code page
/// ([`narrow_as_msvc_reads`]). OpenVINO's own string options are UTF-8
/// instead (`ov::util::make_path`), so `CACHE_DIR` is not passed through this.
#[cfg(windows)]
fn genai_path(path: &Path) -> Result<CString, GenAiError> {
    use std::os::windows::ffi::OsStrExt;
    let long: Vec<u16> = path.as_os_str().encode_wide().collect();
    ascii(&long)
        .or_else(|| short_name(&long).as_deref().and_then(ascii))
        .or_else(|| narrow_as_msvc_reads(&long))
        .and_then(|bytes| CString::new(bytes).ok())
        .ok_or_else(|| {
            GenAiError::Invalid(format!(
                "{} cannot be handed to OpenVINO: it has no ASCII short name, and the code page OpenVINO reads it in lacks some of its characters",
                path.display()
            ))
        })
}

#[cfg(windows)]
fn ascii(wide: &[u16]) -> Option<Vec<u8>> {
    wide.iter().all(|&unit| unit != 0 && unit < 0x80).then(|| wide.iter().map(|&unit| unit as u8).collect())
}

/// The 8.3 short form of an existing path, if its volume keeps short names.
#[cfg(windows)]
fn short_name(long: &[u16]) -> Option<Vec<u16>> {
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    let mut long = long.to_vec();
    long.push(0);
    // SAFETY: the buffer is sized by the first call; both calls read `long`.
    unsafe {
        let size = GetShortPathNameW(long.as_ptr(), std::ptr::null_mut(), 0);
        if size == 0 {
            return None;
        }
        let mut short = vec![0u16; size as usize];
        let written = GetShortPathNameW(long.as_ptr(), short.as_mut_ptr(), size);
        (written > 0 && written < size).then(|| {
            short.truncate(written as usize);
            short
        })
    }
}

/// The code page MSVC's `std::filesystem` reads a narrow path in on this
/// thread (`__std_fs_code_page`, microsoft/STL `filesystem.cpp`): UTF-8 under
/// a UTF-8 CRT locale, else the ANSI code page, or the OEM one if file APIs
/// were switched to it.
#[cfg(windows)]
fn msvc_path_code_page() -> u32 {
    use windows_sys::Win32::Globalization::{GetACP, GetOEMCP, CP_UTF8};
    use windows_sys::Win32::Storage::FileSystem::AreFileApisANSI;
    // SAFETY: argument-less queries of the CRT's and the system's state.
    unsafe {
        if ucrt().is_some_and(|crt| (crt.lc_codepage)() == CP_UTF8) {
            CP_UTF8
        } else if AreFileApisANSI() != 0 {
            GetACP()
        } else {
            GetOEMCP()
        }
    }
}

/// `wide` in the code page MSVC reads a narrow path in, or `None` when a
/// character does not convert exactly.
#[cfg(windows)]
fn narrow_as_msvc_reads(wide: &[u16]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Globalization::{WideCharToMultiByte, CP_UTF8, WC_ERR_INVALID_CHARS, WC_NO_BEST_FIT_CHARS};
    if wide.is_empty() {
        return Some(Vec::new());
    }
    let code_page = msvc_path_code_page();
    // UTF-8 holds every character, and takes neither a best-fit flag nor a
    // default character.
    let utf8 = code_page == CP_UTF8;
    let flags = if utf8 { WC_ERR_INVALID_CHARS } else { WC_NO_BEST_FIT_CHARS };
    let mut defaulted = 0;
    let defaulted_ptr = if utf8 { std::ptr::null_mut() } else { &mut defaulted as *mut _ };
    let length = wide.len() as i32;
    // SAFETY: plain conversions of `wide` into a buffer the first call sizes.
    unsafe {
        let size = WideCharToMultiByte(code_page, flags, wide.as_ptr(), length, std::ptr::null_mut(), 0, std::ptr::null(), defaulted_ptr);
        if size <= 0 {
            return None;
        }
        let mut narrow = vec![0u8; size as usize];
        let written = WideCharToMultiByte(code_page, flags, wide.as_ptr(), length, narrow.as_mut_ptr(), size, std::ptr::null(), defaulted_ptr);
        (written == size && defaulted == 0).then_some(narrow)
    }
}

/// The Universal CRT GenAI and OpenVINO import (`api-ms-win-crt-*`, served
/// by `ucrtbase.dll`). Its environment and locale are its own: a variable set
/// through Win32 once the CRT has started is not in its `_wgetenv`, so what
/// GenAI reads through the CRT is set and read here through the same one.
#[cfg(windows)]
struct Ucrt {
    wputenv_s: unsafe extern "C" fn(*const u16, *const u16) -> i32,
    lc_codepage: unsafe extern "C" fn() -> u32,
    _library: libloading::Library,
}

#[cfg(windows)]
fn ucrt() -> Option<&'static Ucrt> {
    static UCRT: std::sync::OnceLock<Option<Ucrt>> = std::sync::OnceLock::new();
    UCRT.get_or_init(|| {
        // SAFETY: the system's CRT, already loaded in this process; the
        // signatures are those of `<stdlib.h>` and `<locale.h>`.
        unsafe {
            let library = libloading::os::windows::Library::load_with_flags("ucrtbase.dll", libloading::os::windows::LOAD_LIBRARY_SEARCH_SYSTEM32)
                .map(libloading::Library::from)
                .ok()?;
            Some(Ucrt {
                wputenv_s: *library.get(b"_wputenv_s\0").ok()?,
                lc_codepage: *library.get(b"___lc_codepage_func\0").ok()?,
                _library: library,
            })
        }
    })
    .as_ref()
}

/// The variable GenAI loads its tokenizer extension from (`ScopedVar`,
/// `tokenizers_path.hpp`).
const TOKENIZERS_VARIABLE: &str = "OPENVINO_TOKENIZERS_PATH_GENAI";
const TOKENIZERS_LIBRARY: &str = "openvino_tokenizers.dll";

/// Points GenAI at this runtime's tokenizer library. GenAI reads the path
/// from [`TOKENIZERS_VARIABLE`] through the CRT and keeps a value that is
/// already set (`tokenizer_impl.cpp`), loading that library unchecked: one
/// inherited from the environment would bring in another copy. So the
/// variable is set to the verified copy in `folder` before GenAI can read it.
#[cfg(windows)]
fn use_tokenizers_in(folder: &Path) -> Result<(), GenAiError> {
    use std::os::windows::ffi::OsStrExt;
    let crt = ucrt().ok_or_else(|| GenAiError::Invalid("the C runtime's _wputenv_s could not be found".to_string()))?;
    let name: Vec<u16> = TOKENIZERS_VARIABLE.encode_utf16().chain(std::iter::once(0)).collect();
    let value: Vec<u16> = folder.join(TOKENIZERS_LIBRARY).as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // SAFETY: two NUL-terminated wide strings the call copies.
    let status = unsafe { (crt.wputenv_s)(name.as_ptr(), value.as_ptr()) };
    if status == 0 {
        Ok(())
    } else {
        Err(GenAiError::Invalid(format!("{TOKENIZERS_VARIABLE} could not be set (errno {status})")))
    }
}

#[cfg(not(windows))]
fn genai_path(path: &Path) -> Result<CString, GenAiError> {
    c_string(&path.to_string_lossy())
}

macro_rules! api {
    ($($field:ident : $symbol:literal => $ty:ty,)*) => {
        struct GenAiFns { $($field: $ty,)* }
        impl GenAiFns {
            unsafe fn load(library: &libloading::Library) -> Result<Self, libloading::Error> {
                Ok(Self { $($field: *library.get::<$ty>(concat!($symbol, "\0").as_bytes())?,)* })
            }
        }
    };
}

api! {
    pipeline_create: "ov_genai_whisper_pipeline_create" =>
        unsafe extern "C" fn(*const c_char, *const c_char, usize, *mut *mut Opaque, ...) -> Status,
    pipeline_free: "ov_genai_whisper_pipeline_free" => unsafe extern "C" fn(*mut Opaque),
    pipeline_generate: "ov_genai_whisper_pipeline_generate" =>
        unsafe extern "C" fn(*mut Opaque, *const f32, usize, *const Opaque, *mut *mut Opaque) -> Status,
    pipeline_get_config: "ov_genai_whisper_pipeline_get_generation_config" =>
        unsafe extern "C" fn(*const Opaque, *mut *mut Opaque) -> Status,
    config_from_json: "ov_genai_whisper_generation_config_create_from_json" =>
        unsafe extern "C" fn(*const c_char, *mut *mut Opaque) -> Status,
    config_free: "ov_genai_whisper_generation_config_free" => unsafe extern "C" fn(*mut Opaque),
    config_set_language: "ov_genai_whisper_generation_config_set_language" =>
        unsafe extern "C" fn(*mut Opaque, *const c_char) -> Status,
    config_set_task: "ov_genai_whisper_generation_config_set_task" =>
        unsafe extern "C" fn(*mut Opaque, *const c_char) -> Status,
    config_set_return_timestamps: "ov_genai_whisper_generation_config_set_return_timestamps" =>
        unsafe extern "C" fn(*mut Opaque, bool) -> Status,
    config_set_initial_prompt: "ov_genai_whisper_generation_config_set_initial_prompt" =>
        unsafe extern "C" fn(*mut Opaque, *const c_char) -> Status,
    results_free: "ov_genai_whisper_decoded_results_free" => unsafe extern "C" fn(*mut Opaque),
    results_text_at: "ov_genai_whisper_decoded_results_get_text_at" =>
        unsafe extern "C" fn(*const Opaque, usize, *mut c_char, *mut usize) -> Status,
    results_has_chunks: "ov_genai_whisper_decoded_results_has_chunks" =>
        unsafe extern "C" fn(*const Opaque, *mut bool) -> Status,
    results_chunks_count: "ov_genai_whisper_decoded_results_get_chunks_count" =>
        unsafe extern "C" fn(*const Opaque, *mut usize) -> Status,
    results_chunk_at: "ov_genai_whisper_decoded_results_get_chunk_at" =>
        unsafe extern "C" fn(*const Opaque, usize, *mut *mut Opaque) -> Status,
    chunk_free: "ov_genai_whisper_decoded_result_chunk_free" => unsafe extern "C" fn(*mut Opaque),
    chunk_start: "ov_genai_whisper_decoded_result_chunk_get_start_ts" =>
        unsafe extern "C" fn(*const Opaque, *mut f32) -> Status,
    chunk_end: "ov_genai_whisper_decoded_result_chunk_get_end_ts" =>
        unsafe extern "C" fn(*const Opaque, *mut f32) -> Status,
    chunk_text: "ov_genai_whisper_decoded_result_chunk_get_text" =>
        unsafe extern "C" fn(*const Opaque, *mut c_char, *mut usize) -> Status,
}

/// The OpenVINO calls the device rule needs. There is deliberately no
/// `ov_core_get_available_devices`: it loads every plugin OpenVINO knows
/// (see [`GenAi::gpus`]).
struct CoreFns {
    core_create: unsafe extern "C" fn(*mut *mut Opaque) -> Status,
    core_free: unsafe extern "C" fn(*mut Opaque),
    get_property: unsafe extern "C" fn(*const Opaque, *const c_char, *const c_char, *mut *mut c_char) -> Status,
    free: unsafe extern "C" fn(*const c_char),
}

/// The loaded runtime. Both libraries stay loaded while it lives; every handle
/// below borrows it.
pub struct GenAi {
    fns: GenAiFns,
    core: CoreFns,
    folder: PathBuf,
    _openvino_c: libloading::Library,
    _genai_c: libloading::Library,
}

// SAFETY: the struct holds only function pointers into libraries it keeps loaded;
// the C API's handles carry their own synchronization requirements (see Pipeline).
unsafe impl Send for GenAi {}
unsafe impl Sync for GenAi {}

impl GenAi {
    /// Loads the runtime from `folder` (absolute). Dependencies resolve from that
    /// folder and the system directories only.
    pub fn load(folder: &Path) -> Result<Self, GenAiError> {
        let open = |name: &str| -> Result<libloading::Library, GenAiError> {
            let path = folder.join(name);
            #[cfg(windows)]
            let library = unsafe {
                libloading::os::windows::Library::load_with_flags(
                    &path,
                    libloading::os::windows::LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR
                        | libloading::os::windows::LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
                )
                .map(libloading::Library::from)
            };
            #[cfg(not(windows))]
            let library = unsafe { libloading::Library::new(&path) };
            library.map_err(|source| GenAiError::Load { path, source })
        };
        if !folder.is_absolute() {
            return Err(GenAiError::Invalid(format!("{} is not an absolute path", folder.display())));
        }
        #[cfg(windows)]
        use_tokenizers_in(folder)?;
        let genai_c = open(GENAI_C_LIBRARY)?;
        let openvino_c = open(OPENVINO_C_LIBRARY)?;
        let load_error = |source| GenAiError::Load { path: folder.to_path_buf(), source };
        // SAFETY: the signatures above are those of the GenAI 2026.4.1 and OpenVINO
        // 2026.4.1 C headers; the libraries stay loaded in `Self`.
        let fns = unsafe { GenAiFns::load(&genai_c) }.map_err(load_error)?;
        let core = unsafe {
            CoreFns {
                core_create: *openvino_c.get(b"ov_core_create\0").map_err(load_error)?,
                core_free: *openvino_c.get(b"ov_core_free\0").map_err(load_error)?,
                get_property: *openvino_c.get(b"ov_core_get_property\0").map_err(load_error)?,
                free: *openvino_c.get(b"ov_free\0").map_err(load_error)?,
            }
        };
        Ok(Self { fns, core, folder: folder.to_path_buf(), _openvino_c: openvino_c, _genai_c: genai_c })
    }

    pub fn folder(&self) -> &Path {
        &self.folder
    }

    /// The GPUs of OpenVINO's GPU plugin, with the properties the device rule
    /// reads, named as OpenVINO lists them. Only that plugin is asked, and it
    /// is one of the runtime's files: listing every device makes OpenVINO
    /// load each plugin it registered, and it registers a plugin the runtime
    /// lacks (NPU, AUTO, HETERO) when the process's current directory holds
    /// a file of that name. A pipeline is created on one of these names, so
    /// it loads the GPU plugin, the CPU one for GenAI's tokenizer, and the
    /// auto-batching one each compile asks for, all from this folder (see
    /// `schema::RUNTIMES`). Loading the GPU plugin is costly, so this is
    /// called once per engine selection.
    pub fn gpus(&self) -> Result<Vec<DeviceInfo>, GenAiError> {
        let mut core = std::ptr::null_mut();
        // SAFETY: plain C calls on a core this function creates and frees.
        unsafe {
            check("ov_core_create", (self.core.core_create)(&mut core))?;
            // A GPU plugin that finds no device fails here; OpenVINO's own
            // device list counts that as no GPU, and so does this.
            let ids = self.property(core, "GPU", "AVAILABLE_DEVICES").unwrap_or_default();
            let ids: Vec<&str> = ids.split_whitespace().collect();
            let devices = gpu_names(&ids)
                .into_iter()
                .map(|name| {
                    let property = |key: &str| self.property(core, &name, key);
                    DeviceInfo {
                        full_name: property("FULL_DEVICE_NAME"),
                        device_type: property("DEVICE_TYPE"),
                        architecture: property("DEVICE_ARCHITECTURE"),
                        pci_info: property("DEVICE_PCI_INFO"),
                        name,
                    }
                })
                .collect();
            (self.core.core_free)(core);
            Ok(devices)
        }
    }

    unsafe fn property(&self, core: *mut Opaque, device: &str, key: &str) -> Option<String> {
        let (device, key) = (c_string(device).ok()?, c_string(key).ok()?);
        let mut value: *mut c_char = std::ptr::null_mut();
        if (self.core.get_property)(core, device.as_ptr(), key.as_ptr(), &mut value) != 0 || value.is_null() {
            return None;
        }
        let text = CStr::from_ptr(value).to_string_lossy().into_owned();
        (self.core.free)(value);
        Some(text)
    }
}

/// The device names of the GPU plugin's `AVAILABLE_DEVICES` ids, as
/// `ov::Core::get_available_devices` forms them: `GPU` for one, `GPU.<id>`
/// for each of several.
fn gpu_names(ids: &[&str]) -> Vec<String> {
    match ids {
        [] => Vec::new(),
        [_] => vec!["GPU".to_string()],
        several => several.iter().map(|id| format!("GPU.{id}")).collect(),
    }
}

/// An OpenVINO device as `ov_core_get_property` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    /// `GPU`, `GPU.0`, `CPU`, `NPU`: the name a pipeline is created on.
    pub name: String,
    pub full_name: Option<String>,
    /// `integrated` or `discrete`.
    pub device_type: Option<String>,
    /// For a GPU, `GPU: vendor=0x8086 arch=v30.0.4`.
    pub architecture: Option<String>,
    /// `{domain: 0 bus: 0 device: 0x2 function: 0}`.
    pub pci_info: Option<String>,
}

/// One `ov_genai_whisper_pipeline`: the compiled encoder and decoder on one device.
///
/// `generate` takes `&mut self`: the pipeline keeps one infer request per model and
/// its decoder state between the calls of a generation, so calls must not overlap.
pub struct Pipeline<'a> {
    api: &'a GenAi,
    raw: *mut Opaque,
}

// SAFETY: the pipeline may move between threads; `&mut self` serializes its use.
unsafe impl Send for Pipeline<'_> {}

impl<'a> Pipeline<'a> {
    /// Reads and compiles the model in `model_dir` on `device`. With `cache_dir`
    /// the compiled blobs are kept there (OpenVINO's `CACHE_DIR`), which turns a
    /// later compile into a load.
    pub fn create(api: &'a GenAi, model_dir: &Path, device: &str, cache_dir: Option<&Path>) -> Result<Self, GenAiError> {
        let model = genai_path(model_dir)?;
        let device = c_string(device)?;
        let mut raw = std::ptr::null_mut();
        // SAFETY: the variadic tail is `property_args_size` C strings, key then value.
        let status = unsafe {
            match cache_dir {
                Some(cache) => {
                    let cache = c_string(&cache.to_string_lossy())?;
                    (api.fns.pipeline_create)(model.as_ptr(), device.as_ptr(), 2, &mut raw, c"CACHE_DIR".as_ptr(), cache.as_ptr())
                }
                None => (api.fns.pipeline_create)(model.as_ptr(), device.as_ptr(), 0, &mut raw),
            }
        };
        check("ov_genai_whisper_pipeline_create", status)?;
        Ok(Self { api, raw })
    }

    /// A copy of the pipeline's default config (the model's `generation_config.json`).
    pub fn default_config(&self) -> Result<GenerationConfig<'a>, GenAiError> {
        let mut raw = std::ptr::null_mut();
        // SAFETY: `self.raw` is a live pipeline; the config is a new object we own.
        check("ov_genai_whisper_pipeline_get_generation_config", unsafe {
            (self.api.fns.pipeline_get_config)(self.raw, &mut raw)
        })?;
        Ok(GenerationConfig { api: self.api, raw })
    }

    /// Transcribes 16 kHz mono samples in [-1, 1].
    pub fn generate(&mut self, samples: &[f32], config: &GenerationConfig<'_>) -> Result<Transcript, GenAiError> {
        let mut results = std::ptr::null_mut();
        // SAFETY: the samples outlive the call; results is a new object freed below.
        check("ov_genai_whisper_pipeline_generate", unsafe {
            (self.api.fns.pipeline_generate)(self.raw, samples.as_ptr(), samples.len(), config.raw, &mut results)
        })?;
        let read = unsafe { self.read_results(results) };
        unsafe { (self.api.fns.results_free)(results) };
        read
    }

    unsafe fn read_results(&self, results: *mut Opaque) -> Result<Transcript, GenAiError> {
        let fns = &self.api.fns;
        let text = read_string("ov_genai_whisper_decoded_results_get_text_at", |buffer, size| {
            (fns.results_text_at)(results, 0, buffer, size)
        })?;
        let mut has_chunks = false;
        check("ov_genai_whisper_decoded_results_has_chunks", (fns.results_has_chunks)(results, &mut has_chunks))?;
        let mut chunks = Vec::new();
        if has_chunks {
            let mut count = 0usize;
            check("ov_genai_whisper_decoded_results_get_chunks_count", (fns.results_chunks_count)(results, &mut count))?;
            for index in 0..count {
                let mut chunk = std::ptr::null_mut();
                check("ov_genai_whisper_decoded_results_get_chunk_at", (fns.results_chunk_at)(results, index, &mut chunk))?;
                let read = (|| {
                    let (mut start, mut end) = (0f32, 0f32);
                    check("ov_genai_whisper_decoded_result_chunk_get_start_ts", (fns.chunk_start)(chunk, &mut start))?;
                    check("ov_genai_whisper_decoded_result_chunk_get_end_ts", (fns.chunk_end)(chunk, &mut end))?;
                    let text = read_string("ov_genai_whisper_decoded_result_chunk_get_text", |buffer, size| {
                        (fns.chunk_text)(chunk, buffer, size)
                    })?;
                    Ok(Chunk { start_s: start, end_s: end, text })
                })();
                (fns.chunk_free)(chunk);
                chunks.push(read?);
            }
        }
        Ok(Transcript { text, chunks })
    }
}

impl Drop for Pipeline<'_> {
    fn drop(&mut self) {
        // SAFETY: created by ov_genai_whisper_pipeline_create, freed once.
        unsafe { (self.api.fns.pipeline_free)(self.raw) }
    }
}

/// An `ov_genai_whisper_generation_config` the caller owns.
pub struct GenerationConfig<'a> {
    api: &'a GenAi,
    raw: *mut Opaque,
}

unsafe impl Send for GenerationConfig<'_> {}

impl<'a> GenerationConfig<'a> {
    /// A config read from a `generation_config.json`: the only way the C API sets
    /// `num_beams` (see the module comment).
    pub fn from_json(api: &'a GenAi, path: &Path) -> Result<Self, GenAiError> {
        let path = genai_path(path)?;
        let mut raw = std::ptr::null_mut();
        check("ov_genai_whisper_generation_config_create_from_json", unsafe {
            (api.fns.config_from_json)(path.as_ptr(), &mut raw)
        })?;
        Ok(Self { api, raw })
    }

    /// A language token such as `<|ru|>`; without one the pipeline detects it.
    pub fn set_language(&mut self, token: &str) -> Result<(), GenAiError> {
        let token = c_string(token)?;
        check("ov_genai_whisper_generation_config_set_language", unsafe {
            (self.api.fns.config_set_language)(self.raw, token.as_ptr())
        })
    }

    /// `transcribe` or `translate`.
    pub fn set_task(&mut self, task: &str) -> Result<(), GenAiError> {
        let task = c_string(task)?;
        check("ov_genai_whisper_generation_config_set_task", unsafe {
            (self.api.fns.config_set_task)(self.raw, task.as_ptr())
        })
    }

    pub fn set_return_timestamps(&mut self, on: bool) -> Result<(), GenAiError> {
        check("ov_genai_whisper_generation_config_set_return_timestamps", unsafe {
            (self.api.fns.config_set_return_timestamps)(self.raw, on)
        })
    }

    pub fn set_initial_prompt(&mut self, prompt: &str) -> Result<(), GenAiError> {
        let prompt = c_string(prompt)?;
        check("ov_genai_whisper_generation_config_set_initial_prompt", unsafe {
            (self.api.fns.config_set_initial_prompt)(self.raw, prompt.as_ptr())
        })
    }
}

impl Drop for GenerationConfig<'_> {
    fn drop(&mut self) {
        unsafe { (self.api.fns.config_free)(self.raw) }
    }
}

/// What one `generate` returned: the joined text and, with timestamps, its chunks.
#[derive(Debug, Clone, PartialEq)]
pub struct Transcript {
    pub text: String,
    pub chunks: Vec<Chunk>,
}

/// A timestamped segment, in seconds from the start of the samples.
#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub start_s: f32,
    pub end_s: f32,
    pub text: String,
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// A runtime the binding cannot use is an error to report, not a crash:
    /// a file that is no library, and a library without GenAI's C API.
    #[test]
    fn a_folder_without_the_genai_c_api_is_refused() {
        let folder = tempfile::tempdir().unwrap();
        std::fs::write(folder.path().join(GENAI_C_LIBRARY), b"not a library").unwrap();
        let error = GenAi::load(folder.path()).err().expect("garbage must not load");
        assert!(matches!(error, GenAiError::Load { .. }), "{error}");

        // A real library under the C API's name: it loads, its symbols do not resolve.
        let system = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32").join("version.dll");
        std::fs::copy(system, folder.path().join(GENAI_C_LIBRARY)).unwrap();
        std::fs::copy(folder.path().join(GENAI_C_LIBRARY), folder.path().join(OPENVINO_C_LIBRARY)).unwrap();
        let error = GenAi::load(folder.path()).err().expect("a library without the C API must not load");
        assert!(error.to_string().contains("could not be loaded"), "{error}");
        assert!(GenAi::load(Path::new("relative")).is_err());
    }

    #[test]
    fn gpus_are_named_as_openvino_lists_them() {
        assert!(gpu_names(&[]).is_empty());
        assert_eq!(gpu_names(&["0"]), ["GPU"]);
        assert_eq!(gpu_names(&["0", "1"]), ["GPU.0", "GPU.1"]);
    }

    /// `bytes` read back as MSVC's `std::filesystem::path` reads a narrow path.
    fn as_msvc_reads(bytes: &[u8]) -> PathBuf {
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::Globalization::MultiByteToWideChar;
        let mut wide = vec![0u16; bytes.len() + 1];
        let written = unsafe {
            MultiByteToWideChar(msvc_path_code_page(), 0, bytes.as_ptr(), bytes.len() as i32, wide.as_mut_ptr(), wide.len() as i32)
        };
        PathBuf::from(std::ffi::OsString::from_wide(&wide[..written as usize]))
    }

    fn wide(path: &Path) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().collect()
    }

    /// The narrow path GenAI gets names the same folder: an ASCII one as it
    /// is, a Cyrillic or Latin-1 one by its ASCII short name where the volume
    /// keeps short names, else in the code page MSVC reads it in, or a clear
    /// error when neither holds it.
    #[test]
    fn a_path_reaches_genai_as_ascii_where_it_can_else_in_the_code_page_msvc_reads_it_in() {
        use windows_sys::Win32::Globalization::CP_UTF8;
        let root = tempfile::tempdir().unwrap();
        let ascii_folder = root.path().join("models");
        std::fs::create_dir_all(&ascii_folder).unwrap();
        assert_eq!(genai_path(&ascii_folder).unwrap().as_bytes(), ascii_folder.to_str().unwrap().as_bytes());

        let code_page = msvc_path_code_page();
        for name in ["модель Протокол", "Ünïcödé"] {
            let folder = root.path().join(name);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("generation_config.json"), name.as_bytes()).unwrap();
            let names_the_folder = |narrow: &[u8]| {
                let read = as_msvc_reads(narrow);
                assert_eq!(std::fs::read(read.join("generation_config.json")).unwrap(), name.as_bytes(), "{}", read.display());
            };
            let short = short_name(&wide(&folder)).and_then(|short| ascii(&short));
            match genai_path(&folder) {
                Ok(narrow) => {
                    // The ASCII short name wins over the code page.
                    assert_eq!(short.is_some(), narrow.as_bytes().is_ascii(), "{:?}", narrow);
                    names_the_folder(narrow.as_bytes());
                }
                Err(error) => assert!(short.is_none() && error.to_string().contains("no ASCII short name"), "{error}"),
            }
            // The fallback alone: exact in the code page, or nothing.
            match narrow_as_msvc_reads(&wide(&folder)) {
                Some(narrow) => names_the_folder(&narrow),
                None => assert_ne!(code_page, CP_UTF8),
            }
        }
        // Code page 1252, this PC's: Latin-1 converts, Cyrillic does not.
        if code_page == 1252 {
            assert!(narrow_as_msvc_reads(&wide(&root.path().join("Ünïcödé"))).is_some());
            assert!(narrow_as_msvc_reads(&wide(&root.path().join("модель Протокол"))).is_none());
        }
        // The UTF-8 bytes round 1 passed name no folder when the code page
        // is not UTF-8.
        let cyrillic = root.path().join("модель Протокол");
        let utf8 = as_msvc_reads(cyrillic.to_str().unwrap().as_bytes());
        if code_page != CP_UTF8 {
            assert!(!utf8.exists(), "{}", utf8.display());
        }
    }

    /// GenAI reads its tokenizer library from a variable it keeps when it is
    /// already set: loading a runtime replaces an inherited value with the
    /// runtime's own copy, in the CRT GenAI reads it from.
    #[test]
    fn loading_a_runtime_points_genai_at_its_own_tokenizer_library() {
        type GetEnv = unsafe extern "C" fn(*const u16) -> *const u16;
        let crt = unsafe { libloading::Library::new("ucrtbase.dll") }.unwrap();
        let wgetenv: libloading::Symbol<GetEnv> = unsafe { crt.get(b"_wgetenv\0") }.unwrap();
        let name: Vec<u16> = TOKENIZERS_VARIABLE.encode_utf16().chain(std::iter::once(0)).collect();
        let read = || unsafe {
            let value = wgetenv(name.as_ptr());
            assert!(!value.is_null());
            let length = (0..).take_while(|&index| *value.add(index) != 0).count();
            String::from_utf16(std::slice::from_raw_parts(value, length)).unwrap()
        };
        let inherited = tempfile::tempdir().unwrap();
        use_tokenizers_in(inherited.path()).unwrap();
        assert_eq!(read(), inherited.path().join(TOKENIZERS_LIBRARY).to_str().unwrap());

        // The load fails (no library there), but GenAI would now read this folder's copy.
        let runtime = tempfile::tempdir().unwrap();
        let folder = runtime.path().join("Протокол");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(GenAi::load(&folder).is_err());
        assert_eq!(read(), folder.join(TOKENIZERS_LIBRARY).to_str().unwrap());
    }

    fn read_config(api: &GenAi, narrow: &[u8]) -> Status {
        let narrow = CString::new(narrow).unwrap();
        let mut raw = std::ptr::null_mut();
        let status = unsafe { (api.fns.config_from_json)(narrow.as_ptr(), &mut raw) };
        if status == 0 {
            unsafe { (api.fns.config_free)(raw) };
        }
        status
    }

    /// GenAI itself finds a file under a non-ASCII folder: the config read
    /// (`GenerationConfig::from_json`) takes the same path conversion as the
    /// pipeline and needs no device. Each folder goes through `genai_path`
    /// and, where the code page holds its name (Latin-1 under 1252), through
    /// the code-page fallback too. Needs an installed runtime and a model's
    /// `generation_config.json`.
    #[test]
    #[ignore = "needs OPENVINO_TEST_RUNTIME (an installed runtime) and OPENVINO_TEST_MODEL (an OpenVINO Whisper folder)"]
    fn genai_reads_a_file_in_a_folder_whose_name_is_not_ascii() {
        let runtime = PathBuf::from(std::env::var_os("OPENVINO_TEST_RUNTIME").expect("OPENVINO_TEST_RUNTIME"));
        let model = PathBuf::from(std::env::var_os("OPENVINO_TEST_MODEL").expect("OPENVINO_TEST_MODEL"));
        let api = GenAi::load(&runtime).unwrap();
        let root = tempfile::tempdir().unwrap();
        let mut fallbacks = 0;
        for name in ["Протокол модель", "Ünïcödé"] {
            let folder = root.path().join(name);
            std::fs::create_dir_all(&folder).unwrap();
            let config = folder.join("generation_config.json");
            std::fs::copy(model.join("generation_config.json"), &config).unwrap();
            GenerationConfig::from_json(&api, &config).expect("GenAI reads the config through the converted path");
            if let Some(narrow) = narrow_as_msvc_reads(&wide(&config)) {
                assert_eq!(read_config(&api, &narrow), 0, "GenAI did not read {name} in code page {}", msvc_path_code_page());
                fallbacks += 1;
            }
            // As round 1 passed it: GenAI does not find the file.
            if msvc_path_code_page() != windows_sys::Win32::Globalization::CP_UTF8 {
                assert_ne!(read_config(&api, config.to_str().unwrap().as_bytes()), 0, "GenAI read a UTF-8 path in a non-UTF-8 code page");
            }
        }
        println!("{fallbacks} of 2 folders also read through code page {}", msvc_path_code_page());
    }
}
