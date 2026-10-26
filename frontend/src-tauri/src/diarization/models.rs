//! ONNX model runners for diarization: pyannote segmentation-3.0 (powerset)
//! and the WeSpeaker ResNet34 embedding extractor, plus the VBx-style
//! x-vector LDA transform loaded from `xvec_transform.npz`.

use anyhow::{anyhow, Result};
use ndarray::Array3;
use ort::execution_providers::CPUExecutionProvider;
use ort::inputs;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::tensor::TensorElementType;
use ort::value::TensorRef;
use std::io::Read;
use std::path::Path;

use super::dsp::{self, NUM_MEL_BINS};

/// pyannote segmentation-3.0 powerset class → active local speaker indices.
/// 3 speakers, max 2 simultaneous → 7 classes.
const POWERSET: [&[usize]; 7] = [
    &[],     // 0: silence
    &[0],    // 1
    &[1],    // 2
    &[2],    // 3
    &[0, 1], // 4
    &[0, 2], // 5
    &[1, 2], // 6
];
pub const MAX_LOCAL_SPEAKERS: usize = 3;

/// The three files of a Pyannote model directory, bundled or user-supplied.
/// Their sources and pins are `model_integrity::PYANNOTE`. Protocol 0.3.0
/// bundled other exports under other names (`segmentation-3.0-fp16.onnx`,
/// `wespeaker-resnet34-LM.onnx`), so a copy of those left in the data folder
/// is never loaded in place of these.
pub const SEGMENTATION_FILE: &str = "segmentation-3.0.onnx";
pub const EMBEDDING_FILE: &str = "voxceleb_resnet34_LM.onnx";
pub const XVEC_TRANSFORM_FILE: &str = "xvec_transform.npz";

/// Dimension of the WeSpeaker embedding the x-vector transform expects.
const EMBEDDING_DIM: i64 = 256;

/// The single input and output of an ONNX model. Exports name them
/// differently (`waveform`/`segmentation` and `fbank`/`embedding` in the files
/// Protocol 0.3.0 bundled, `input_values`/`logits` from onnx-community,
/// `feats`/`embs` from WeSpeaker), so the names are read from the file, and
/// the shapes are checked instead: another model is refused at load rather
/// than misread.
struct Io {
    input: String,
    output: String,
}

impl Io {
    /// `input_last` and `output_last` are the required last dimensions, `None`
    /// for one that varies with the audio.
    fn of(
        session: &Session,
        what: &str,
        output_rank: usize,
        input_last: Option<i64>,
        output_last: i64,
    ) -> Result<Self> {
        let [input] = session.inputs.as_slice() else {
            return Err(anyhow!("{what} model must have one input, found {}", session.inputs.len()));
        };
        let [output] = session.outputs.as_slice() else {
            return Err(anyhow!("{what} model must have one output, found {}", session.outputs.len()));
        };
        let input_ok = input.input_type.tensor_type() == Some(TensorElementType::Float32)
            && input.input_type.tensor_shape().is_some_and(|shape| {
                shape.len() == 3 && input_last.is_none_or(|last| shape[2] == last)
            });
        let output_ok = output.output_type.tensor_type() == Some(TensorElementType::Float32)
            && output.output_type.tensor_shape().is_some_and(|shape| {
                shape.len() == output_rank && shape[output_rank - 1] == output_last
            });
        if !input_ok || !output_ok {
            return Err(anyhow!(
                "{what} model has an unexpected interface: input {} {:?}, output {} {:?}",
                input.name,
                input.input_type,
                output.name,
                output.output_type
            ));
        }
        Ok(Self { input: input.name.clone(), output: output.name.clone() })
    }
}

pub struct DiarizationModels {
    segmentation: Session,
    segmentation_io: Io,
    embedding: Session,
    embedding_io: Io,
    // x-vector transform (VBx front-end): out = normalize(lda^T (emb - mean1) - mean2)
    mean1: Vec<f32>, // (256,)
    lda: Vec<f32>,   // (256*128,) row-major
    mean2: Vec<f32>, // (128,)
    lda_in: usize,   // 256
    lda_out: usize,  // 128
}

