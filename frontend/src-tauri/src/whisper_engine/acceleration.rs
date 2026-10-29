use crate::audio::{GpuType, PerformanceTier};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhisperCompiledBackend {
    Metal,
    Cuda,
    Vulkan,
    HipBlas,
    Cpu,
}

impl WhisperCompiledBackend {
    pub fn current() -> Self {
        if cfg!(feature = "cuda") {
            Self::Cuda
        } else if cfg!(feature = "vulkan") {
            Self::Vulkan
        } else if cfg!(feature = "hipblas") {
            Self::HipBlas
        } else if cfg!(target_os = "macos") || cfg!(feature = "metal") {
            Self::Metal
        } else {
            Self::Cpu
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Metal => "Metal",
            Self::Cuda => "CUDA",
            Self::Vulkan => "Vulkan",
            Self::HipBlas => "HIP BLAS",
            Self::Cpu => "CPU",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WhisperContextAcceleration {
    pub compiled_backend: WhisperCompiledBackend,
    pub runtime_detected_gpu: GpuType,
    pub use_gpu: bool,
    pub flash_attn: bool,
    pub gpu_device: i32,
}

impl WhisperContextAcceleration {
    pub fn status_label(self) -> &'static str {
        match (self.compiled_backend, self.flash_attn) {
            (WhisperCompiledBackend::Metal, true) => "Metal GPU with Flash Attention (Ultra-Fast)",
            (WhisperCompiledBackend::Metal, false) => "Metal GPU acceleration",
            (WhisperCompiledBackend::Cuda, true) => "CUDA GPU with Flash Attention (Ultra-Fast)",
            (WhisperCompiledBackend::Cuda, false) => "CUDA GPU acceleration",
            (WhisperCompiledBackend::Vulkan, _) => "Vulkan GPU acceleration",
            (WhisperCompiledBackend::HipBlas, _) => "HIP BLAS GPU acceleration",
            (WhisperCompiledBackend::Cpu, _) => "CPU processing only",
        }
    }
}

pub fn whisper_context_acceleration_for(
    compiled_backend: WhisperCompiledBackend,
    runtime_detected_gpu: GpuType,
    performance_tier: PerformanceTier,
) -> WhisperContextAcceleration {
    let use_gpu = !matches!(compiled_backend, WhisperCompiledBackend::Cpu);
    let fast_tier = matches!(performance_tier, PerformanceTier::High | PerformanceTier::Ultra);
    let flash_attn = match compiled_backend {
        WhisperCompiledBackend::Metal | WhisperCompiledBackend::Cuda => fast_tier,
        WhisperCompiledBackend::Vulkan | WhisperCompiledBackend::HipBlas | WhisperCompiledBackend::Cpu => false,
    };

    WhisperContextAcceleration {
        compiled_backend,
        runtime_detected_gpu,
        use_gpu,
        flash_attn: use_gpu && flash_attn,
        gpu_device: 0,
    }
}

/// What ggml reports a registered backend device to be. whisper.cpp's `gpu_device` counts
/// only the `Gpu` and `IntegratedGpu` devices, in registry order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GgmlDeviceKind {
    Gpu,
    IntegratedGpu,
    Other,
}

/// The `gpu_device` that keeps whisper.cpp 1.7.1's Vulkan choice: the first discrete GPU.
///
/// 1.7.1's Vulkan backend registered only discrete GPUs (device 0 when there was none), so
/// device 0 was the first dGPU. Since 1.8 it registers integrated GPUs too, in Vulkan
/// enumeration order, and whisper.cpp takes the first GPU or iGPU; Windows often lists a
/// hybrid laptop's iGPU first. The installer's Vulkan probe validates the 1.7.1 choice.
/// Without a discrete GPU this is 0, the device 1.8 picks.
pub fn first_discrete_gpu_device(kinds: &[GgmlDeviceKind]) -> i32 {
    kinds
        .iter()
        .filter(|kind| **kind != GgmlDeviceKind::Other)
        .position(|kind| *kind == GgmlDeviceKind::Gpu)
        .unwrap_or(0) as i32
}

/// The `gpu_device` for a context of `compiled_backend`. A Vulkan build reads ggml's device
/// registry, which also initializes the Vulkan instance whisper.cpp then reuses.
pub fn whisper_gpu_device(compiled_backend: WhisperCompiledBackend) -> i32 {
    match compiled_backend {
        #[cfg(feature = "vulkan")]
        WhisperCompiledBackend::Vulkan => first_discrete_gpu_device(&ggml_device_kinds()),
        _ => 0,
    }
}

#[cfg(feature = "vulkan")]
fn ggml_device_kinds() -> Vec<GgmlDeviceKind> {
    use whisper_rs::whisper_rs_sys as sys;
    // SAFETY: these registry calls take no pointers except the device handles the registry
    // itself returns, for indices below the count it reports.
    unsafe {
        (0..sys::ggml_backend_dev_count())
            .map(|index| match sys::ggml_backend_dev_type(sys::ggml_backend_dev_get(index)) {
                sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_GPU => GgmlDeviceKind::Gpu,
                sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_IGPU => GgmlDeviceKind::IntegratedGpu,
                _ => GgmlDeviceKind::Other,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acceleration_vulkan_backend_ignores_runtime_cuda_flash_attention() {
        let params = whisper_context_acceleration_for(
            WhisperCompiledBackend::Vulkan,
            GpuType::Cuda,
            PerformanceTier::High,
        );

        assert_eq!(params.compiled_backend, WhisperCompiledBackend::Vulkan);
        assert_eq!(params.runtime_detected_gpu, GpuType::Cuda);
        assert!(params.use_gpu);
        assert!(!params.flash_attn);
    }

    #[test]
    fn acceleration_vulkan_backend_keeps_gpu_without_runtime_gpu_detection() {
        let params = whisper_context_acceleration_for(
            WhisperCompiledBackend::Vulkan,
            GpuType::None,
            PerformanceTier::Low,
        );

        assert!(params.use_gpu);
        assert!(!params.flash_attn);
    }

    #[test]
    fn acceleration_cuda_backend_enables_flash_attention_for_fast_tiers() {
        let high = whisper_context_acceleration_for(
            WhisperCompiledBackend::Cuda,
            GpuType::Cuda,
            PerformanceTier::High,
        );
        let ultra = whisper_context_acceleration_for(
            WhisperCompiledBackend::Cuda,
            GpuType::Cuda,
            PerformanceTier::Ultra,
        );

        assert!(high.use_gpu);
        assert!(high.flash_attn);
        assert!(ultra.use_gpu);
        assert!(ultra.flash_attn);
    }

    #[test]
    fn gpu_device_is_the_first_discrete_gpu_among_whisper_devices() {
        use GgmlDeviceKind::{Gpu, IntegratedGpu, Other};

        // CPU and other devices sit in the registry but are not counted by gpu_device.
        assert_eq!(first_discrete_gpu_device(&[Other, IntegratedGpu, Gpu]), 1);
        assert_eq!(first_discrete_gpu_device(&[Gpu, IntegratedGpu, Other]), 0);
        assert_eq!(first_discrete_gpu_device(&[IntegratedGpu, Other, IntegratedGpu, Gpu, Gpu]), 2);
        assert_eq!(first_discrete_gpu_device(&[Other, IntegratedGpu]), 0);
        assert_eq!(first_discrete_gpu_device(&[Other]), 0);
        assert_eq!(first_discrete_gpu_device(&[]), 0);
    }

    #[test]
    fn acceleration_cpu_backend_disables_gpu_and_flash_attention() {
        for runtime_gpu in [GpuType::None, GpuType::Cuda, GpuType::Vulkan] {
            let params = whisper_context_acceleration_for(
                WhisperCompiledBackend::Cpu,
                runtime_gpu,
                PerformanceTier::Ultra,
            );

            assert!(!params.use_gpu);
            assert!(!params.flash_attn);
        }
    }
}
