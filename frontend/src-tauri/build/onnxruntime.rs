use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File},
    io::{Read, Write},
    path::Path,
    process,
};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

enum ArchiveKind {
    Zip,
    TarGz,
}

struct Archive {
    url: &'static str,
    size: u64,
    sha256: &'static str,
    kind: ArchiveKind,
}

struct Artifact {
    /// Index into the runtime's `archives`.
    archive: usize,
    archive_path: &'static str,
    output_name: &'static str,
    size: u64,
    sha256: &'static str,
}

/// The ONNX Runtime the app loads by absolute path (`onnx_runtime.rs`), with
/// every staged file pinned. macOS links the runtime ort downloads instead.
struct Runtime {
    target: &'static str,
    archives: &'static [Archive],
    artifacts: &'static [Artifact],
}

const WINDOWS_X64: Runtime = Runtime {
    target: "x86_64-pc-windows-msvc",
    archives: &[
        Archive {
            url: "https://www.nuget.org/api/v2/package/Microsoft.ML.OnnxRuntime.DirectML/1.24.4",
            size: 12_458_649,
            sha256: "57e9f11b73437bef7a309496135d4c1f96b1a8e9ddba60013fa27bfc1d788681",
            kind: ArchiveKind::Zip,
        },
        Archive {
            url: "https://www.nuget.org/api/v2/package/Microsoft.AI.DirectML/1.15.4",
            size: 202_292_617,
            sha256: "4e7cb7ddce8cf837a7a75dc029209b520ca0101470fcdf275c1f49736a3615b9",
            kind: ArchiveKind::Zip,
        },
    ],
    artifacts: &[
        Artifact {
            archive: 0,
            archive_path: "runtimes/win-x64/native/onnxruntime.dll",
            output_name: "onnxruntime.dll",
            size: 17_328_152,
            sha256: "e7eedec6a6f26dc39dc948276a75ef6d2bee3fff944d874ceed0bbd3b97bff40",
        },
        Artifact {
            archive: 0,
            archive_path: "runtimes/win-x64/native/onnxruntime_providers_shared.dll",
            output_name: "onnxruntime_providers_shared.dll",
            size: 22_040,
            sha256: "265c8daf29637cb259cac8be9f08f2cd45f3883f0f0e4949cbfddd5b4cbec3b6",
        },
        Artifact {
            archive: 0,
            archive_path: "LICENSE",
            output_name: "onnxruntime-LICENSE.txt",
            size: 1_094,
            sha256: "c250d6278f0b47a6439fb7592b08b58a55eb9f535aa49a1db63211c3f982b674",
        },
        Artifact {
            archive: 1,
            archive_path: "bin/x64-win/DirectML.dll",
            output_name: "DirectML.dll",
            size: 18_527_776,
            sha256: "9c9e6d822561c6c41b90e6994b3e8857cf1d66dbfb1e0c4c799c7c89b4e92da1",
        },
        Artifact {
            archive: 1,
            archive_path: "LICENSE.txt",
            output_name: "DirectML-LICENSE.txt",
            size: 10_439,
            sha256: "a05138e3a085ff60a44881eedfa58dccb03ecc1d7b1f6ae888418e8c2fec4b8d",
        },
    ],
};

// Microsoft's CPU build: glibc 2.27 and no AVX2 requirement (ort's own Linux
// binaries need glibc 2.38 and AVX2). The shared-provider library only serves
// GPU execution providers, so it is not staged.
const LINUX_X64: Runtime = Runtime {
    target: "x86_64-unknown-linux-gnu",
    archives: &[Archive {
        url: "https://github.com/microsoft/onnxruntime/releases/download/v1.24.4/onnxruntime-linux-x64-1.24.4.tgz",
        size: 8_155_822,
        sha256: "3a211fbea252c1e66290658f1b735b772056149f28321e71c308942cdb54b747",
        kind: ArchiveKind::TarGz,
    }],
    artifacts: &[
        Artifact {
            archive: 0,
            archive_path: "onnxruntime-linux-x64-1.24.4/lib/libonnxruntime.so.1.24.4",
            output_name: "libonnxruntime.so",
            size: 22_159_232,
            sha256: "d132535d051344ff5c64c9c200004150559049a81ed330eb4422c1962fb6b7e4",
        },
        Artifact {
            archive: 0,
            archive_path: "onnxruntime-linux-x64-1.24.4/LICENSE",
            output_name: "onnxruntime-LICENSE.txt",
            size: 1_073,
            sha256: "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c",
        },
    ],
};

