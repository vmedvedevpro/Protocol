//! Copies of the diarization models Protocol 0.3.0 bundled (issue #23).
//!
//! 0.3.0 shipped its own exports of segmentation-3.0 and WeSpeaker
//! ResNet34-LM, and its Settings repair download saved copies of them in the
//! user's model folder. Later versions bundle public exports under other
//! names (`models::SEGMENTATION_FILE`, `models::EMBEDDING_FILE`), so nothing
//! loads the old files any more. The Windows installer deletes the old bundled
//! files (`windows/installer-hooks.nsh`); this module deletes the user-folder
//! copies, but only a file whose size and SHA-256 are the 0.3.0 file's. A file
//! under one of those names with other content is the user's own model: it is
//! kept, unused, and the log says how to use it again.

use crate::model_integrity::Pinned;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

/// The two files as Protocol 0.3.0 pinned them.
const RETIRED: [Pinned; 2] = [
    Pinned {
        file: "segmentation-3.0-fp16.onnx",
        size: 2_977_738,
        sha256: "b0acba8e4cc30e8ec2bd33075ce95f282d66acab86fb155860d8deddbfacd30c",
    },
    Pinned {
        file: "wespeaker-resnet34-LM.onnx",
        size: 26_544_003,
        sha256: "992a5632618f11644608dbfbd28d401cd8480713207dc2db9af1c4cfc2c8652e",
    },
];

/// Deletes the 0.3.0 copies from `dir` (the user's diarization model folder),
/// and the `.part` file of an interrupted 0.3.0 repair download, which no
/// later version resumes. Hashes up to 29 MB, so callers run it on a blocking
/// thread. Idempotent: a failure only leaves a file for the next start.
pub fn remove_retired_copies(dir: &Path) {
    remove_copies(dir, &RETIRED);
}

fn remove_copies(dir: &Path, retired: &[Pinned]) {
    for pinned in retired {
        let part = dir.join(format!("{}.part", pinned.file));
        if part.exists() {
            match std::fs::remove_file(&part) {
                Ok(()) => log::info!("Removed {}, a partial download of a retired diarization model", part.display()),
                Err(error) => log::warn!("Could not remove {}: {}", part.display(), error),
            }
        }

        let path = dir.join(pinned.file);
        if !path.exists() {
            continue;
        }
        match is_pinned_file(&path, pinned) {
            Ok(true) => match std::fs::remove_file(&path) {
                Ok(()) => log::info!("Removed {}, the diarization model Protocol 0.3.0 used", path.display()),
                Err(error) => log::warn!("Could not remove {}: {}", path.display(), error),
            },
            Ok(false) => log::warn!(
                "{} is not the file Protocol 0.3.0 bundled and is no longer loaded; to use it, rename the \
                 three files of a custom model to {}, {} and {}",
                path.display(),
                super::models::SEGMENTATION_FILE,
                super::models::EMBEDDING_FILE,
                super::models::XVEC_TRANSFORM_FILE
            ),
            Err(error) => log::warn!("Could not check {}: {}", path.display(), error),
        }
    }
}

fn is_pinned_file(path: &Path, pinned: &Pinned) -> std::io::Result<bool> {
    if std::fs::metadata(path)?.len() != pinned.size {
        return Ok(false);
    }
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()) == pinned.sha256)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stands in for a 0.3.0 file: the real ones are no longer in the
    /// repository, so the test pins its own bytes under a retired name.
    fn pinned_copy(dir: &Path, name: &'static str, bytes: &[u8]) -> Pinned {
        std::fs::write(dir.join(name), bytes).unwrap();
        Pinned {
            file: name,
            size: bytes.len() as u64,
            sha256: Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str()),
        }
    }

    #[test]
    fn only_a_file_with_the_pinned_content_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let pinned = pinned_copy(dir.path(), "segmentation-3.0-fp16.onnx", b"the 0.3.0 export");
        let path = dir.path().join(pinned.file);

        // Same size, other bytes: a custom model the user put there.
        std::fs::write(&path, b"the user's model").unwrap();
        remove_copies(dir.path(), &[pinned]);
        assert!(path.exists());
        // Another size is not even hashed.
        std::fs::write(&path, b"short").unwrap();
        remove_copies(dir.path(), &[pinned]);
        assert!(path.exists());

        std::fs::write(&path, b"the 0.3.0 export").unwrap();
        remove_copies(dir.path(), &[pinned]);
        assert!(!path.exists());
        remove_copies(dir.path(), &[pinned]);
    }

    #[test]
    fn custom_files_and_current_models_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let keep = [
            // Old names, other content (the real 0.3.0 pins cannot match these).
            "segmentation-3.0-fp16.onnx",
            "wespeaker-resnet34-LM.onnx",
            super::super::models::SEGMENTATION_FILE,
            super::super::models::EMBEDDING_FILE,
            super::super::models::XVEC_TRANSFORM_FILE,
            "nemotron3_diar_v3.onnx",
        ];
        for name in keep {
            std::fs::write(dir.path().join(name), b"fixture").unwrap();
        }
        std::fs::write(dir.path().join("wespeaker-resnet34-LM.onnx.part"), b"partial").unwrap();
        std::fs::write(dir.path().join("segmentation-3.0-fp16.onnx.part"), b"partial").unwrap();

        remove_retired_copies(dir.path());
        remove_retired_copies(dir.path());

        for name in keep {
            assert!(dir.path().join(name).exists(), "{name} was removed");
        }
        assert!(!dir.path().join("wespeaker-resnet34-LM.onnx.part").exists());
        assert!(!dir.path().join("segmentation-3.0-fp16.onnx.part").exists());
    }

    #[test]
    fn a_missing_folder_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        remove_retired_copies(&dir.path().join("models/diarization"));
    }

    #[test]
    fn retired_names_are_not_the_current_ones() {
        use super::super::models::{EMBEDDING_FILE, SEGMENTATION_FILE, XVEC_TRANSFORM_FILE};
        for pinned in &RETIRED {
            assert!(![SEGMENTATION_FILE, EMBEDDING_FILE, XVEC_TRANSFORM_FILE].contains(&pinned.file));
        }
    }
}
