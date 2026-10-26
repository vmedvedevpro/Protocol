// ============================================================================
// FFmpeg Binary Bundling
// ============================================================================
// Download and bundle FFmpeg binaries at build-time to eliminate runtime download delays.
// Every archive and the binary inside it are pinned by size and SHA-256, like the
// ONNX Runtime in onnxruntime.rs: releases ship whatever this step stages.

use sha2::{Digest, Sha256};
use std::io::Read;

const RELEASE_BASE: &str =
    "https://github.com/Zackriya-Solutions/ffmpeg-binaries/releases/download/0.0.1";

/// One pinned download: the archive and the ffmpeg executable extracted from it.
struct FfmpegPin {
    archive: &'static str,
    archive_size: u64,
    archive_sha256: &'static str,
    binary_size: u64,
    binary_sha256: &'static str,
}

const WINDOWS_X64: FfmpegPin = FfmpegPin {
    archive: "ffmpeg-8.0.1-essentials_build.zip",
    archive_size: 106_259_850,
    archive_sha256: "e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673",
    binary_size: 99_264_000,
    binary_sha256: "5af82a0d4fe2b9eae211b967332ea97edfc51c6b328ca35b827e73eac560dc0d",
};
const MACOS_ARM64: FfmpegPin = FfmpegPin {
    archive: "ffmpeg80arm.zip",
    archive_size: 22_400_365,
    archive_sha256: "0d4efcaf6a098430a708e0af694a84792938921fa126162787ae98c6151d7a95",
    binary_size: 51_551_944,
    binary_sha256: "77d2c853f431318d55ec02676d9b2f185ebfdddb9f7677a251fbe453affe025a",
};
const MACOS_X64: FfmpegPin = FfmpegPin {
    archive: "ffmpeg-8.0.1.zip",
    archive_size: 25_809_598,
    archive_sha256: "470e482f6e290eac92984ac12b2d67bad425b1e5269fd75fb6a3536c16e824e4",
    binary_size: 80_083_328,
    binary_sha256: "430d60fbf419dab28daee9b679e7929a31ee9bae53f6e42e8ae26b725584290f",
};
const LINUX_ARM64: FfmpegPin = FfmpegPin {
    archive: "ffmpeg-release-arm64-static.tar.xz",
    archive_size: 19_337_412,
    archive_sha256: "f4149bb2b0784e30e99bdda85471c9b5930d3402014e934a5098b41d0f7201b1",
    binary_size: 51_134_160,
    binary_sha256: "6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce",
};
const LINUX_X64: FfmpegPin = FfmpegPin {
    archive: "ffmpeg-release-amd64-static.tar.xz",
    archive_size: 41_888_096,
    archive_sha256: "abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67",
    binary_size: 79_826_272,
    binary_sha256: "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99",
};

/// Download and bundle FFmpeg binary for current target platform
/// Checks cache first, downloads only if missing or corrupted
pub fn ensure_ffmpeg_binary() {
    let target = std::env::var("TARGET")
        .or_else(|_| std::env::var("HOST"))
        .expect("Neither TARGET nor HOST environment variable set");

    println!("cargo:warning=🎬 Checking FFmpeg binary for target: {}", target);

    let binary_name = if target.contains("windows") {
        format!("ffmpeg-{}.exe", target)
    } else {
        format!("ffmpeg-{}", target)
    };

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR environment variable not set");
    let binaries_dir = std::path::PathBuf::from(&manifest_dir).join("binaries");
    let binary_path = binaries_dir.join(&binary_name);

    let pin = ffmpeg_pin_for_target(&target).unwrap_or_else(|error| panic!("⚠️  {}", error));

    // Cache check: keep the staged binary only if it is exactly the pinned one
    if binary_path.exists() {
        println!("cargo:warning=🔍 Found cached FFmpeg binary: {}", binary_name);
        match verify_file(&binary_path, &binary_name, pin.binary_size, pin.binary_sha256) {
            Ok(()) => {
                println!("cargo:warning=✅ FFmpeg binary already cached and verified: {}", binary_name);
                return;
            }
            Err(error) => {
                println!("cargo:warning=⚠️  Cached FFmpeg binary is not the pinned build ({}), re-downloading...", error);
                let _ = std::fs::remove_file(&binary_path);
            }
        }
    }

    println!("cargo:warning=📥 FFmpeg binary not found, downloading for {}", target);

    // Create binaries directory if it doesn't exist
    if !binaries_dir.exists() {
        std::fs::create_dir_all(&binaries_dir)
            .expect("Failed to create binaries directory");
    }

    // Download and extract
    match download_and_extract_ffmpeg(&target, pin, &binary_path) {
        Ok(()) => {
            println!("cargo:warning=✅ FFmpeg binary downloaded successfully: {}", binary_name);

            // Verify downloaded binary works
            if !verify_ffmpeg_binary(&binary_path) {
                panic!("⚠️  Downloaded FFmpeg binary verification failed!");
            }
        }
        Err(e) => {
            panic!("⚠️  Failed to download FFmpeg: {}", e);
        }
    }
}

