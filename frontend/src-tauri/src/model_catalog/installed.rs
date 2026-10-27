//! What an installed model is: the commit and the size and SHA-256 of each
//! file it was verified against.
//!
//! A download writes an install record next to the model (`<file>.install.json`
//! for Whisper and summary models, `install.json` in a Parakeet model's
//! folder): first with `complete: false`, so an interrupted download resumes
//! from the same commit, then `complete: true` once every file matched. The
//! record is what a model is checked against before it is loaded and what an
//! update check compares with Hugging Face.
//!
//! Models downloaded by 0.3.x have no record. Their files were pinned in the
//! app (`LEGACY`, the 0.3.0 tables), so they are recognised by id and size and
//! checked against those pins; their `.verified` markers stay valid because
//! the SHA-256 is the same.

use crate::model_integrity::{self, Pinned};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::huggingface::Resolved;
use super::schema::{is_sha256, Engine, Entry};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordFile {
    pub name: String,
    pub size: u64,
    pub sha256: String,
    /// The Git blob id in the listing; compares files kept outside LFS.
    #[serde(default)]
    pub git_oid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstallRecord {
    pub id: String,
    pub repo: String,
    pub commit: String,
    pub complete: bool,
    pub files: Vec<RecordFile>,
}

impl InstallRecord {
    pub fn from_resolved(id: &str, resolved: &Resolved, complete: bool) -> Self {
        Self {
            id: id.to_string(),
            repo: resolved.repo.clone(),
            commit: resolved.commit.clone(),
            complete,
            files: resolved
                .files
                .iter()
                .map(|file| RecordFile {
                    name: file.name.clone(),
                    size: file.pinned.size,
                    sha256: file.pinned.sha256.to_string(),
                    git_oid: Some(file.git_oid.clone()),
                })
                .collect(),
        }
    }

    /// Whether the record describes exactly the files of `entry`.
    fn fits(&self, entry: &Entry) -> bool {
        self.id == entry.id
            && self.files.len() == entry.files.len()
            && entry.files.iter().all(|file| self.files.iter().any(|recorded| recorded.name == file.name))
            && self.files.iter().all(|file| is_sha256(&file.sha256))
    }
}

/// The record of a single-file model (Whisper, summary).
pub fn record_path_for_file(file: &Path) -> PathBuf {
    let mut name = file.file_name().unwrap_or_default().to_os_string();
    name.push(".install.json");
    file.with_file_name(name)
}

/// The record of a model kept in its own folder (Parakeet).
pub fn record_path_for_dir(dir: &Path) -> PathBuf {
    dir.join("install.json")
}

pub fn read_record(path: &Path) -> Option<InstallRecord> {
    let bytes = std::fs::read(path).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(record) => Some(record),
        Err(error) => {
            log::warn!("Ignoring the unreadable install record {}: {error}", path.display());
            None
        }
    }
}

pub fn write_record(path: &Path, record: &InstallRecord) -> std::io::Result<()> {
    super::write_atomically(path, &serde_json::to_vec_pretty(record)?)
}

pub fn remove_record(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// Downloaded by a build that writes install records.
    Record,
    /// Downloaded by 0.3.x: the 0.3.0 pins.
    Legacy,
}

/// The content an installed copy of an entry must have.
#[derive(Debug, Clone)]
pub struct Expected {
    pub commit: String,
    /// In the entry's file order.
    pub files: Vec<&'static Pinned>,
    /// Git blob ids where known (records); `None` for 0.3.x installs.
    pub git_oids: Vec<Option<String>>,
    pub source: Source,
}

impl Expected {
    pub fn pin(&self, name: &str) -> Option<&'static Pinned> {
        self.files.iter().copied().find(|pinned| pinned.file == name)
    }

    pub fn total_size(&self) -> u64 {
        self.files.iter().map(|pinned| pinned.size).sum()
    }
}

