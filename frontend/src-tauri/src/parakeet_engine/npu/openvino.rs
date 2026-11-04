//! Binding to the part of OpenVINO's C API (`openvino/c/*.h`, OpenVINO 2026.4.1)
//! that runs one model on one device: read an ONNX file, give its inputs static
//! shapes, compile it for a device with a compile cache, and run infer requests
//! on host tensors (#66).
//!
//! The library is `openvino_c.dll` of the Intel runtime the catalog pins
//! (`model_catalog::runtime`), loaded by absolute path from the version folder
//! `whisper_engine::openvino` loads: a process loads one runtime version, and
//! Windows hands a second `LoadLibrary` of the same path the module already
//! loaded. Unlike the GenAI C functions, these record the C++ exception's text
//! for `ov_get_last_err_msg`, so an error carries OpenVINO's own message.
//!
//! Handles are not shared across threads unless the C++ object is thread-safe:
//! a core and a compiled model are; an infer request is not, so running one
//! takes `&mut self`.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};

type Status = i32;
type Opaque = c_void;

/// The library this binding loads; its imports pull in `openvino.dll` and TBB
/// from the same folder.
pub const OPENVINO_C_LIBRARY: &str = "openvino_c.dll";

#[derive(Debug, thiserror::Error)]
pub enum OvError {
    #[error("the OpenVINO runtime could not be loaded from {path}: {source}")]
    Load { path: PathBuf, source: libloading::Error },
    #[error("OpenVINO {call} failed with status {status} ({}){}", crate::whisper_engine::openvino::genai::status_name(*status), message.as_deref().map(|text| format!(": {text}")).unwrap_or_default())]
    Call { call: &'static str, status: Status, message: Option<String> },
    #[error("{0}")]
    Invalid(String),
}

/// `ov_element_type_e` (`ov_common.h`): only the two the encoder uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ElementType {
    F32 = 4,
    I64 = 10,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Dimension {
    min: i64,
    max: i64,
}

#[repr(C)]
struct PartialShape {
    rank: Dimension,
    dims: *mut Dimension,
}

#[repr(C)]
struct Shape {
    rank: i64,
    dims: *mut i64,
}

#[repr(C)]
struct Property {
    key: *const c_char,
    value: *const c_void,
}

macro_rules! api {
    ($($field:ident : $symbol:literal => $ty:ty,)*) => {
        struct Fns { $($field: $ty,)* }
        impl Fns {
            unsafe fn load(library: &libloading::Library) -> Result<Self, libloading::Error> {
                Ok(Self { $($field: *library.get::<$ty>(concat!($symbol, "\0").as_bytes())?,)* })
            }
        }
    };
}

api! {
    last_error: "ov_get_last_err_msg" => unsafe extern "C" fn() -> *const c_char,
    free: "ov_free" => unsafe extern "C" fn(*const c_char),
    core_create: "ov_core_create" => unsafe extern "C" fn(*mut *mut Opaque) -> Status,
    core_free: "ov_core_free" => unsafe extern "C" fn(*mut Opaque),
    core_get_property: "ov_core_get_property" =>
        unsafe extern "C" fn(*const Opaque, *const c_char, *const c_char, *mut *mut c_char) -> Status,
    read_model_unicode: "ov_core_read_model_unicode" =>
        unsafe extern "C" fn(*const Opaque, *const u16, *const u16, *mut *mut Opaque) -> Status,
    model_free: "ov_model_free" => unsafe extern "C" fn(*mut Opaque),
    model_reshape: "ov_model_reshape" =>
        unsafe extern "C" fn(*const Opaque, *const *const c_char, *const PartialShape, usize) -> Status,
    partial_shape_create_static: "ov_partial_shape_create_static" =>
        unsafe extern "C" fn(i64, *const i64, *mut PartialShape) -> Status,
    partial_shape_free: "ov_partial_shape_free" => unsafe extern "C" fn(*mut PartialShape),
    compile_model_props: "ov_core_compile_model_props" =>
        unsafe extern "C" fn(*const Opaque, *const Opaque, *const c_char, usize, *const Property, *mut *mut Opaque) -> Status,
    compiled_model_free: "ov_compiled_model_free" => unsafe extern "C" fn(*mut Opaque),
    compiled_model_get_property: "ov_compiled_model_get_property" =>
        unsafe extern "C" fn(*const Opaque, *const c_char, *mut *mut c_char) -> Status,
    create_infer_request: "ov_compiled_model_create_infer_request" =>
        unsafe extern "C" fn(*const Opaque, *mut *mut Opaque) -> Status,
    infer_request_free: "ov_infer_request_free" => unsafe extern "C" fn(*mut Opaque),
    set_tensor: "ov_infer_request_set_tensor" =>
        unsafe extern "C" fn(*mut Opaque, *const c_char, *const Opaque) -> Status,
    get_tensor: "ov_infer_request_get_tensor" =>
        unsafe extern "C" fn(*const Opaque, *const c_char, *mut *mut Opaque) -> Status,
    infer: "ov_infer_request_infer" => unsafe extern "C" fn(*mut Opaque) -> Status,
    tensor_create_from_host_ptr: "ov_tensor_create_from_host_ptr" =>
        unsafe extern "C" fn(u32, Shape, *mut c_void, *mut *mut Opaque) -> Status,
    tensor_free: "ov_tensor_free" => unsafe extern "C" fn(*mut Opaque),
    tensor_data: "ov_tensor_data" => unsafe extern "C" fn(*const Opaque, *mut *mut c_void) -> Status,
    tensor_get_shape: "ov_tensor_get_shape" => unsafe extern "C" fn(*const Opaque, *mut Shape) -> Status,
    tensor_get_element_type: "ov_tensor_get_element_type" => unsafe extern "C" fn(*const Opaque, *mut u32) -> Status,
    shape_free: "ov_shape_free" => unsafe extern "C" fn(*mut Shape) -> Status,
}

/// The loaded `openvino_c.dll`. The library stays loaded while this lives;
/// every handle below borrows it for `'static`, so the binding is leaked once
/// per process, as the GenAI binding is.
pub struct OpenVino {
    fns: Fns,
    folder: PathBuf,
    _library: libloading::Library,
}

// SAFETY: only function pointers into a library this keeps loaded.
unsafe impl Send for OpenVino {}
unsafe impl Sync for OpenVino {}

impl OpenVino {
    /// Loads `openvino_c.dll` from `folder` (absolute); its dependencies resolve
    /// from that folder and the system directories only.
    pub fn load(folder: &Path) -> Result<Self, OvError> {
        if !folder.is_absolute() {
            return Err(OvError::Invalid(format!("{} is not an absolute path", folder.display())));
        }
        let path = folder.join(OPENVINO_C_LIBRARY);
        // SAFETY: loading Intel's signed library from the verified runtime folder.
        let library = unsafe {
            libloading::os::windows::Library::load_with_flags(
                &path,
                libloading::os::windows::LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | libloading::os::windows::LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
            )
            .map(libloading::Library::from)
        }
        .map_err(|source| OvError::Load { path: path.clone(), source })?;
        // SAFETY: the signatures above are those of OpenVINO 2026.4.1's C headers.
        let fns = unsafe { Fns::load(&library) }.map_err(|source| OvError::Load { path, source })?;
        Ok(Self { fns, folder: folder.to_path_buf(), _library: library })
    }

