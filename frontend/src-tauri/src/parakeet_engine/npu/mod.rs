//! Parakeet's encoder on the Intel NPU (#66), through OpenVINO's C API from
//! the Intel runtime the catalog pins. Only the encoder moves: the `nemo128`
//! preprocessor and the decoder/joint stay on ONNX Runtime's CPU provider.
//!
//! The NPU compiles one input shape: [`FRAMES`] feature frames (6.07 s). A
//! shorter input is padded with zero features after its end and given its true
//! `length`, so the encoder masks the padding; only `encoded_lengths` output
//! frames are decoded. #80 measured this shape and feed on the device.

pub mod openvino;

use std::path::Path;

use ndarray::{Array3, ArrayView3};

use openvino::{CompiledModel, Core, ElementType, InferRequest, OpenVino, OvError};

/// Feature frames of the static input: 10 ms each, so (608 − 1) × 160
/// samples = 6.07 s of audio, the longest piece the live VAD's 6 s cap makes
/// (`nemo128` gives one frame per 160 samples plus one).
pub const FRAMES: usize = 608;
/// `nemo128`'s mel bins.
pub const FEATURES: usize = 128;
/// The OpenVINO device the encoder is compiled for.
pub const DEVICE: &str = "NPU";

/// One encoder compiled for the NPU with its infer request. Not shared: the
/// request runs one call at a time (`encode` takes `&mut self`), as the
/// ONNX Runtime session it replaces does inside `ParakeetModel`.
pub struct NpuEncoder {
    request: InferRequest,
    _compiled: CompiledModel,
    _core: Core,
}

impl NpuEncoder {
    /// Reads `encoder` (the ONNX file), gives it the static shape and compiles
    /// it for the NPU, with OpenVINO's compile cache in `cache` when given.
    /// Blocking: minutes without a cached blob, seconds with one.
    pub fn compile(api: &'static OpenVino, encoder: &Path, cache: Option<&Path>) -> Result<Self, OvError> {
        let core = api.core()?;
        let mut model = core.read_model(encoder)?;
        model.reshape(&[("audio_signal", &[1, FEATURES as i64, FRAMES as i64]), ("length", &[1])])?;
        let cache = cache.map(|cache| cache.to_string_lossy().into_owned());
        let properties: Vec<(&str, &str)> = cache.iter().map(|cache| ("CACHE_DIR", cache.as_str())).collect();
        let compiled = core.compile(&model, DEVICE, &properties)?;
        drop(model);
        let request = compiled.infer_request()?;
        Ok(Self { request, _compiled: compiled, _core: core })
    }

    /// Encodes `features` ([1, 128, T], T ≤ [`FRAMES`]) of which the first
    /// `length` frames are speech. Returns the encoder output as
    /// `ParakeetModel::encode` does, [1, frames, 1024], and the number of
    /// output frames to decode.
    pub fn encode(&mut self, features: &ArrayView3<f32>, length: i64) -> Result<(Array3<f32>, usize), OvError> {
        let (batch, bins, frames) = features.dim();
        if batch != 1 || bins != FEATURES || frames > FRAMES {
            return Err(OvError::Invalid(format!("features of shape {:?} do not fit [1, {FEATURES}, {FRAMES}]", features.dim())));
        }
        let mut input = Array3::<f32>::zeros((1, FEATURES, FRAMES));
        input.slice_mut(ndarray::s![.., .., ..frames]).assign(features);
        let mut length = [length];
        self.request.infer(&mut [
            ("audio_signal", ElementType::F32, &[1, FEATURES as i64, FRAMES as i64], input.as_mut_ptr().cast()),
            ("length", ElementType::I64, &[1], length.as_mut_ptr().cast()),
        ])?;
        let outputs = self.request.output::<f32>("outputs")?;
        let lengths = self.request.output::<i64>("encoded_lengths")?;
        let [1, dim, steps] = outputs.shape[..] else {
            return Err(OvError::Invalid(format!("encoder output of shape {:?}", outputs.shape)));
        };
        let encoded = Array3::from_shape_vec((1, dim, steps), outputs.data)
            .map_err(|error| OvError::Invalid(error.to_string()))?
            .permuted_axes([0, 2, 1])
            .as_standard_layout()
            .to_owned();
        let decoded = lengths.data.first().copied().unwrap_or(0).clamp(0, steps as i64) as usize;
        Ok((encoded, decoded))
    }
}