/// What the copy of `entry` whose record is at `record_path` must be: its
/// complete record, else the 0.3.0 pins of the entry. `None` while a download
/// has not finished, and for a model with neither.
pub fn expected(entry: &Entry, record_path: &Path) -> Option<Expected> {
    let record = read_record(record_path).filter(|record| record.fits(entry));
    if record.as_ref().is_some_and(|record| !record.complete) {
        return None;
    }
    if let Some(record) = record {
        let ordered: Vec<&RecordFile> = entry
            .files
            .iter()
            .filter_map(|file| record.files.iter().find(|recorded| recorded.name == file.name))
            .collect();
        return Some(Expected {
            commit: record.commit.clone(),
            files: ordered.iter().map(|file| model_integrity::intern(&file.name, file.size, &file.sha256)).collect(),
            git_oids: ordered.iter().map(|file| file.git_oid.clone()).collect(),
            source: Source::Record,
        });
    }
    legacy(entry)
}

/// The record of a download that has not finished, if it fits `entry`: the
/// download resumes from the same commit, so the kept bytes stay valid.
pub fn partial(entry: &Entry, record_path: &Path) -> Option<InstallRecord> {
    read_record(record_path).filter(|record| !record.complete && record.fits(entry))
}

/// The pins of each file `entry` lists, from a partial record, in entry order.
pub fn record_pins(entry: &Entry, record: &InstallRecord) -> Vec<&'static Pinned> {
    entry
        .files
        .iter()
        .filter_map(|file| record.files.iter().find(|recorded| recorded.name == file.name))
        .map(|file| model_integrity::intern(&file.name, file.size, &file.sha256))
        .collect()
}

/// What a download of `entry` fetches, and whether bytes already on disk may
/// be resumed.
pub struct Plan {
    pub resolved: Resolved,
    pub keep_partial: bool,
}

/// An unfinished download keeps its commit, so its kept bytes stay valid and
/// no request to the API is needed. Otherwise the entry is resolved now; a
/// partial file left without a record (by 0.3.x) is resumed only when the
/// commit is still the one 0.3.0 pinned, since other bytes would fail the
/// final hash after the whole download.
pub async fn plan_download(client: &reqwest::Client, hub: &str, entry: &Entry, record_path: &Path) -> anyhow::Result<Plan> {
    if let Some(record) = partial(entry, record_path) {
        let files = entry
            .files
            .iter()
            .zip(record_pins(entry, &record))
            .map(|(file, pinned)| super::huggingface::ResolvedFile {
                name: file.name.clone(),
                path: file.path.clone(),
                url: super::huggingface::download_url(hub, &record.repo, &record.commit, &file.path),
                pinned,
                git_oid: record
                    .files
                    .iter()
                    .find(|recorded| recorded.name == file.name)
                    .and_then(|recorded| recorded.git_oid.clone())
                    .unwrap_or_default(),
            })
            .collect();
        let resolved = Resolved { repo: record.repo, commit: record.commit, files };
        return Ok(Plan { resolved, keep_partial: true });
    }
    let resolved = super::huggingface::resolve(client, hub, entry).await?;
    let keep_partial = legacy_model(entry.engine, &entry.id).is_some_and(|model| model.commit == resolved.commit);
    Ok(Plan { resolved, keep_partial })
}

// --- 0.3.0 pins ---------------------------------------------------------------

/// A model as 0.3.0 pinned it.
pub struct LegacyModel {
    pub engine: Engine,
    pub id: &'static str,
    pub repo: &'static str,
    pub commit: &'static str,
    pub files: &'static [Pinned],
}

const fn pin(file: &'static str, size: u64, sha256: &'static str) -> Pinned {
    Pinned { file, size, sha256 }
}

const WHISPER_REPO: &str = "ggerganov/whisper.cpp";
const WHISPER_COMMIT: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";

const fn whisper(id: &'static str, files: &'static [Pinned]) -> LegacyModel {
    LegacyModel { engine: Engine::Whisper, id, repo: WHISPER_REPO, commit: WHISPER_COMMIT, files }
}

const fn summary(id: &'static str, repo: &'static str, commit: &'static str, files: &'static [Pinned]) -> LegacyModel {
    LegacyModel { engine: Engine::Llama, id, repo, commit, files }
}

