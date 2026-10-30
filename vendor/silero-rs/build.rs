//! Downloads the Silero VAD v4 model that `VadSession::new` embeds, instead of
//! keeping the binary in git. The file is the one upstream silero-rs commits
//! under `models/` (same SHA-256), fetched from its original publisher at the
//! commit of the `v4.0` tag, and is verified before it is used.

use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process,
};

const MODEL_URL: &str = "https://raw.githubusercontent.com/snakers4/silero-vad/915dd3d639b8333a52e001af095f87c5b7f1e0ac/files/silero_vad.onnx";
const MODEL_SIZE: u64 = 1_807_522;
const MODEL_SHA256: &str = "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if env::var_os("CARGO_FEATURE_STATIC_MODEL").is_none() {
        return;
    }

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let model = out_dir.join("silero_vad.onnx");
    if verify(&model).is_ok() {
        return;
    }

    let partial = out_dir.join(format!("silero_vad.onnx.{}.part", process::id()));
    let result = download(&partial).and_then(|()| verify(&partial));
    if let Err(error) = result {
        let _ = fs::remove_file(&partial);
        panic!("Failed to fetch the Silero VAD model from {MODEL_URL}: {error}");
    }
    fs::rename(&partial, &model).unwrap_or_else(|error| {
        let _ = fs::remove_file(&partial);
        panic!("Failed to finalize {}: {error}", model.display())
    });
}

fn download(destination: &Path) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|error| format!("cannot create download client: {error}"))?;
    let response = client
        .get(MODEL_URL)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("download failed: {error}"))?;
    let mut file = File::create(destination)
        .map_err(|error| format!("cannot create {}: {error}", destination.display()))?;
    // One byte more than expected is enough to reject an oversized response.
    let copied = std::io::copy(&mut response.take(MODEL_SIZE + 1), &mut file)
        .map_err(|error| format!("download failed: {error}"))?;
    if copied != MODEL_SIZE {
        return Err(format!("received {copied} bytes, expected {MODEL_SIZE}"));
    }
    file.flush()
        .map_err(|error| format!("cannot write {}: {error}", destination.display()))
}

fn verify(path: &Path) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        size += read as u64;
        hasher.update(&buffer[..read]);
    }
    let sha256 = format!("{:x}", hasher.finalize());
    if size != MODEL_SIZE || sha256 != MODEL_SHA256 {
        return Err(format!(
            "model has size {size} and SHA-256 {sha256}, expected {MODEL_SIZE} and {MODEL_SHA256}"
        ));
    }
    Ok(())
}