/// Download the pinned archive, verify it, and extract the verified binary
fn download_and_extract_ffmpeg(
    target: &str,
    pin: &FfmpegPin,
    output_path: &std::path::PathBuf,
) -> Result<(), String> {
    let url = format!("{}/{}", RELEASE_BASE, pin.archive);

    println!("cargo:warning=⬇️  Downloading from: {}", url);

    // Download with timeout (using reqwest from build-dependencies)
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600)) // 10 min timeout for large downloads
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut response = client
        .get(&url)
        .send()
        .map_err(|e| format!("Failed to download: {}", e))?
        .error_for_status()
        .map_err(|e| format!("HTTP error: {}", e))?;

    println!("cargo:warning=📦 Download size: {:.1} MB", pin.archive_size as f64 / 1_048_576.0);

    // Download to a temp file. The archive and the extraction folder carry the
    // process id, so concurrent builds (two worktrees) never share either.
    let archive_path = std::env::temp_dir().join(format!(
        "ffmpeg-build-{}-{}-{}",
        std::process::id(),
        target,
        pin.archive
    ));

    let result = (|| {
        {
            let mut file = std::fs::File::create(&archive_path)
                .map_err(|e| format!("Failed to create temp file: {}", e))?;
            copy_exact(&mut response, &mut file, pin.archive_size)?;
        }
        verify_file(&archive_path, pin.archive, pin.archive_size, pin.archive_sha256)?;

        println!("cargo:warning=📦 Downloaded to: {:?}", archive_path);
        println!("cargo:warning=📂 Extracting FFmpeg binary...");

        // Extract binary (platform-specific)
        extract_ffmpeg_from_archive(&archive_path, target, pin, output_path)
    })();

    // Cleanup archive
    let _ = std::fs::remove_file(&archive_path);
    result?;

    println!("cargo:warning=✨ Extraction complete");

    Ok(())
}

/// The pinned FFmpeg download for a target triple
fn ffmpeg_pin_for_target(target: &str) -> Result<&'static FfmpegPin, String> {
    if target.contains("windows") {
        Ok(&WINDOWS_X64)
    } else if target.contains("apple") {
        if target.contains("aarch64") {
            // Apple Silicon (M1/M2/M3)
            Ok(&MACOS_ARM64)
        } else {
            Ok(&MACOS_X64)
        }
    } else if target.contains("linux") {
        if target.contains("aarch64") || target.contains("arm") {
            Ok(&LINUX_ARM64)
        } else {
            Ok(&LINUX_X64)
        }
    } else {
        Err(format!("Unsupported target platform: {}", target))
    }
}

/// Copy exactly `expected_size` bytes; a short or a longer download is an error
fn copy_exact<R: Read, W: std::io::Write>(
    source: &mut R,
    destination: &mut W,
    expected_size: u64,
) -> Result<(), String> {
    let copied = std::io::copy(&mut source.by_ref().take(expected_size), destination)
        .map_err(|e| format!("Failed to write archive: {}", e))?;
    if copied != expected_size {
        return Err(format!("FFmpeg download has size {}, expected {}", copied, expected_size));
    }
    let mut probe = [0_u8; 1];
    if source
        .read(&mut probe)
        .map_err(|e| format!("Failed to read response: {}", e))?
        != 0
    {
        return Err(format!("FFmpeg download exceeds expected size {}", expected_size));
    }
    Ok(())
}