/// The pins 0.3.0 compiled in (`model_integrity.rs` at `v0.3.0`; how they were
/// obtained is recorded there). Frozen: models installed by 0.3.x are checked
/// against them until they are updated.
pub const LEGACY: &[LegacyModel] = &[
    whisper("tiny", &[pin("ggml-tiny.bin", 77_691_713, "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21")]),
    whisper("base", &[pin("ggml-base.bin", 147_951_465, "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe")]),
    whisper("small", &[pin("ggml-small.bin", 487_601_967, "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b")]),
    whisper("medium", &[pin("ggml-medium.bin", 1_533_763_059, "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208")]),
    whisper(
        "large-v3-turbo",
        &[pin("ggml-large-v3-turbo.bin", 1_624_555_275, "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69")],
    ),
    whisper("large-v3", &[pin("ggml-large-v3.bin", 3_095_033_483, "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2")]),
    whisper("tiny-q5_1", &[pin("ggml-tiny-q5_1.bin", 32_152_673, "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7")]),
    whisper("base-q5_1", &[pin("ggml-base-q5_1.bin", 59_707_625, "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898")]),
    whisper("small-q5_1", &[pin("ggml-small-q5_1.bin", 190_085_487, "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb")]),
    whisper("medium-q5_0", &[pin("ggml-medium-q5_0.bin", 539_212_467, "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f")]),
    whisper(
        "large-v3-turbo-q5_0",
        &[pin("ggml-large-v3-turbo-q5_0.bin", 574_041_195, "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2")],
    ),
    whisper("large-v3-q5_0", &[pin("ggml-large-v3-q5_0.bin", 1_081_140_203, "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1")]),
    LegacyModel {
        engine: Engine::Parakeet,
        id: "parakeet-tdt-0.6b-v2-int8",
        repo: "istupakov/parakeet-tdt-0.6b-v2-onnx",
        commit: "0bbb45a3365852604aef28b538a8f066f4ccaa85",
        files: &[
            pin("encoder-model.int8.onnx", 652_184_014, "3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155"),
            pin("decoder_joint-model.int8.onnx", 8_998_286, "a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3"),
            pin("nemo128.onnx", 139_764, "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f"),
            pin("vocab.txt", 9_384, "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d"),
        ],
    },
    LegacyModel {
        engine: Engine::Parakeet,
        id: "parakeet-tdt-0.6b-v3-int8",
        repo: "istupakov/parakeet-tdt-0.6b-v3-onnx",
        commit: "8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce",
        files: &[
            pin("encoder-model.int8.onnx", 652_183_999, "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09"),
            pin("decoder_joint-model.int8.onnx", 18_202_004, "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70"),
            pin("nemo128.onnx", 139_764, "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f"),
            pin("vocab.txt", 93_939, "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
        ],
    },
    summary(
        "qwen3.5:2b",
        "unsloth/Qwen3.5-2B-GGUF",
        "f6d5376be1edb4d416d56da11e5397a961aca8ae",
        &[pin("Qwen3.5-2B-Q4_K_M.gguf", 1_280_835_840, "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223")],
    ),
    summary(
        "qwen3.5:4b",
        "unsloth/Qwen3.5-4B-GGUF",
        "e87f176479d0855a907a41277aca2f8ee7a09523",
        &[pin("Qwen3.5-4B-Q4_K_M.gguf", 2_740_937_888, "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4")],
    ),
    summary(
        "gemma3:4b",
        "bartowski/google_gemma-3-4b-it-GGUF",
        "71506238f970075ca85125cd749c28b1b0eee84e",
        &[pin("gemma-3-4b-it-Q4_K_M.gguf", 2_489_758_112, "4996030242583a40aa151ff93f49ed787ac8c25e4120c3ae4588b2e2a7d1ae94")],
    ),
    summary(
        "gemma3:1b",
        "bartowski/google_gemma-3-1b-it-GGUF",
        "116f76234503685a98f572982177b11d44ec8ff1",
        &[pin("gemma-3-1b-it-Q8_0.gguf", 1_069_306_624, "375e12a4a18929a641f9744b060d4a7cf4e279530750555828ec0c117870bc96")],
    ),
];

pub fn legacy_model(engine: Engine, id: &str) -> Option<&'static LegacyModel> {
    LEGACY.iter().find(|model| model.engine == engine && model.id == id)
}

