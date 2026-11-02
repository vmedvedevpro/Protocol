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
/// `whisper_generation_config.cpp`), which MSVC reads in the process's ANSI
/// code page (the OEM one if file APIs were switched to it), not as UTF-8:
/// a data folder under a Cyrillic user name would not be found. So the path
/// goes in that code page, or by its 8.3 short name when the code page
/// cannot hold it. OpenVINO's own string options are UTF-8 instead
/// (`ov::util::make_path`), so `CACHE_DIR` is not passed through this.
#[cfg(windows)]
fn genai_path(path: &Path) -> Result<CString, GenAiError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    let wide = |text: &std::ffi::OsStr| -> Vec<u16> { text.encode_wide().collect() };
    let mut candidates = vec![wide(path.as_os_str())];
    let mut long: Vec<u16> = candidates[0].clone();
    long.push(0);
    // SAFETY: the buffer is sized by the first call; both calls read `long`.
    unsafe {
        let size = GetShortPathNameW(long.as_ptr(), std::ptr::null_mut(), 0);
        if size > 0 {
            let mut short = vec![0u16; size as usize];
            let written = GetShortPathNameW(long.as_ptr(), short.as_mut_ptr(), size);
            if written > 0 && written < size {
                short.truncate(written as usize);
                candidates.push(short);
            }
        }
    }
    candidates
        .iter()
        .find_map(|candidate| narrow_for_file_apis(candidate))
        .and_then(|bytes| CString::new(bytes).ok())
        .ok_or_else(|| {
            GenAiError::Invalid(format!(
                "{} cannot be handed to OpenVINO: its name has characters the system's code page lacks, and it has no short name",
                path.display()
            ))
        })
}

/// `wide` in the code page MSVC's `std::filesystem` reads narrow paths in,
/// or `None` when a character does not convert exactly.
#[cfg(windows)]
fn narrow_for_file_apis(wide: &[u16]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Globalization::{GetACP, WideCharToMultiByte, CP_ACP, CP_OEMCP, CP_UTF8, WC_NO_BEST_FIT_CHARS};
    use windows_sys::Win32::Storage::FileSystem::AreFileApisANSI;
    if wide.is_empty() {
        return Some(Vec::new());
    }
    // SAFETY: plain conversions of `wide` into a buffer the first call sizes.
    unsafe {
        let code_page = if AreFileApisANSI() != 0 { CP_ACP } else { CP_OEMCP };
        // With UTF-8 as the system code page (a Windows option) every path
        // converts, and the call takes neither flag nor default character.
        let utf8 = code_page == CP_ACP && GetACP() == CP_UTF8;
        let flags = if utf8 { 0 } else { WC_NO_BEST_FIT_CHARS };
        let mut defaulted = 0;
        let defaulted_ptr = if utf8 { std::ptr::null_mut() } else { &mut defaulted as *mut _ };
        let length = wide.len() as i32;
        let size = WideCharToMultiByte(code_page, flags, wide.as_ptr(), length, std::ptr::null_mut(), 0, std::ptr::null(), defaulted_ptr);
        if size <= 0 {
            return None;
        }
        let mut narrow = vec![0u8; size as usize];
        let written = WideCharToMultiByte(code_page, flags, wide.as_ptr(), length, narrow.as_mut_ptr(), size, std::ptr::null(), defaulted_ptr);
        (written == size && defaulted == 0).then_some(narrow)
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
    /// load each plugin it knows, and those the runtime does not install (NPU,
    /// AUTO, HETERO, BATCH) it then looks up by bare name, which reaches
    /// PATH, where another OpenVINO could answer. A pipeline is created on
    /// one of these names, so it loads the GPU plugin and, for GenAI's
    /// tokenizer, the CPU one, both by absolute path from this folder.
    /// Loading the GPU plugin is costly, so this is called once per engine
    /// selection.
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
        use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_ACP};
        let mut wide = vec![0u16; bytes.len() + 1];
        let written = unsafe {
            MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), bytes.len() as i32, wide.as_mut_ptr(), wide.len() as i32)
        };
        PathBuf::from(std::ffi::OsString::from_wide(&wide[..written as usize]))
    }

    /// The narrow path GenAI gets names the same folder: an ASCII one as it
    /// is, a Cyrillic one (outside code page 1252, as on this PC) by a form
    /// the code page holds, or a clear error when the volume has no short names.
    #[test]
    fn a_path_reaches_genai_in_the_code_page_msvc_reads_it_in() {
        let root = tempfile::tempdir().unwrap();
        let ascii = root.path().join("models");
        std::fs::create_dir_all(&ascii).unwrap();
        assert_eq!(genai_path(&ascii).unwrap().as_bytes(), ascii.to_str().unwrap().as_bytes());

        for name in ["модель Протокол", "Ünïcödé"] {
            let folder = root.path().join(name);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("generation_config.json"), name.as_bytes()).unwrap();
            match genai_path(&folder) {
                Ok(narrow) => {
                    let read = as_msvc_reads(narrow.as_bytes());
                    assert_eq!(std::fs::read(read.join("generation_config.json")).unwrap(), name.as_bytes(), "{}", read.display());
                }
                Err(error) => assert!(error.to_string().contains("no short name"), "{error}"),
            }
        }
        // The UTF-8 bytes round 1 passed name no folder when the code page
        // is not UTF-8.
        let cyrillic = root.path().join("модель Протокол");
        let utf8 = as_msvc_reads(cyrillic.to_str().unwrap().as_bytes());
        if unsafe { windows_sys::Win32::Globalization::GetACP() } != windows_sys::Win32::Globalization::CP_UTF8 {
            assert!(!utf8.exists(), "{}", utf8.display());
        }
    }

    /// GenAI itself finds a file under a non-ASCII folder: the config read
    /// (`GenerationConfig::from_json`) takes the same path conversion as the
    /// pipeline and needs no device. Needs an installed runtime and a model's
    /// `generation_config.json`.
    #[test]
    #[ignore = "needs OPENVINO_TEST_RUNTIME (an installed runtime) and OPENVINO_TEST_MODEL (an OpenVINO Whisper folder)"]
    fn genai_reads_a_file_in_a_folder_whose_name_is_not_ascii() {
        let runtime = PathBuf::from(std::env::var_os("OPENVINO_TEST_RUNTIME").expect("OPENVINO_TEST_RUNTIME"));
        let model = PathBuf::from(std::env::var_os("OPENVINO_TEST_MODEL").expect("OPENVINO_TEST_MODEL"));
        let api = GenAi::load(&runtime).unwrap();
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("Протокол модель");
        std::fs::create_dir_all(&folder).unwrap();
        let config = folder.join("generation_config.json");
        std::fs::copy(model.join("generation_config.json"), &config).unwrap();
        GenerationConfig::from_json(&api, &config).expect("GenAI reads the config through the converted path");

        // As round 1 passed it: GenAI does not find the file.
        let utf8 = c_string(config.to_str().unwrap()).unwrap();
        let mut raw = std::ptr::null_mut();
        let status = unsafe { (api.fns.config_from_json)(utf8.as_ptr(), &mut raw) };
        if status == 0 {
            unsafe { (api.fns.config_free)(raw) };
        }
        if unsafe { windows_sys::Win32::Globalization::GetACP() } != windows_sys::Win32::Globalization::CP_UTF8 {
            assert_ne!(status, 0, "GenAI read a UTF-8 path in a non-UTF-8 code page");
        }
    }
}
