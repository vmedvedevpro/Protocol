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

#[repr(C)]
struct AvailableDevices {
    devices: *mut *mut c_char,
    size: usize,
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

struct CoreFns {
    core_create: unsafe extern "C" fn(*mut *mut Opaque) -> Status,
    core_free: unsafe extern "C" fn(*mut Opaque),
    available_devices: unsafe extern "C" fn(*const Opaque, *mut AvailableDevices) -> Status,
    available_devices_free: unsafe extern "C" fn(*mut AvailableDevices),
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
                available_devices: *openvino_c.get(b"ov_core_get_available_devices\0").map_err(load_error)?,
                available_devices_free: *openvino_c.get(b"ov_available_devices_free\0").map_err(load_error)?,
                get_property: *openvino_c.get(b"ov_core_get_property\0").map_err(load_error)?,
                free: *openvino_c.get(b"ov_free\0").map_err(load_error)?,
            }
        };
        Ok(Self { fns, core, folder: folder.to_path_buf(), _openvino_c: openvino_c, _genai_c: genai_c })
    }

    pub fn folder(&self) -> &Path {
        &self.folder
    }

    /// Every OpenVINO device with the properties the device rule reads. Creating a
    /// core loads the device plugins, so this is called once per engine selection.
    pub fn devices(&self) -> Result<Vec<DeviceInfo>, GenAiError> {
        let mut core = std::ptr::null_mut();
        // SAFETY: plain C calls on a core this function creates and frees.
        unsafe {
            check("ov_core_create", (self.core.core_create)(&mut core))?;
            let mut list = AvailableDevices { devices: std::ptr::null_mut(), size: 0 };
            let listed = check("ov_core_get_available_devices", (self.core.available_devices)(core, &mut list));
            let mut devices = Vec::new();
            if listed.is_ok() {
                for index in 0..list.size {
                    let name = CStr::from_ptr(*list.devices.add(index)).to_string_lossy().into_owned();
                    let property = |key: &str| self.property(core, &name, key);
                    devices.push(DeviceInfo {
                        full_name: property("FULL_DEVICE_NAME"),
                        device_type: property("DEVICE_TYPE"),
                        architecture: property("DEVICE_ARCHITECTURE"),
                        pci_info: property("DEVICE_PCI_INFO"),
                        name,
                    });
                }
                (self.core.available_devices_free)(&mut list);
            }
            (self.core.core_free)(core);
            listed.map(|_| devices)
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
        let model = c_string(&model_dir.to_string_lossy())?;
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
        let path = c_string(&path.to_string_lossy())?;
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
}