fn runtime_for(target_os: &str) -> Option<&'static Runtime> {
    match target_os {
        "windows" => Some(&WINDOWS_X64),
        "linux" => Some(&LINUX_X64),
        _ => None,
    }
}

pub fn ensure_onnxruntime_runtime() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let Some(runtime) = runtime_for(&target_os) else {
        return;
    };
    println!("cargo:rerun-if-changed=binaries/onnxruntime");

    let target = env::var("TARGET").expect("TARGET environment variable not set");
    if target != runtime.target {
        let pinned = [WINDOWS_X64.target, LINUX_X64.target].join(" and ");
        panic!(
            "No ONNX Runtime is pinned for {target}: build/onnxruntime.rs pins one only for {pinned}. \
             Add a pinned runtime for {target} to build it."
        );
    }

    let manifest_dir =
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR environment variable not set");
    let destination = Path::new(&manifest_dir)
        .join("binaries")
        .join("onnxruntime");

    match verify_staged_runtime(runtime, &destination) {
        Ok(()) => {
            println!(
                "cargo:warning=Using verified bundled ONNX Runtime from {}",
                destination.display()
            );
            stage_development_runtime(runtime, &destination);
            return;
        }
        Err(verification_error) => match fs::symlink_metadata(&destination) {
            Ok(metadata) if is_link_or_reparse_point(&metadata) => {
                panic!(
                    "Refusing to replace linked or reparse-point ONNX Runtime stage at {}: {verification_error}",
                    destination.display()
                );
            }
            Ok(metadata) if metadata.is_dir() => {
                println!(
                    "cargo:warning=Replacing invalid bundled ONNX Runtime: {verification_error}"
                );
                fs::remove_dir_all(&destination).unwrap_or_else(|remove_error| {
                    panic!(
                        "Failed to remove invalid ONNX Runtime directory at {}: {remove_error}",
                        destination.display()
                    )
                });
            }
            Ok(metadata) if metadata.is_file() => {
                println!(
                    "cargo:warning=Replacing invalid bundled ONNX Runtime: {verification_error}"
                );
                fs::remove_file(&destination).unwrap_or_else(|remove_error| {
                    panic!(
                        "Failed to remove invalid ONNX Runtime file at {}: {remove_error}",
                        destination.display()
                    )
                });
            }
            Ok(_) => {
                panic!(
                    "Refusing to replace special ONNX Runtime stage at {}: {verification_error}",
                    destination.display()
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                panic!(
                    "Failed to inspect invalid ONNX Runtime stage at {}: {error}",
                    destination.display()
                );
            }
        },
    }

    fs::create_dir_all(
        destination
            .parent()
            .expect("ONNX Runtime destination has no parent"),
    )
    .expect("Failed to create ONNX Runtime binaries directory");

    let temporary_archive = env::temp_dir().join(format!(
        "meetily-onnxruntime-{}-{}.archive",
        process::id(),
        target
    ));
    let temporary_destination =
        destination.with_file_name(format!(".onnxruntime-{}-{}", process::id(), target));
    let _ = fs::remove_file(&temporary_archive);
    let _ = fs::remove_dir_all(&temporary_destination);

    let result = stage_runtime(runtime, &temporary_archive, &temporary_destination);
    let _ = fs::remove_file(&temporary_archive);

    if let Err(error) = result {
        let _ = fs::remove_dir_all(&temporary_destination);
        panic!("Failed to stage bundled ONNX Runtime: {error}");
    }

    fs::rename(&temporary_destination, &destination).unwrap_or_else(|error| {
        let _ = fs::remove_dir_all(&temporary_destination);
        panic!(
            "Failed to finalize bundled ONNX Runtime at {}: {error}",
            destination.display()
        );
    });

    verify_staged_runtime(runtime, &destination).unwrap_or_else(|error| {
        panic!("Bundled ONNX Runtime verification failed after staging: {error}")
    });
    println!(
        "cargo:warning=Bundled verified ONNX Runtime at {}",
        destination.display()
    );
    stage_development_runtime(runtime, &destination);
}

