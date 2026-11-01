//! The OpenVINO GenAI runtime the Windows app loads by absolute path from
//! `binaries/openvino/` (`whisper_engine/openvino/genai.rs`), to run Whisper on
//! Intel GPUs (#79). This table is the one place that says where the runtime
//! comes from: the archive, and every staged file with its size and SHA-256.
//!
//! Source: Intel's official GenAI 2026.4.1 Windows archive. Its readme puts
//! `runtime/bin/*` under the Intel OpenVINO Distribution License (the staged
//! `openvino-EULA.txt`), which allows redistributing the files `redist.txt`
//! lists; the sources are Apache-2.0. Whether Protocol ships these binaries or
//! builds the C API library from the Apache sources is the owner's decision
//! (#79); until then this stage is for development and measurement.
//!
//! The 11 libraries are what `WhisperPipeline` loads on the GPU: the GenAI C
//! API and GenAI, the OpenVINO C API and core, the GPU plugin, the CPU plugin
//! (GenAI compiles the tokenizer and detokenizer models on the CPU), the IR
//! reader, the tokenizer operations and oneTBB. The NPU plugin and compiler
//! (108 MB), the other frontends and the auto-batch plugin are left out; a
//! pipeline on the GPU never loads them.

use super::{Archive, ArchiveKind, Artifact, Runtime};

macro_rules! pinned {
    ($path:literal, $output:literal, $size:literal, $sha256:literal) => {
        Artifact {
            archive: 0,
            archive_path: concat!("openvino_genai_windows_2026.4.1.0_x86_64/", $path),
            output_name: $output,
            size: $size,
            sha256: $sha256,
        }
    };
}

pub const WINDOWS_X64: Runtime = Runtime {
    name: "OpenVINO GenAI runtime",
    folder: "openvino",
    target: "x86_64-pc-windows-msvc",
    archives: &[Archive {
        url: "https://storage.openvinotoolkit.org/repositories/openvino_genai/packages/2026.4.1/windows/openvino_genai_windows_2026.4.1.0_x86_64.zip",
        size: 254_143_615,
        sha256: "437dc85e0fa60d2231b28f323c9b06ee27bc5eb4d3285fb266f9dd5fb012d0b8",
        kind: ArchiveKind::Zip,
    }],
    artifacts: &[
        pinned!("runtime/bin/intel64/Release/openvino_genai_c.dll", "openvino_genai_c.dll", 178_448,
              "da1a4b545770cf93ae939882fcd70f9f0d436abc49d84b2301b7893cc99283b1"),
        pinned!("runtime/bin/intel64/Release/openvino_genai.dll", "openvino_genai.dll", 7_428_880,
              "be4c3f89eacb51146151932b4055939d1139ed6e8bdfe423bf9f195b143f2590"),
        pinned!("runtime/bin/intel64/Release/openvino_c.dll", "openvino_c.dll", 234_256,
              "170fd507b32660c9904f8d3976b97f2c2c1296b4bc83d5a0f3326b87e782f5e7"),
        pinned!("runtime/bin/intel64/Release/openvino.dll", "openvino.dll", 16_485_640,
              "a4ea3aa9dc4dc5136aa9d2abd94edafa67d7e0798829a0b93e5f289b9ee36892"),
        pinned!("runtime/bin/intel64/Release/openvino_intel_gpu_plugin.dll", "openvino_intel_gpu_plugin.dll", 34_673_424,
              "9fd5d05a766978c968e6fa4bc7158f57a887ccede3a1364694d574baa2768c90"),
        pinned!("runtime/bin/intel64/Release/openvino_intel_cpu_plugin.dll", "openvino_intel_cpu_plugin.dll", 46_305_552,
              "453a921db1883a34e1384cddf21b404c87fdd5e224866e43bb5ca0124e7ed02d"),
        pinned!("runtime/bin/intel64/Release/openvino_ir_frontend.dll", "openvino_ir_frontend.dll", 508_680,
              "19f07106364f28f1246704ca9cfed8b1b071cff82734ae01457837b1f4c5eba9"),
        pinned!("runtime/bin/intel64/Release/openvino_tokenizers.dll", "openvino_tokenizers.dll", 3_490_568,
              "0e7274e2488d68dfaa9c3a3deea0c77131245927f66f848528680f8581c260fb"),
        pinned!("runtime/3rdparty/tbb/bin/tbb12.dll", "tbb12.dll", 337_160,
              "d7603904d45426c05db2d5cb5541aaa861ad36dc481c7fbf3befd11acd596343"),
        pinned!("runtime/3rdparty/tbb/bin/tbbmalloc.dll", "tbbmalloc.dll", 119_056,
              "ef627edf5b1c19ead180f8fdf027b5800c4ffdfbfcc00d67c7e66df7d62b4f92"),
        pinned!("runtime/3rdparty/tbb/bin/tbbbind_2_5.dll", "tbbbind_2_5.dll", 209_168,
              "9a54a33b5c33866c3846e7b8939609dd08449f9037cff568d92dae88baad01dc"),
        pinned!("docs/licensing/EULA.txt", "openvino-EULA.txt", 7_741,
              "2ef6a5d67fc91a095fe753745c02be03e91847816add25bf82a02752aa1be151"),
        pinned!("docs/licensing/redist.txt", "openvino-redist.txt", 1_808,
              "ee34242c138f42d2d24399c72212fb88be4dd46bee9f5845380acb6c19355d1d"),
        pinned!("docs/licensing/LICENSE", "openvino-LICENSE.txt", 11_357,
              "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"),
        pinned!("docs/licensing/runtime-third-party-programs.txt", "openvino-third-party-programs.txt", 118_919,
              "21ccba6916a7f99278d7b111ce2ce448377750362341f638e24fc336aaf85806"),
        pinned!("docs/licensing/onednn_third-party-programs.txt", "onednn-third-party-programs.txt", 28_475,
              "f1b16991dfe8488f3f5f07cccba575c31c91175a9f2c8d9e1569665f86e0b2f6"),
        pinned!("docs/licensing/onetbb_third-party-programs.txt", "onetbb-third-party-programs.txt", 46_979,
              "b10997cc50652ba6ab365e3bc43e13057681cd4a56533b46171529bd249749f3"),
        pinned!("docs/licensing/third-party-programs-genai.txt", "openvino-genai-third-party-programs.txt", 20_742,
              "d9b815b6614fe936d53656b5e7a859ed38cf88646732ea739c121d82c074c4aa"),
        pinned!("runtime/3rdparty/tbb/TBB-LICENSE", "TBB-LICENSE.txt", 11_558,
              "1eb85fc97224598dad1852b5d6483bbcf0aa8608790dcc657a5a2a761ae9c8c6"),
    ],
};

/// Stages the runtime for a Windows x64 build; other targets keep whisper.cpp
/// only and stage nothing.
pub fn ensure_openvino_runtime() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if target == WINDOWS_X64.target {
        super::ensure_runtime(&WINDOWS_X64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARCHIVE_ROOT: &str = "openvino_genai_windows_2026.4.1.0_x86_64";

    #[test]
    fn every_file_comes_from_the_pinned_archive_root() {
        for artifact in WINDOWS_X64.artifacts {
            assert!(artifact.archive_path.starts_with(ARCHIVE_ROOT), "{}", artifact.archive_path);
            assert_eq!(artifact.sha256.len(), 64, "{}", artifact.output_name);
        }
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn the_build_staged_the_pinned_runtime() {
        let stage = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/openvino");
        super::super::verify_staged_runtime(&WINDOWS_X64, &stage).expect("build must stage the pinned OpenVINO runtime");
    }
}