    pub fn folder(&self) -> &Path {
        &self.folder
    }

    /// The status as an error with OpenVINO's message for the failed call.
    fn check(&self, call: &'static str, status: Status) -> Result<(), OvError> {
        if status == 0 {
            return Ok(());
        }
        // SAFETY: a copy of the message the C API allocates for the caller.
        let message = unsafe {
            let raw = (self.fns.last_error)();
            (!raw.is_null()).then(|| {
                let text = CStr::from_ptr(raw).to_string_lossy().trim().to_string();
                (self.fns.free)(raw);
                text
            })
        };
        Err(OvError::Call { call, status, message: message.filter(|text| !text.is_empty()) })
    }

    /// A new `ov::Core`. Creating one reads the plugin list but loads no plugin.
    pub fn core(&'static self) -> Result<Core, OvError> {
        let mut raw = std::ptr::null_mut();
        // SAFETY: a new object the returned handle owns.
        self.check("ov_core_create", unsafe { (self.fns.core_create)(&mut raw) })?;
        Ok(Core { api: self, raw })
    }
}

fn c_string(value: &str) -> Result<CString, OvError> {
    CString::new(value).map_err(|_| OvError::Invalid(format!("{value:?} contains a NUL byte")))
}

/// One `ov::Core`: thread-safe in OpenVINO.
pub struct Core {
    api: &'static OpenVino,
    raw: *mut Opaque,
}

// SAFETY: `ov::Core` is thread-safe.
unsafe impl Send for Core {}
unsafe impl Sync for Core {}

impl Core {
    /// A device property as text, `None` when the device or key is unknown.
    /// Asking a device loads its plugin.
    pub fn property(&self, device: &str, key: &str) -> Option<String> {
        let (device, key) = (c_string(device).ok()?, c_string(key).ok()?);
        let mut value: *mut c_char = std::ptr::null_mut();
        // SAFETY: the value is a C string the API allocates; freed with ov_free.
        unsafe {
            if (self.api.fns.core_get_property)(self.raw, device.as_ptr(), key.as_ptr(), &mut value) != 0 || value.is_null() {
                return None;
            }
            let text = CStr::from_ptr(value).to_string_lossy().into_owned();
            (self.api.fns.free)(value);
            Some(text)
        }
    }