impl DiarizationModels {
    pub fn load(model_dir: &Path) -> Result<Self> {
        crate::onnx_runtime::ensure_available()?;
        let seg_path = model_dir.join(SEGMENTATION_FILE);
        let emb_path = model_dir.join(EMBEDDING_FILE);
        let xform_path = model_dir.join(XVEC_TRANSFORM_FILE);

        for p in [&seg_path, &emb_path, &xform_path] {
            if !p.exists() {
                return Err(anyhow!("Missing diarization model file: {}", p.display()));
            }
        }

        let build = |path: &Path| -> Result<Session> {
            Ok(Session::builder()?
                .with_optimization_level(GraphOptimizationLevel::Level3)?
                .with_execution_providers(vec![CPUExecutionProvider::default().build()])?
                .commit_from_file(path)?)
        };

        let segmentation = build(&seg_path)?;
        // [batch, frames, powerset classes] from a [batch, channel, samples] waveform.
        let segmentation_io = Io::of(&segmentation, "Segmentation", 3, None, POWERSET.len() as i64)?;
        let embedding = build(&emb_path)?;
        // [batch, embedding] from [batch, frames, mel bins] fbank features.
        let embedding_io = Io::of(&embedding, "Embedding", 2, Some(NUM_MEL_BINS as i64), EMBEDDING_DIM)?;

        let (mean1, _s1) = read_npz_array(&xform_path, "mean1")?;
        let (lda, s_lda) = read_npz_array(&xform_path, "lda")?;
        let (mean2, _s2) = read_npz_array(&xform_path, "mean2")?;

        if s_lda.len() != 2 {
            return Err(anyhow!("Unexpected lda shape: {:?}", s_lda));
        }
        let lda_in = s_lda[0];
        let lda_out = s_lda[1];

        log::info!(
            "🧑‍🤝‍🧑 Diarization models loaded (lda {}x{}, mean1 {}, mean2 {})",
            lda_in,
            lda_out,
            mean1.len(),
            mean2.len()
        );

        Ok(Self {
            segmentation,
            segmentation_io,
            embedding,
            embedding_io,
            mean1,
            lda,
            mean2,
            lda_in,
            lda_out,
        })
    }

    /// Run segmentation on a single window (16 kHz mono). Returns per-frame
    /// local-speaker activity `[frames][MAX_LOCAL_SPEAKERS]`.
    pub fn segment_window(&mut self, window: &[f32]) -> Result<Vec<[bool; MAX_LOCAL_SPEAKERS]>> {
        let n = window.len();
        let arr = Array3::<f32>::from_shape_vec((1, 1, n), window.to_vec())?;
        let outputs = self
            .segmentation
            .run(inputs![self.segmentation_io.input.as_str() => TensorRef::from_array_view(arr.view())?])?;
        let seg = outputs
            .get(&self.segmentation_io.output)
            .ok_or_else(|| anyhow!("segmentation output missing"))?
            .try_extract_array::<f32>()?;

        // Shape [1, frames, 7].
        let shape = seg.shape().to_vec();
        if shape.len() != 3 || shape[2] != POWERSET.len() {
            return Err(anyhow!("Unexpected segmentation shape: {:?}", shape));
        }
        let frames = shape[1];
        let seg = seg.into_dimensionality::<ndarray::Ix3>()?;

        let mut out = Vec::with_capacity(frames);
        for f in 0..frames {
            // Argmax over the 7 powerset classes.
            let mut best = 0usize;
            let mut best_v = f32::NEG_INFINITY;
            for c in 0..POWERSET.len() {
                let v = seg[[0, f, c]];
                if v > best_v {
                    best_v = v;
                    best = c;
                }
            }
            let mut active = [false; MAX_LOCAL_SPEAKERS];
            for &s in POWERSET[best] {
                if s < MAX_LOCAL_SPEAKERS {
                    active[s] = true;
                }
            }
            out.push(active);
        }
        Ok(out)
    }

    /// Extract a length-normalized 128-d x-vector for a 16 kHz mono segment.
    pub fn embed(&mut self, segment: &[f32]) -> Result<Vec<f32>> {
        let feats = dsp::compute_fbank(segment);
        if feats.is_empty() {
            return Err(anyhow!("segment too short for fbank"));
        }
        let t = feats.len();
        let mut flat = Vec::with_capacity(t * NUM_MEL_BINS);
        for row in &feats {
            flat.extend_from_slice(row);
        }
        let arr = Array3::<f32>::from_shape_vec((1, t, NUM_MEL_BINS), flat)?;

        // Scope the session borrow so `outputs` is dropped before we call
        // `transform_xvector` (which needs an immutable borrow of `self`).
        let emb: Vec<f32> = {
            let outputs = self
                .embedding
                .run(inputs![self.embedding_io.input.as_str() => TensorRef::from_array_view(arr.view())?])?;
            let emb = outputs
                .get(&self.embedding_io.output)
                .ok_or_else(|| anyhow!("embedding output missing"))?
                .try_extract_array::<f32>()?;
            emb.iter().copied().collect()
        };

        Ok(self.transform_xvector(&emb))
    }