/// Check a file against its pinned size and SHA-256
fn verify_file(
    path: &std::path::Path,
    name: &str,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), String> {
    let size = std::fs::metadata(path)
        .map_err(|e| format!("failed to inspect {}: {}", name, e))?
        .len();
    if size != expected_size {
        return Err(format!("{} has size {}, expected {}", name, size, expected_size));
    }
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("failed to open {}: {}", name, e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("failed to hash {}: {}", name, e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected_sha256 {
        return Err(format!("{} has SHA-256 {}, expected {}", name, actual, expected_sha256));
    }
    Ok(())
}

/// Extract FFmpeg binary from downloaded archive (handles ZIP and TAR.XZ)
fn extract_ffmpeg_from_archive(
    archive_path: &std::path::Path,
    target: &str,
    pin: &FfmpegPin,
    output_path: &std::path::PathBuf,
) -> Result<(), String> {
    let extract_dir = std::env::temp_dir().join(format!(
        "ffmpeg-extract-{}-{}",
        std::process::id(),
        target
    ));

    // A leftover of an earlier build that had the same process id
    let _ = std::fs::remove_dir_all(&extract_dir);
    std::fs::create_dir_all(&extract_dir)
        .map_err(|e| format!("Failed to create extract dir: {}", e))?;

    let result = (|| {
        // Determine archive format from extension
        let archive_str = archive_path.to_string_lossy();

        if archive_str.ends_with(".zip") {
            extract_zip(archive_path, &extract_dir)?;
        } else if archive_str.ends_with(".tar.xz") || archive_str.ends_with(".txz") {
            extract_tar_xz(archive_path, &extract_dir)?;
        } else {
            return Err(format!("Unsupported archive format: {}", archive_str));
        }

        // Find extracted FFmpeg binary (platform-specific locations)
        let ffmpeg_binary = find_ffmpeg_in_extracted_dir(&extract_dir, target)?;

        println!("cargo:warning=📋 Found FFmpeg at: {:?}", ffmpeg_binary);
        verify_file(&ffmpeg_binary, "extracted ffmpeg", pin.binary_size, pin.binary_sha256)?;

        // Copy to target location
        std::fs::copy(&ffmpeg_binary, output_path)
            .map_err(|e| format!("Failed to copy binary to binaries/: {}", e))?;

        // Set executable permissions on Unix systems
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(output_path)
                .map_err(|e| format!("Failed to get metadata: {}", e))?
                .permissions();
            perms.set_mode(0o755); // rwxr-xr-x
            std::fs::set_permissions(output_path, perms)
                .map_err(|e| format!("Failed to set executable permissions: {}", e))?;
            println!("cargo:warning=🔐 Set executable permissions");
        }

        Ok(())
    })();

    // Cleanup extraction directory, also after a failed extraction or check
    let _ = std::fs::remove_dir_all(&extract_dir);
    result
}

/// Extract ZIP archive (Windows, macOS)
fn extract_zip(
    archive_path: &std::path::Path,
    extract_dir: &std::path::Path,
) -> Result<(), String> {

    let file = std::fs::File::open(archive_path)
        .map_err(|e| format!("Failed to open ZIP: {}", e))?;

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read ZIP archive: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| format!("Failed to read ZIP entry {}: {}", i, e))?;

        // Use enclosed_name() to prevent Zip Slip path traversal attacks
        let outpath = match file.enclosed_name() {
            Some(name) => extract_dir.join(name),
            None => {
                // Skip entries with path traversal sequences (e.g., "../")
                println!("cargo:warning=⚠️  Skipping suspicious ZIP entry: {}", file.name());
                continue;
            }
        };

        if file.is_dir() {
            // Directory
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        } else {
            // File
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent directory: {}", e))?;
            }

            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("Failed to create output file: {}", e))?;

            std::io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("Failed to extract file: {}", e))?;
        }

        // Set Unix permissions if available
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = file.unix_mode() {
                std::fs::set_permissions(&outpath, std::fs::Permissions::from_mode(mode))
                    .ok();
            }
        }
    }

    Ok(())
}

/// Extract TAR.XZ archive (Linux)
fn extract_tar_xz(
    archive_path: &std::path::Path,
    extract_dir: &std::path::Path,
) -> Result<(), String> {
    let file = std::fs::File::open(archive_path)
        .map_err(|e| format!("Failed to open TAR.XZ: {}", e))?;

    // Decompress XZ
    let decompressor = xz2::read::XzDecoder::new(file);

    // Extract TAR
    let mut archive = tar::Archive::new(decompressor);
    archive.unpack(extract_dir)
        .map_err(|e| format!("Failed to extract TAR: {}", e))?;

    Ok(())
}

/// Find FFmpeg binary in extracted directory (handles nested structures)
fn find_ffmpeg_in_extracted_dir(
    extract_dir: &std::path::Path,
    target: &str,
) -> Result<std::path::PathBuf, String> {
    let executable_name = if target.contains("windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };

    // Search patterns (in priority order)
    let search_patterns = [
        extract_dir.join(executable_name),                    // Flat: ffmpeg
        extract_dir.join("bin").join(executable_name),        // Nested: bin/ffmpeg
    ];

    // Try direct paths first
    for pattern in &search_patterns {
        if pattern.exists() && pattern.is_file() {
            return Ok(pattern.clone());
        }
    }

    // Recursive search for nested directories (e.g., ffmpeg-6.0-full_build/bin/ffmpeg.exe)
    for entry in std::fs::read_dir(extract_dir)
        .map_err(|e| format!("Failed to read extract dir: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();

        if path.is_dir() {
            // Check bin/ subdirectory
            let bin_path = path.join("bin").join(executable_name);
            if bin_path.exists() && bin_path.is_file() {
                return Ok(bin_path);
            }

            // Check root of subdirectory
            let root_path = path.join(executable_name);
            if root_path.exists() && root_path.is_file() {
                return Ok(root_path);
            }
        }
    }

    Err(format!("FFmpeg binary '{}' not found in extracted archive", executable_name))
}

/// Verify FFmpeg binary is functional (runs -version successfully)
fn verify_ffmpeg_binary(path: &std::path::PathBuf) -> bool {
    match std::process::Command::new(path)
        .arg("-version")
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(version_line) = stdout.lines().next() {
                    println!("cargo:warning=✅ FFmpeg verification passed: {}", version_line);
                }
                true
            } else {
                false
            }
        }
        Err(_) => false,
    }
}