    /// Reads a model file (ONNX here). The path goes as UTF-16: the C API's
    /// wide variant takes any path Windows can open.
    pub fn read_model(&self, path: &Path) -> Result<Model, OvError> {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut raw = std::ptr::null_mut();
        // SAFETY: a NUL-terminated wide path; no weights file for ONNX.
        self.api.check("ov_core_read_model_unicode", unsafe {
            (self.api.fns.read_model_unicode)(self.raw, wide.as_ptr(), std::ptr::null(), &mut raw)
        })?;
        Ok(Model { api: self.api, raw })
    }

    /// Compiles `model` for `device` with `properties` (key, value), such as
    /// `CACHE_DIR`. Blocking: on an NPU without a cached blob, minutes.
    pub fn compile(&self, model: &Model, device: &str, properties: &[(&str, &str)]) -> Result<CompiledModel, OvError> {
        let device = c_string(device)?;
        let strings: Vec<(CString, CString)> =
            properties.iter().map(|(key, value)| Ok((c_string(key)?, c_string(value)?))).collect::<Result<_, OvError>>()?;
        let properties: Vec<Property> = strings
            .iter()
            .map(|(key, value)| Property { key: key.as_ptr(), value: value.as_ptr().cast() })
            .collect();
        let mut raw = std::ptr::null_mut();
        // SAFETY: the property strings outlive the call; the compiled model is new.
        self.api.check("ov_core_compile_model_props", unsafe {
            (self.api.fns.compile_model_props)(self.raw, model.raw, device.as_ptr(), properties.len(), properties.as_ptr(), &mut raw)
        })?;
        Ok(CompiledModel { api: self.api, raw })
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        // SAFETY: created by ov_core_create, freed once.
        unsafe { (self.api.fns.core_free)(self.raw) }
    }
}

/// An `ov::Model` read from a file.
pub struct Model {
    api: &'static OpenVino,
    raw: *mut Opaque,
}

// SAFETY: used from one thread at a time (reshape, then compile).
unsafe impl Send for Model {}

impl Model {
    /// Gives the named inputs static shapes, all at once.
    pub fn reshape(&mut self, inputs: &[(&str, &[i64])]) -> Result<(), OvError> {
        let names: Vec<CString> = inputs.iter().map(|(name, _)| c_string(name)).collect::<Result<_, _>>()?;
        let name_ptrs: Vec<*const c_char> = names.iter().map(|name| name.as_ptr()).collect();
        let mut shapes = Vec::with_capacity(inputs.len());
        for (_, dims) in inputs {
            let mut shape = PartialShape { rank: Dimension { min: 0, max: 0 }, dims: std::ptr::null_mut() };
            // SAFETY: the API allocates the dims; freed below.
            let status = unsafe { (self.api.fns.partial_shape_create_static)(dims.len() as i64, dims.as_ptr(), &mut shape) };
            if let Err(error) = self.api.check("ov_partial_shape_create_static", status) {
                for shape in &mut shapes {
                    unsafe { (self.api.fns.partial_shape_free)(shape) };
                }
                return Err(error);
            }
            shapes.push(shape);
        }
        // SAFETY: names and shapes are parallel arrays of `inputs.len()`.
        let status = unsafe { (self.api.fns.model_reshape)(self.raw, name_ptrs.as_ptr(), shapes.as_ptr(), shapes.len()) };
        for shape in &mut shapes {
            unsafe { (self.api.fns.partial_shape_free)(shape) };
        }
        self.api.check("ov_model_reshape", status)
    }
}

impl Drop for Model {
    fn drop(&mut self) {
        // SAFETY: created by ov_core_read_model_unicode, freed once.
        unsafe { (self.api.fns.model_free)(self.raw) }
    }
}

/// A model compiled for one device: thread-safe in OpenVINO.
pub struct CompiledModel {
    api: &'static OpenVino,
    raw: *mut Opaque,
}

// SAFETY: `ov::CompiledModel` is thread-safe.
unsafe impl Send for CompiledModel {}
unsafe impl Sync for CompiledModel {}

impl CompiledModel {
    pub fn property(&self, key: &str) -> Option<String> {
        let key = c_string(key).ok()?;
        let mut value: *mut c_char = std::ptr::null_mut();
        // SAFETY: as `Core::property`.
        unsafe {
            if (self.api.fns.compiled_model_get_property)(self.raw, key.as_ptr(), &mut value) != 0 || value.is_null() {
                return None;
            }
            let text = CStr::from_ptr(value).to_string_lossy().into_owned();
            (self.api.fns.free)(value);
            Some(text)
        }
    }

