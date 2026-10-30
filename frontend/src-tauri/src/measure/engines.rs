//! The engines a command loads. Models are opened in place and read only.
//!
//! The Labs switches (Whisper's strict silence threshold, Parakeet's DirectML
//! encoder) are read from the app's data folder, which for a test binary is
//! `data/` beside it (`paths::install_data_root`, created empty): they are
//! off, as on a new install, unless `true` is written into
//! `whisper_strict_silence.txt` or `parakeet_gpu_enabled.txt` there.

use std::path::Path;

use anyhow::Result;

use crate::parakeet_engine::ParakeetEngine;
use crate::whisper_engine::WhisperEngine;

pub struct Engines {
    pub whisper: Option<Loaded<WhisperEngine>>,
    pub parakeet: Option<Loaded<ParakeetEngine>>,
    // Both engines take a models folder; they get an empty one, so nothing
    // is ever written beside a real model.
    _models_dir: tempfile::TempDir,
}

pub struct Loaded<E> {
    pub engine: E,
    /// The model's file or folder name, for the outputs.
    pub model: String,
    /// What the engine runs on, as the app logs it.
    pub acceleration: &'static str,
}

impl Engines {
    pub async fn open(whisper_model: Option<&Path>, parakeet_model: Option<&Path>) -> Result<Self> {
        let models_dir = tempfile::tempdir()?;
        let whisper = match whisper_model {
            Some(path) => {
                let engine = WhisperEngine::new_with_models_dir(Some(models_dir.path().to_path_buf()))?;
                let acceleration = engine.load_model_in_place(path).await?;
                Some(Loaded { engine, model: file_name(path), acceleration })
            }
            None => None,
        };
        let parakeet = match parakeet_model {
            Some(path) => {
                let engine = ParakeetEngine::new_with_models_dir(Some(models_dir.path().to_path_buf()))?;
                engine.load_model_in_place(path).await?;
                let acceleration =
                    if crate::parakeet_engine::labs::enabled() { "DirectML encoder (Labs)" } else { "CPU" };
                Some(Loaded { engine, model: file_name(path), acceleration })
            }
            None => None,
        };
        Ok(Self { whisper, parakeet, _models_dir: models_dir })
    }
}

fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into_owned())
}
