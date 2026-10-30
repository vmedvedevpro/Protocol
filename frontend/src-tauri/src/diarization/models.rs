//! ONNX model runners for diarization: pyannote segmentation-3.0 (powerset)
//! and the WeSpeaker ResNet34 embedding extractor, plus the VBx-style
//! x-vector LDA transform loaded from `xvec_transform.npz`.

use anyhow::{anyhow, Result};
use ndarray::Array3;
use ort::ep::CPU;
use ort::inputs;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::{TensorElementType, TensorRef};
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
        let [input] = session.inputs() else {
            return Err(anyhow!("{what} model must have one input, found {}", session.inputs().len()));
        };
        let [output] = session.outputs() else {
            return Err(anyhow!("{what} model must have one output, found {}", session.outputs().len()));
        };
        let input_ok = input.dtype().tensor_type() == Some(TensorElementType::Float32)
            && input.dtype().tensor_shape().is_some_and(|shape| {
                shape.len() == 3 && input_last.is_none_or(|last| shape[2] == last)
            });
        let output_ok = output.dtype().tensor_type() == Some(TensorElementType::Float32)
            && output.dtype().tensor_shape().is_some_and(|shape| {
                shape.len() == output_rank && shape[output_rank - 1] == output_last
            });
        if !input_ok || !output_ok {
            return Err(anyhow!(
                "{what} model has an unexpected interface: input {} {:?}, output {} {:?}",
                input.name(),
                input.dtype(),
                output.name(),
                output.dtype()
            ));
        }
        Ok(Self { input: input.name().to_owned(), output: output.name().to_owned() })
    }
}

/// The VBx x-vector transform from `xvec_transform.npz`:
/// out = normalize(lda^T (emb - mean1) - mean2). Only `load` builds it, after
/// checking every shape against the embedding, so `apply` cannot read past an
/// array on the live path, where it runs under the `ONLINE` mutex.
struct XvecTransform {
    mean1: Vec<f32>, // (lda_in,)
    lda: Vec<f32>,   // (lda_in * lda_out,) row-major
    mean2: Vec<f32>, // (lda_out,)
    lda_in: usize,   // EMBEDDING_DIM
    lda_out: usize,  // 128 in the bundled file, never 0
}

impl XvecTransform {
    fn load(path: &Path) -> Result<Self> {
        let (mean1, _) = read_npz_array(path, "mean1")?;
        let (lda, lda_shape) = read_npz_array(path, "lda")?;
        let (mean2, _) = read_npz_array(path, "mean2")?;
        let &[lda_in, lda_out] = lda_shape.as_slice() else {
            return Err(Self::unexpected(&lda_shape, &mean1, &mean2));
        };
        if lda_in != EMBEDDING_DIM as usize
            || lda_out == 0
            || lda.len() != lda_in * lda_out
            || mean1.len() != lda_in
            || mean2.len() != lda_out
        {
            return Err(Self::unexpected(&lda_shape, &mean1, &mean2));
        }
        Ok(Self { mean1, lda, mean2, lda_in, lda_out })
    }

    fn unexpected(lda_shape: &[usize], mean1: &[f32], mean2: &[f32]) -> anyhow::Error {
        anyhow!(
            "X-vector transform has an unexpected interface: lda {:?}, mean1 {} values, mean2 {} values; \
             expected lda [{EMBEDDING_DIM}, n], mean1 {EMBEDDING_DIM} values, mean2 n values",
            lda_shape,
            mean1.len(),
            mean2.len()
        )
    }