    pub fn infer_request(&self) -> Result<InferRequest, OvError> {
        let mut raw = std::ptr::null_mut();
        // SAFETY: a new request the returned handle owns.
        self.api.check("ov_compiled_model_create_infer_request", unsafe { (self.api.fns.create_infer_request)(self.raw, &mut raw) })?;
        Ok(InferRequest { api: self.api, raw })
    }
}

impl Drop for CompiledModel {
    fn drop(&mut self) {
        // SAFETY: created by ov_core_compile_model_props, freed once.
        unsafe { (self.api.fns.compiled_model_free)(self.raw) }
    }
}

/// One infer request. Not thread-safe: `infer` takes `&mut self`.
pub struct InferRequest {
    api: &'static OpenVino,
    raw: *mut Opaque,
}

// SAFETY: moves between threads; `&mut self` serializes its use.
unsafe impl Send for InferRequest {}

/// An output tensor's data, copied out of the request.
#[derive(Debug, Clone)]
pub struct Output<T> {
    pub shape: Vec<usize>,
    pub data: Vec<T>,
}

impl InferRequest {
    /// Runs the request on `inputs` (name, element type, shape, host data). The
    /// tensors wrap the caller's buffers for the call only; OpenVINO copies
    /// them to the device.
    pub fn infer(&mut self, inputs: &mut [(&str, ElementType, &[i64], *mut c_void)]) -> Result<(), OvError> {
        let mut tensors: Vec<*mut Opaque> = Vec::with_capacity(inputs.len());
        let result = (|| {
            for (name, element, dims, data) in inputs.iter_mut() {
                let name = c_string(name)?;
                let mut dims = dims.to_vec();
                let shape = Shape { rank: dims.len() as i64, dims: dims.as_mut_ptr() };
                let mut tensor = std::ptr::null_mut();
                // SAFETY: the tensor wraps `data` (sized by `dims`), which outlives the call.
                self.api.check("ov_tensor_create_from_host_ptr", unsafe {
                    (self.api.fns.tensor_create_from_host_ptr)(*element as u32, shape, *data, &mut tensor)
                })?;
                tensors.push(tensor);
                self.api.check("ov_infer_request_set_tensor", unsafe { (self.api.fns.set_tensor)(self.raw, name.as_ptr(), tensor) })?;
            }
            // SAFETY: the inputs are set; the request runs synchronously.
            self.api.check("ov_infer_request_infer", unsafe { (self.api.fns.infer)(self.raw) })
        })();
        for tensor in tensors {
            // SAFETY: frees the wrappers, not the caller's buffers.
            unsafe { (self.api.fns.tensor_free)(tensor) };
        }
        result
    }

    /// Copies the named output of the last `infer`.
    pub fn output<T: Copy + Element>(&self, name: &str) -> Result<Output<T>, OvError> {
        let name = c_string(name)?;
        let mut tensor = std::ptr::null_mut();
        // SAFETY: the tensor handle is the request's output; freed below.
        self.api.check("ov_infer_request_get_tensor", unsafe { (self.api.fns.get_tensor)(self.raw, name.as_ptr(), &mut tensor) })?;
        let read = (|| unsafe {
            let mut element = 0u32;
            self.api.check("ov_tensor_get_element_type", (self.api.fns.tensor_get_element_type)(tensor, &mut element))?;
            if element != T::TYPE as u32 {
                return Err(OvError::Invalid(format!("output {name:?} has element type {element}, not {:?}", T::TYPE)));
            }
            let mut shape = Shape { rank: 0, dims: std::ptr::null_mut() };
            self.api.check("ov_tensor_get_shape", (self.api.fns.tensor_get_shape)(tensor, &mut shape))?;
            let dims: Vec<usize> = std::slice::from_raw_parts(shape.dims, shape.rank as usize).iter().map(|&dim| dim as usize).collect();
            (self.api.fns.shape_free)(&mut shape);
            let mut data = std::ptr::null_mut();
            self.api.check("ov_tensor_data", (self.api.fns.tensor_data)(tensor, &mut data))?;
            let count = dims.iter().product::<usize>();
            Ok(Output { shape: dims, data: std::slice::from_raw_parts(data.cast::<T>(), count).to_vec() })
        })();
        // SAFETY: the handle from get_tensor, freed once.
        unsafe { (self.api.fns.tensor_free)(tensor) };
        read
    }
}

impl Drop for InferRequest {
    fn drop(&mut self) {
        // SAFETY: created by ov_compiled_model_create_infer_request, freed once.
        unsafe { (self.api.fns.infer_request_free)(self.raw) }
    }
}

/// A Rust type with its OpenVINO element type.
pub trait Element {
    const TYPE: ElementType;
}

impl Element for f32 {
    const TYPE: ElementType = ElementType::F32;
}

impl Element for i64 {
    const TYPE: ElementType = ElementType::I64;
}