/// The 0.3.0 pins of `entry`, when it still lists the same files.
fn legacy(entry: &Entry) -> Option<Expected> {
    let model = legacy_model(entry.engine, &entry.id)?;
    let files: Option<Vec<&'static Pinned>> =
        entry.files.iter().map(|file| model.files.iter().find(|pinned| pinned.file == file.name)).collect();
    let files = files.filter(|files| files.len() == model.files.len())?;
    Some(Expected {
        commit: model.commit.to_string(),
        git_oids: vec![None; files.len()],
        files,
        source: Source::Legacy,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_catalog::{built_in, testing::entry_for};

    fn every_legacy_pin() -> impl Iterator<Item = &'static Pinned> {
        LEGACY.iter().flat_map(|model| model.files.iter())
    }

    #[test]
    fn every_legacy_pin_is_well_formed_and_every_model_is_in_the_built_in_catalog() {
        for pinned in every_legacy_pin() {
            assert!(is_sha256(pinned.sha256), "{}", pinned.file);
            assert!(pinned.size > 0);
        }
        let catalog = built_in();
        for model in LEGACY {
            let entry = catalog
                .entries
                .iter()
                .find(|entry| entry.engine == model.engine && entry.id == model.id)
                .unwrap_or_else(|| panic!("{} left the built-in catalog", model.id));
            assert_eq!(entry.repo, model.repo, "{}", model.id);
            let expected = legacy(entry).unwrap_or_else(|| panic!("{} lists other files than 0.3.0", model.id));
            assert_eq!(expected.files.len(), model.files.len());
        }
        // Every entry of the built-in catalog was in 0.3.0: nothing is lost.
        assert_eq!(catalog.entries.len(), LEGACY.len());
    }

    #[test]
    fn a_0_3_x_install_is_checked_against_the_0_3_0_pins() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let dir = tempfile::tempdir().unwrap();
        let entry = crate::model_catalog::entry(Engine::Llama, "gemma3:1b").unwrap();
        let file = dir.path().join(&entry.files[0].name);
        let expected = expected(&entry, &record_path_for_file(&file)).unwrap();
        assert_eq!(expected.source, Source::Legacy);
        assert_eq!(expected.commit, "116f76234503685a98f572982177b11d44ec8ff1");
        assert_eq!(expected.files[0].size, 1_069_306_624);
    }

    #[test]
    fn a_complete_record_wins_and_an_incomplete_one_only_resumes() {
        let dir = tempfile::tempdir().unwrap();
        let entry = entry_for(Engine::Whisper, "tiny", "owner/whisper");
        let file = dir.path().join("ggml-tiny.bin");
        let path = record_path_for_file(&file);
        assert_eq!(path.file_name().unwrap(), "ggml-tiny.bin.install.json");
        let mut record = InstallRecord {
            id: "tiny".to_string(),
            repo: "owner/whisper".to_string(),
            commit: "c".repeat(40),
            complete: false,
            files: vec![RecordFile { name: "ggml-tiny.bin".to_string(), size: 5, sha256: "a".repeat(64), git_oid: None }],
        };
        write_record(&path, &record).unwrap();
        // Nothing is installed until the download has finished.
        assert!(expected(&entry, &path).is_none());
        assert_eq!(partial(&entry, &path).unwrap().commit, "c".repeat(40));

        record.complete = true;
        write_record(&path, &record).unwrap();
        let found = expected(&entry, &path).unwrap();
        assert_eq!((found.source, found.files[0].size, found.commit.as_str()), (Source::Record, 5, "c".repeat(40).as_str()));
        assert!(partial(&entry, &path).is_none());

        // A record for other files does not describe this entry.
        record.files[0].name = "ggml-base.bin".to_string();
        write_record(&path, &record).unwrap();
        assert_eq!(expected(&entry, &path).unwrap().source, Source::Legacy);

        std::fs::write(&path, b"{ not json").unwrap();
        assert_eq!(expected(&entry, &path).unwrap().source, Source::Legacy);
        let unknown = entry_for(Engine::Whisper, "brand-new", "owner/whisper");
        assert!(expected(&unknown, &dir.path().join("none.install.json")).is_none());
    }
}