    /// Apply the VBx x-vector transform + length normalization.
    fn transform_xvector(&self, emb: &[f32]) -> Vec<f32> {
        let din = self.lda_in.min(emb.len());
        // centered = emb - mean1
        let mut centered = vec![0f32; self.lda_in];
        for i in 0..din {
            let m = self.mean1.get(i).copied().unwrap_or(0.0);
            centered[i] = emb[i] - m;
        }
        // out[j] = sum_i centered[i] * lda[i][j]
        let mut out = vec![0f32; self.lda_out];
        for i in 0..self.lda_in {
            let ci = centered[i];
            if ci == 0.0 {
                continue;
            }
            let base = i * self.lda_out;
            for j in 0..self.lda_out {
                out[j] += ci * self.lda[base + j];
            }
        }
        // out -= mean2
        for j in 0..self.lda_out {
            out[j] -= self.mean2.get(j).copied().unwrap_or(0.0);
        }
        // length-normalize
        let norm = out.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 1e-8 {
            for v in out.iter_mut() {
                *v /= norm;
            }
        }
        out
    }
}

/// Read one array from an `.npz` (zip of `.npy`) as `f32`, returning (data, shape).
fn read_npz_array(npz_path: &Path, name: &str) -> Result<(Vec<f32>, Vec<usize>)> {
    let file = std::fs::File::open(npz_path)?;
    let mut zip = zip::ZipArchive::new(file)?;
    let entry_name = format!("{}.npy", name);

    let mut buf = Vec::new();
    {
        let mut entry = zip
            .by_name(&entry_name)
            .map_err(|_| anyhow!("{} not found in {}", entry_name, npz_path.display()))?;
        entry.read_to_end(&mut buf)?;
    }
    parse_npy(&buf)
}

/// Minimal `.npy` v1/v2 parser → f32 data + shape. Supports `<f4` and `<f8`,
/// C-contiguous (fortran_order == False).
fn parse_npy(bytes: &[u8]) -> Result<(Vec<f32>, Vec<usize>)> {
    if bytes.len() < 10 || &bytes[0..6] != b"\x93NUMPY" {
        return Err(anyhow!("Not a .npy file"));
    }
    let major = bytes[6];
    let (header_len, header_start) = if major >= 2 {
        let hl = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
        (hl, 12usize)
    } else {
        let hl = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
        (hl, 10usize)
    };
    let header = std::str::from_utf8(&bytes[header_start..header_start + header_len])?;

    let descr = extract_between(header, "'descr':", ",")
        .or_else(|| extract_between(header, "'descr': ", ","))
        .ok_or_else(|| anyhow!("npy: no descr"))?;
    let descr = descr.trim().trim_matches('\'');
    let fortran = header.contains("'fortran_order': True");
    if fortran {
        return Err(anyhow!("npy: fortran_order not supported"));
    }

    // shape tuple
    let shape_str =
        extract_between(header, "'shape':", ")").ok_or_else(|| anyhow!("npy: no shape"))?;
    let shape: Vec<usize> = shape_str
        .trim()
        .trim_start_matches('(')
        .split(',')
        .filter_map(|s| s.trim().parse::<usize>().ok())
        .collect();

    let data_start = header_start + header_len;
    let raw = &bytes[data_start..];

    let data: Vec<f32> = match descr {
        d if d.ends_with("f4") => raw
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
        d if d.ends_with("f8") => raw
            .chunks_exact(8)
            .map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]) as f32)
            .collect(),
        other => return Err(anyhow!("npy: unsupported dtype {}", other)),
    };

    Ok((data, shape))
}

fn extract_between(s: &str, start: &str, end: &str) -> Option<String> {
    let i = s.find(start)? + start.len();
    let rest = &s[i..];
    let j = rest.find(end)?;
    Some(rest[..j].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_model_with_another_interface_is_refused_at_load() {
        let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/diarization");
        let dir = tempfile::tempdir().unwrap();
        // The segmentation model where the embedding model belongs.
        for (from, to) in [
            (SEGMENTATION_FILE, SEGMENTATION_FILE),
            (SEGMENTATION_FILE, EMBEDDING_FILE),
            (XVEC_TRANSFORM_FILE, XVEC_TRANSFORM_FILE),
        ] {
            std::fs::copy(bundled.join(from), dir.path().join(to)).unwrap();
        }
        let error = DiarizationModels::load(dir.path()).err().expect("loaded a segmentation model as the embedding model");
        assert!(error.to_string().contains("Embedding model has an unexpected interface"), "{error}");
    }
}