// Plain cargo builds must be runnable too; Tauri's installer stages resources
// separately. OUT_DIR is <profile>/build/<package>/out, not the executable dir.
fn stage_development_runtime(runtime: &Runtime, source: &Path) {
    let out_dir = std::path::PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let profile = out_dir.ancestors().nth(3).expect("Cargo profile directory");
    let target = profile.join("binaries/onnxruntime");
    if verify_staged_runtime(runtime, &target).is_ok() { return; }
    if fs::symlink_metadata(&target).is_ok_and(|metadata| is_link_or_reparse_point(&metadata)) {
        panic!("Refusing linked development runtime directory");
    }
    fs::create_dir_all(&target).expect("create development runtime directory");
    for artifact in runtime.artifacts {
        let file = target.join(artifact.output_name);
        if fs::symlink_metadata(&file).is_ok_and(|metadata| is_link_or_reparse_point(&metadata)) {
            panic!("Refusing linked development runtime file");
        }
        fs::copy(source.join(artifact.output_name), file).expect("stage development ONNX Runtime");
    }
    verify_staged_runtime(runtime, &target).expect("verify development ONNX Runtime");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_runtime_copy_rejects_short_and_overlong_input() {
        for input in [b"ab".as_slice(), b"abcd".as_slice()] {
            let mut output = Vec::new();
            assert!(copy_exact(&mut std::io::Cursor::new(input), &mut output, 3).is_err());
            assert!(output.len() <= 3);
        }
        let mut output = Vec::new();
        copy_exact(&mut std::io::Cursor::new(b"abc"), &mut output, 3).unwrap();
        assert_eq!(output, b"abc");
    }

    #[test]
    fn staged_runtime_is_exact_and_rejects_extras() {
        let runtime = runtime_for(std::env::consts::OS).unwrap();
        let stage = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/onnxruntime");
        verify_staged_runtime(runtime, &stage).expect("build must stage verified runtime");
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("extra")).unwrap();
        assert!(verify_staged_runtime(runtime, dir.path()).is_err());
    }
}

fn stage_runtime(runtime: &Runtime, archive_path: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;
    for (index, pin) in runtime.archives.iter().enumerate() {
        download_archive(archive_path, pin.url, pin.size)?;
        verify_file(archive_path, pin.url, pin.size, pin.sha256)?;
        let artifacts: Vec<&Artifact> =
            runtime.artifacts.iter().filter(|artifact| artifact.archive == index).collect();
        match pin.kind {
            ArchiveKind::Zip => extract_zip(archive_path, &artifacts, destination)?,
            ArchiveKind::TarGz => extract_tar_gz(archive_path, &artifacts, destination)?,
        }
        for artifact in artifacts {
            verify_file(
                &destination.join(artifact.output_name),
                artifact.output_name,
                artifact.size,
                artifact.sha256,
            )?;
        }
    }

    Ok(())
}

fn extract_zip(archive_path: &Path, artifacts: &[&Artifact], destination: &Path) -> Result<(), String> {
    let archive_file = File::open(archive_path)
        .map_err(|error| format!("failed to open {}: {error}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|error| format!("failed to read ONNX Runtime archive: {error}"))?;
    for artifact in artifacts {
        let mut source = archive.by_name(artifact.archive_path).map_err(|error| {
            format!(
                "missing {} in ONNX Runtime archive: {error}",
                artifact.archive_path
            )
        })?;
        extract_entry(&mut source, artifact, destination)?;
    }
    Ok(())
}

// Only regular entries with a pinned path are written; links and every other
// entry are skipped, so the archive cannot place files outside the stage.
fn extract_tar_gz(archive_path: &Path, artifacts: &[&Artifact], destination: &Path) -> Result<(), String> {
    let archive_file = File::open(archive_path)
        .map_err(|error| format!("failed to open {}: {error}", archive_path.display()))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(archive_file));
    let mut extracted = Vec::new();
    let entries = archive
        .entries()
        .map_err(|error| format!("failed to read ONNX Runtime archive: {error}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("failed to read ONNX Runtime archive: {error}"))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|error| format!("invalid path in ONNX Runtime archive: {error}"))?
            .to_string_lossy()
            .into_owned();
        if let Some(artifact) = artifacts.iter().find(|artifact| artifact.archive_path == path) {
            extract_entry(&mut entry, artifact, destination)?;
            extracted.push(artifact.archive_path);
        }
    }
    if let Some(missing) = artifacts
        .iter()
        .find(|artifact| !extracted.contains(&artifact.archive_path))
    {
        return Err(format!("missing {} in ONNX Runtime archive", missing.archive_path));
    }
    Ok(())
}

fn extract_entry<R: Read>(source: &mut R, artifact: &Artifact, destination: &Path) -> Result<(), String> {
    let output = destination.join(artifact.output_name);
    let mut file = File::create(&output)
        .map_err(|error| format!("failed to create {}: {error}", output.display()))?;
    std::io::copy(source, &mut file)
        .map_err(|error| format!("failed to extract {}: {error}", artifact.archive_path))?;
    Ok(())
}

fn download_archive(destination: &Path, url: &str, size: u64) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|error| format!("failed to create download client: {error}"))?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|error| format!("failed to download ONNX Runtime: {error}"))?
        .error_for_status()
        .map_err(|error| format!("ONNX Runtime download failed: {error}"))?;
    let mut file = File::create(destination)
        .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;
    copy_exact(&mut response, &mut file, size)
}