    /// Transform and length-normalize one embedding of `lda_in` values.
    fn apply(&self, emb: &[f32]) -> Vec<f32> {
        // out[j] = sum_i (emb[i] - mean1[i]) * lda[i][j]
        let mut out = vec![0f32; self.lda_out];
        for ((e, m), row) in emb.iter().zip(&self.mean1).zip(self.lda.chunks_exact(self.lda_out)) {
            let ci = e - m;
            if ci == 0.0 {
                continue;
            }
            for (o, w) in out.iter_mut().zip(row) {
                *o += ci * w;
            }
        }
        // out -= mean2
        for (o, m) in out.iter_mut().zip(&self.mean2) {
            *o -= m;
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

pub struct DiarizationModels {
    segmentation: Session,
    segmentation_io: Io,
    embedding: Session,
    embedding_io: Io,
    xvec: XvecTransform,
}

impl DiarizationModels {
    pub fn load(model_dir: &Path) -> Result<Self> {
        let environment = crate::onnx_runtime::environment()?;
        let seg_path = model_dir.join(SEGMENTATION_FILE);
        let emb_path = model_dir.join(EMBEDDING_FILE);
        let xform_path = model_dir.join(XVEC_TRANSFORM_FILE);

        for p in [&seg_path, &emb_path, &xform_path] {
            if !p.exists() {
                return Err(anyhow!("Missing diarization model file: {}", p.display()));
            }
        }

        // ort::Result: the builder's errors carry the builder, which anyhow cannot hold.
        let build = |path: &Path| -> ort::Result<Session> {
            Session::builder(environment)?
                .with_optimization_level(GraphOptimizationLevel::Level3)?
                .with_execution_providers(vec![CPU::default().build()])?
                .commit_from_file(path)
        };

        let segmentation = build(&seg_path)?;
        // [batch, frames, powerset classes] from a [batch, channel, samples] waveform.
        let segmentation_io = Io::of(&segmentation, "Segmentation", 3, None, POWERSET.len() as i64)?;
        let embedding = build(&emb_path)?;
        // [batch, embedding] from [batch, frames, mel bins] fbank features.
        let embedding_io = Io::of(&embedding, "Embedding", 2, Some(NUM_MEL_BINS as i64), EMBEDDING_DIM)?;

        let xvec = XvecTransform::load(&xform_path)?;

        log::info!(
            "🧑‍🤝‍🧑 Diarization models loaded (lda {}x{}, mean1 {}, mean2 {})",
            xvec.lda_in,
            xvec.lda_out,
            xvec.mean1.len(),
            xvec.mean2.len()
        );

        Ok(Self {
            segmentation,
            segmentation_io,
            embedding,
            embedding_io,
            xvec,
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
        // `Io::of` checked the declared size at load; this is the size the
        // model actually returned.
        if emb.len() != self.xvec.lda_in {
            return Err(anyhow!("Unexpected embedding size: {}", emb.len()));
        }

        Ok(self.xvec.apply(&emb))
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
    parse_npy(&buf).map_err(|error| anyhow!("{} in {}: {error}", entry_name, npz_path.display()))
}

/// Minimal `.npy` v1/v2 parser → f32 data + shape. Supports `<f4` and `<f8`,
/// C-contiguous (fortran_order == False). A file whose header claims more or
/// less data than it holds is refused.
fn parse_npy(bytes: &[u8]) -> Result<(Vec<f32>, Vec<usize>)> {
    if bytes.len() < 10 || &bytes[0..6] != b"\x93NUMPY" {
        return Err(anyhow!("Not a .npy file"));
    }
    let major = bytes[6];
    let (header_len, header_start) = if major >= 2 {
        let hl = bytes.get(8..12).ok_or_else(|| anyhow!("npy: truncated header"))?;
        (u32::from_le_bytes([hl[0], hl[1], hl[2], hl[3]]) as usize, 12usize)
    } else {
        let hl = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
        (hl, 10usize)
    };
    let data_start = header_start + header_len;
    let header = bytes
        .get(header_start..data_start)
        .ok_or_else(|| anyhow!("npy: truncated header"))?;
    let header = std::str::from_utf8(header)?;

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

    let raw = &bytes[data_start..];

    let item_size = match descr {
        d if d.ends_with("f4") => 4,
        d if d.ends_with("f8") => 8,
        other => return Err(anyhow!("npy: unsupported dtype {}", other)),
    };
    let expected = shape
        .iter()
        .try_fold(item_size, |size: usize, &dim| size.checked_mul(dim))
        .ok_or_else(|| anyhow!("npy: shape {:?} is too large", shape))?;
    if raw.len() != expected {
        return Err(anyhow!(
            "npy: shape {:?} needs {} bytes of data, the file holds {}",
            shape,
            expected,
            raw.len()
        ));
    }

    let data: Vec<f32> = if item_size == 4 {
        raw.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    } else {
        raw.chunks_exact(8)
            .map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]) as f32)
            .collect()
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

    /// A float32 `.npy` whose header claims `shape`; `values` may hold less
    /// than that to make a truncated array.
    fn npy(shape: &[usize], values: &[f32]) -> Vec<u8> {
        let dims: Vec<String> = shape.iter().map(|d| d.to_string()).collect();
        let shape = match dims.as_slice() {
            [one] => format!("({one},)"),
            _ => format!("({})", dims.join(", ")),
        };
        let mut header = format!("{{'descr': '<f4', 'fortran_order': False, 'shape': {shape}, }}");
        // numpy pads the header to a multiple of 64 bytes and ends it with a newline.
        while (10 + header.len() + 1) % 64 != 0 {
            header.push(' ');
        }
        header.push('\n');
        let mut bytes = b"\x93NUMPY\x01\x00".to_vec();
        bytes.extend_from_slice(&(header.len() as u16).to_le_bytes());
        bytes.extend_from_slice(header.as_bytes());
        for value in values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    fn write_transform(path: &Path, mean1: Vec<u8>, lda: Vec<u8>, mean2: Vec<u8>) {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, bytes) in [("mean1", mean1), ("lda", lda), ("mean2", mean2)] {
            zip.start_file(format!("{name}.npy"), zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    /// A consistent transform: lda `(lda_in, lda_out)` and the means it needs.
    fn write_consistent_transform(path: &Path, lda_in: usize, lda_out: usize) {
        write_transform(
            path,
            npy(&[lda_in], &vec![0.0; lda_in]),
            npy(&[lda_in, lda_out], &vec![0.1; lda_in * lda_out]),
            npy(&[lda_out], &vec![0.0; lda_out]),
        );
    }

    #[test]
    fn the_bundled_xvector_transform_fits_the_embedding() {
        let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/diarization");
        let xvec = XvecTransform::load(&bundled.join(XVEC_TRANSFORM_FILE)).unwrap();
        assert_eq!((xvec.lda_in, xvec.lda_out), (EMBEDDING_DIM as usize, 128));
        let out = xvec.apply(&[1.0; EMBEDDING_DIM as usize]);
        assert_eq!(out.len(), 128);
        assert!((out.iter().map(|v| v * v).sum::<f32>() - 1.0).abs() < 1e-5);
    }

    #[test]
    fn a_transform_for_another_embedding_size_is_refused_at_load() {
        let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/diarization");
        let dir = tempfile::tempdir().unwrap();
        for name in [SEGMENTATION_FILE, EMBEDDING_FILE] {
            std::fs::copy(bundled.join(name), dir.path().join(name)).unwrap();
        }
        // Consistent in itself, but for 512-d embeddings.
        write_consistent_transform(&dir.path().join(XVEC_TRANSFORM_FILE), 512, 128);
        let error = DiarizationModels::load(dir.path()).err().expect("loaded a transform for 512-d embeddings");
        assert!(error.to_string().contains("X-vector transform has an unexpected interface"), "{error}");
    }

    #[test]
    fn xvector_means_of_the_wrong_length_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(XVEC_TRANSFORM_FILE);
        let lda = || npy(&[256, 128], &[0.1; 256 * 128]);
        for (mean1, mean2) in [(255, 128), (256, 127), (128, 256)] {
            write_transform(&path, npy(&[mean1], &vec![0.0; mean1]), lda(), npy(&[mean2], &vec![0.0; mean2]));
            let error = XvecTransform::load(&path).err().expect("loaded means of the wrong length");
            assert!(error.to_string().contains("unexpected interface"), "{mean1}/{mean2}: {error}");
        }
        write_consistent_transform(&path, 256, 128);
        XvecTransform::load(&path).unwrap();
    }

    #[test]
    fn a_truncated_array_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(XVEC_TRANSFORM_FILE);
        write_transform(
            &path,
            npy(&[256], &[0.0; 256]),
            // The header claims (256, 128); the file holds half of it.
            npy(&[256, 128], &[0.1; 256 * 64]),
            npy(&[128], &[0.0; 128]),
        );
        let error = XvecTransform::load(&path).err().expect("loaded a truncated lda");
        let message = error.to_string();
        assert!(message.contains("lda.npy"), "{message}");
        assert!(message.contains("needs 131072 bytes of data, the file holds 65536"), "{message}");

        // A header that ends past the file.
        let mut short = npy(&[4], &[0.0; 4]);
        short.truncate(40);
        assert!(parse_npy(&short).is_err());
        assert!(parse_npy(b"\x93NUMPY\x02\x00\x10\x00").is_err());
    }
}