fn copy_exact<R: Read, W: Write>(
    source: &mut R,
    destination: &mut W,
    expected_size: u64,
) -> Result<(), String> {
    let copied = std::io::copy(
        &mut source.by_ref().take(expected_size),
        destination,
    )
    .map_err(|error| format!("failed to copy ONNX Runtime download: {error}"))?;
    if copied != expected_size {
        return Err(format!(
            "downloaded ONNX Runtime archive has size {copied}, expected {expected_size}"
        ));
    }

    let mut probe = [0_u8; 1];
    if source
        .read(&mut probe)
        .map_err(|error| format!("failed to copy ONNX Runtime download: {error}"))?
        != 0
    {
        return Err(format!(
            "downloaded ONNX Runtime archive exceeds expected size {expected_size}"
        ));
    }

    Ok(())
}

fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }

    #[cfg(windows)]
    {
        return metadata.file_attributes() & 0x0000_0400 != 0;
    }

    #[cfg(not(windows))]
    false
}

fn verify_staged_runtime(runtime: &Runtime, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(destination)
        .map_err(|error| format!("failed to inspect runtime stage: {error}"))?;
    if is_link_or_reparse_point(&metadata) {
        return Err("runtime stage is a link or reparse point".to_string());
    }
    if !metadata.file_type().is_dir() {
        return Err("runtime stage is not a directory".to_string());
    }

    let entries = fs::read_dir(destination)
        .map_err(|error| format!("failed to enumerate runtime stage: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("failed to enumerate runtime stage entry: {error}"))?;
        let entry_metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
            format!(
                "failed to inspect runtime stage entry {}: {error}",
                entry.path().display()
            )
        })?;
        if is_link_or_reparse_point(&entry_metadata) {
            return Err(format!(
                "runtime stage entry {} is a link or reparse point",
                entry.path().display()
            ));
        }
        if !entry_metadata.file_type().is_file() {
            return Err(format!(
                "runtime stage entry {} is not a regular file",
                entry.path().display()
            ));
        }

        let name = entry.file_name();
        if !runtime
            .artifacts
            .iter()
            .any(|artifact| name.as_os_str() == artifact.output_name)
        {
            return Err(format!(
                "runtime stage contains undeclared entry {}",
                entry.path().display()
            ));
        }
    }

    for artifact in runtime.artifacts {
        verify_file(
            &destination.join(artifact.output_name),
            artifact.output_name,
            artifact.size,
            artifact.sha256,
        )?;
    }
    Ok(())
}

fn verify_file(
    path: &Path,
    name: &str,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("failed to inspect {name}: {error}"))?;
    if metadata.len() != expected_size {
        return Err(format!(
            "{name} has size {}, expected {expected_size}",
            metadata.len()
        ));
    }

    let mut file = File::open(path).map_err(|error| format!("failed to open {name}: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to hash {name}: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    let actual_sha256 = format!("{:x}", hasher.finalize());
    if actual_sha256 != expected_sha256 {
        return Err(format!(
            "{name} has SHA-256 {actual_sha256}, expected {expected_sha256}"
        ));
    }

    Ok(())
}
