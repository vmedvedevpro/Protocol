//! Whisper on the GPU through Vulkan in the Linux app (#176): how the one
//! Linux executable reaches the system's Vulkan loader, and the crash guard
//! around ggml-vulkan's first use of the driver.
//!
//! Windows ships a CPU and a Vulkan executable, and its installer probes the
//! GPU before choosing one (`/BACKEND=cpu` keeps the CPU one). Linux has one
//! executable built with `--features vulkan`, so the choice happens here, at
//! run time.
//!
//! **The loader.** ggml-vulkan calls three Vulkan functions by symbol
//! (`vkGetInstanceProcAddr`, `vkGetPhysicalDeviceFeatures2`,
//! `vkCmdCopyBuffer`) and every other through the pointers
//! `vkGetInstanceProcAddr` returns (vulkan.hpp's dynamic dispatcher). The
//! executable defines those three itself ([`export_vulkan_symbols`] in
//! `main.rs`) and forwards them to the system loader, so the
//! linker, which links with `--as-needed`, records no `libvulkan.so.1`: the app
//! starts on a system without a Vulkan loader, and linuxdeploy, which follows
//! the executable's `DT_NEEDED` entries, puts none into the AppImage, which
//! therefore uses the system's loader and drivers. The forwarder opens
//! `libvulkan.so.1` on its first call. Without a loader, or while the guard
//! keeps the GPU off, it hands ggml a `vkEnumerateInstanceVersion` that fails:
//! ggml-vulkan's registration catches the `vk::SystemError` and registers no
//! Vulkan backend, so whisper.cpp finds no GPU, runs on the CPU, and no driver
//! code runs in the process. The lib's test binary, which does not link
//! `main.rs`, defines the same symbols, so the measurement kit and the tests
//! take the same path.
//!
//! **The device.** ggml-vulkan registers the discrete and integrated GPUs and
//! drops devices of type CPU (llvmpipe and other software rasterizers); with
//! only those it registers none (`ggml_vk_instance_init`). Without a GPU,
//! `context_parameters` turns `use_gpu` off and Settings says "processor".
//! `GGML_VK_VISIBLE_DEVICES=` (empty) keeps every device away from ggml, the
//! way to stay on the processor with a driver that works but misbehaves.
//!
//! **The guard**, the pattern of `parakeet_engine::npu::guard` with a marker of
//! its own: a broken driver crashes inside these calls, where no `Result`
//! reaches the app. The steps are the device enumeration (the first Vulkan
//! instance, which loads the drivers), a model's GPU context, and the first
//! inference of each model loaded on the GPU, which compiles ggml's shaders
//! (ggml compiles a pipeline the first time a graph needs it, per operation
//! and weight type, so a model of another quantization compiles new ones).
//! Later inferences of a model run unguarded. A marker found at
//! start was left by a process that died in one of them: the GPU then stays
//! off, Whisper runs on the processor and Settings says why, until the person
//! retries ([`retry`]), which takes effect at the next start, since ggml reads
//! its devices once per process.
// The guard runs only in the Linux Vulkan build; elsewhere the wrappers below
// pass their work through.
#![cfg_attr(not(all(target_os = "linux", feature = "vulkan")), allow(dead_code))]

use std::path::PathBuf;
use std::sync::Mutex;

/// Native Vulkan work that can take the process down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The first Vulkan instance and its device list (`ggml_backend_dev_count`).
    Devices,
    /// A whisper.cpp context on the GPU: the device, its buffers, the weights.
    Load,
    /// A GPU model's first inference, which compiles the shaders it needs.
    FirstRun,
}

impl Step {
    fn describe(self) -> &'static str {
        match self {
            Step::Devices => "looking for the graphics card",
            Step::Load => "loading Whisper onto the graphics card",
            Step::FirstRun => "running Whisper on the graphics card for the first time",
        }
    }
}

struct Guard {
    marker: Option<PathBuf>,
    checked: bool,
    stopped: Option<String>,
    /// One entry per step running now, in the order they started.
    running: Vec<Step>,
    closing: bool,
}

impl Guard {
    const fn new(marker: Option<PathBuf>) -> Mutex<Guard> {
        Mutex::new(Guard { marker, checked: false, stopped: None, running: Vec::new(), closing: false })
    }

    /// Beside the other guards' markers.
    fn marker(&self) -> PathBuf {
        self.marker
            .clone()
            .unwrap_or_else(|| crate::paths::install_data_root().join("runtimes").join("whisper-vulkan.attempt"))
    }

    /// Reads the marker once per process, before this process writes one.
    fn check(&mut self) {
        if self.checked {
            return;
        }
        self.checked = true;
        if let Ok(marker) = std::fs::read_to_string(self.marker()) {
            let steps: Vec<&str> = marker.lines().map(str::trim).filter(|step| !step.is_empty()).collect();
            let steps = if steps.is_empty() { "running".to_string() } else { steps.join(" and ") };
            let message = format!("Protocol closed unexpectedly the last time it was {steps}, so Whisper runs on the processor.");
            log::error!("[vulkan] {message}");
            self.stopped = Some(message);
        }
    }

    /// Writes the steps running now into the marker, one per line, or
    /// removes it when none runs or the process is closing.
    fn record(&self) {
        let marker = self.marker();
        if self.running.is_empty() || self.closing {
            let _ = std::fs::remove_file(&marker);
            return;
        }
        let mut steps: Vec<&str> = Vec::new();
        for step in &self.running {
            if !steps.contains(&step.describe()) {
                steps.push(step.describe());
            }
        }
        let written = marker.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(&marker, steps.join("\n")));
        if let Err(error) = written {
            log::warn!("[vulkan] cannot write the crash marker {}: {error}", marker.display());
        }
    }
}

static GUARD: Mutex<Guard> = Guard::new(None);

fn lock(guard: &Mutex<Guard>) -> std::sync::MutexGuard<'_, Guard> {
    guard.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn stopped_in(guard: &Mutex<Guard>) -> Option<String> {
    let mut guard = lock(guard);
    guard.check();
    guard.stopped.clone()
}

fn retry_in(guard: &Mutex<Guard>) {
    let mut guard = lock(guard);
    guard.checked = true;
    guard.stopped = None;
    guard.record();
}

fn set_closing_in(guard: &Mutex<Guard>, closing: bool) {
    let mut guard = lock(guard);
    guard.closing = closing;
    guard.record();
}

/// Runs `work` with `step` in the marker; `Err` when a crash stopped the GPU.
fn guarded_in<T>(guard: &Mutex<Guard>, step: Step, work: impl FnOnce() -> T) -> Result<T, String> {
    {
        let mut state = lock(guard);
        state.check();
        if let Some(stopped) = &state.stopped {
            return Err(stopped.clone());
        }
        state.running.push(step);
        state.record();
    }
    /// Ends the step also when `work` panics.
    struct Running<'a>(&'a Mutex<Guard>, Step);
    impl Drop for Running<'_> {
        fn drop(&mut self) {
            let mut state = lock(self.0);
            if let Some(index) = state.running.iter().position(|step| *step == self.1) {
                state.running.remove(index);
            }
            state.record();
        }
    }
    let _running = Running(guard, step);
    Ok(work())
}

/// Why Whisper stays off the GPU after a crash, if it does.
pub fn stopped() -> Option<String> {
    if cfg!(all(target_os = "linux", feature = "vulkan")) {
        stopped_in(&GUARD)
    } else {
        None
    }
}

/// Lets the next start use the GPU again after a crash stopped it.
pub fn retry() {
    retry_in(&GUARD);
}

/// The process is ending on purpose (`RunEvent::Exit`, or the updater closing
/// the app to install): a step it cuts short did not crash.
pub fn set_closing(closing: bool) {
    if cfg!(all(target_os = "linux", feature = "vulkan")) {
        set_closing_in(&GUARD, closing);
    }
}

#[cfg(all(target_os = "linux", feature = "vulkan"))]
mod linux {
    use super::{guarded_in, Step, GUARD};
    use std::ffi::{c_char, c_void, CStr};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    /// `PFN_vkVoidFunction`; `None` is Vulkan's `NULL`.
    pub type VoidFunction = Option<unsafe extern "C" fn()>;
    type GetInstanceProcAddr = unsafe extern "C" fn(*mut c_void, *const c_char) -> VoidFunction;
    /// `vkGetPhysicalDeviceFeatures2(VkPhysicalDevice, VkPhysicalDeviceFeatures2*)`.
    type GetPhysicalDeviceFeatures2 = unsafe extern "C" fn(*mut c_void, *mut c_void);
    /// `vkCmdCopyBuffer(VkCommandBuffer, VkBuffer, VkBuffer, uint32_t, const VkBufferCopy*)`;
    /// a `VkBuffer` is a 64-bit handle.
    type CmdCopyBuffer = unsafe extern "C" fn(*mut c_void, u64, u64, u32, *const c_void);

    /// `VK_ERROR_INITIALIZATION_FAILED`.
    const INITIALIZATION_FAILED: i32 = -3;

    /// The only function ggml-vulkan calls before `vkCreateInstance` without
    /// checking for `NULL`, so the only one a missing loader must provide:
    /// its error makes ggml give up on Vulkan.
    unsafe extern "C" fn no_instance_version(_version: *mut u32) -> i32 {
        INITIALIZATION_FAILED
    }

    /// The system loader's exports for the functions ggml-vulkan calls by
    /// symbol ([`export_vulkan_symbols`]). The two besides
    /// `vkGetInstanceProcAddr` are the loader's trampolines, which dispatch on
    /// their first argument like any other loader export.
    pub struct Loader {
        get_instance_proc_addr: GetInstanceProcAddr,
        pub get_physical_device_features2: GetPhysicalDeviceFeatures2,
        pub cmd_copy_buffer: CmdCopyBuffer,
    }

    /// The system loader, or `None` without one or while the guard keeps the
    /// GPU off. Decided on the first call, which comes from ggml's first look
    /// for devices; the library stays loaded for the process, as the drivers
    /// it loads do.
    pub fn loader() -> Option<&'static Loader> {
        static LOADER: OnceLock<Option<Loader>> = OnceLock::new();
        LOADER
            .get_or_init(|| {
                if let Some(stopped) = super::stopped() {
                    log::warn!("[vulkan] the GPU stays off: {stopped}");
                    return None;
                }
                // SAFETY: the Vulkan loader's initialisers only set up its own state.
                let library = match unsafe { libloading::Library::new("libvulkan.so.1") } {
                    Ok(library) => library,
                    Err(error) => {
                        log::info!("[vulkan] no Vulkan loader ({error}): Whisper runs on the processor");
                        return None;
                    }
                };
                // SAFETY: the loader exports these core functions with these signatures.
                let loader = unsafe {
                    (|| {
                        Ok::<_, libloading::Error>(Loader {
                            get_instance_proc_addr: *library.get(b"vkGetInstanceProcAddr\0")?,
                            get_physical_device_features2: *library.get(b"vkGetPhysicalDeviceFeatures2\0")?,
                            cmd_copy_buffer: *library.get(b"vkCmdCopyBuffer\0")?,
                        })
                    })()
                };
                match loader {
                    Ok(loader) => {
                        std::mem::forget(library);
                        Some(loader)
                    }
                    Err(error) => {
                        log::warn!("[vulkan] libvulkan.so.1 lacks a Vulkan 1.1 function ({error}): Whisper runs on the processor");
                        None
                    }
                }
            })
            .as_ref()
    }

    /// `vkGetInstanceProcAddr` for ggml-vulkan.
    ///
    /// # Safety
    /// `name` is a NUL-terminated string, as Vulkan requires.
    pub unsafe fn get_instance_proc_addr(instance: *mut c_void, name: *const c_char) -> VoidFunction {
        match loader() {
            // SAFETY: the caller's arguments, passed on unchanged.
            Some(loader) => unsafe { (loader.get_instance_proc_addr)(instance, name) },
            None => without_loader(name),
        }
    }

    /// The loader behind a call that only a Vulkan instance can make: ggml
    /// calls the other two exports with a device or a command buffer, which
    /// exist only once `vkCreateInstance` went through this loader.
    /// Unreachable without a loader: `vkCreateInstance` itself came through
    /// it. Should it happen, the process aborts with a log line instead of
    /// panicking, since a panic may not unwind out of the `extern "C"`
    /// exports that call this.
    pub fn instance_loader() -> &'static Loader {
        match loader() {
            Some(loader) => loader,
            None => {
                log::error!("[vulkan] ggml-vulkan called a device function without a Vulkan loader");
                // An abort skips every exit hook, the log's shutdown included.
                crate::app_log::shutdown();
                std::process::abort()
            }
        }
    }

    #[cfg(test)]
    crate::export_vulkan_symbols!();

    /// What [`get_instance_proc_addr`] answers without a loader.
    fn without_loader(name: *const c_char) -> VoidFunction {
        // SAFETY: the caller's NUL-terminated name.
        if !name.is_null() && unsafe { CStr::from_ptr(name) }.to_bytes() == b"vkEnumerateInstanceVersion" {
            // SAFETY: Vulkan casts every function to `PFN_vkVoidFunction` and back.
            Some(unsafe { std::mem::transmute::<unsafe extern "C" fn(*mut u32) -> i32, unsafe extern "C" fn()>(no_instance_version) })
        } else {
            None
        }
    }

    /// Makes ggml look for its devices inside the guard, once per process:
    /// the first look creates the Vulkan instance, which loads the drivers.
    /// Every path into whisper.cpp calls this before its first context.
    pub fn look_for_devices() {
        static LOOKED: OnceLock<()> = OnceLock::new();
        LOOKED.get_or_init(|| {
            use whisper_rs::whisper_rs_sys as sys;
            // SAFETY: takes no arguments; the registry initialises itself once.
            // `Err` when the guard keeps the GPU off: the forwarder then keeps
            // the loader closed for whichever call looks first.
            if let Ok(count) = guarded_in(&GUARD, Step::Devices, || unsafe { sys::ggml_backend_dev_count() }) {
                log::info!("[vulkan] ggml registered {count} devices");
            }
        });
    }

    /// Whether the loaded model's first GPU inference is still to come.
    struct Runs {
        /// A GPU context has been created in this process.
        on_gpu: AtomicBool,
        /// The current GPU model has completed an inference.
        first_run_done: AtomicBool,
    }

    static RUNS: Runs = Runs { on_gpu: AtomicBool::new(false), first_run_done: AtomicBool::new(false) };

    /// Creates a whisper.cpp context inside the guard when it goes to the GPU.
    pub fn load<T>(use_gpu: bool, work: impl FnOnce() -> T) -> T {
        load_in(&GUARD, &RUNS, use_gpu, work)
    }

    fn load_in<T>(guard: &std::sync::Mutex<super::Guard>, runs: &Runs, use_gpu: bool, work: impl FnOnce() -> T) -> T {
        if !use_gpu {
            return work();
        }
        let mut work = Some(work);
        let result = guarded_in(guard, Step::Load, || (work.take().expect("runs once"))());
        runs.on_gpu.store(true, Ordering::Release);
        // ggml compiles a shader the first time a graph needs it, per
        // operation and weight type, so a model of another quantization
        // compiles new ones on its first inference: guard that one too.
        runs.first_run_done.store(false, Ordering::Release);
        // `Err` only when the guard was stopped, and then ggml has no GPU.
        result.unwrap_or_else(|_| (work.take().expect("did not run"))())
    }

    /// Runs an inference, inside the guard until the loaded GPU model has
    /// completed one.
    pub fn first_run<T>(work: impl FnOnce() -> T) -> T {
        first_run_in(&GUARD, &RUNS, work)
    }

    fn first_run_in<T>(guard: &std::sync::Mutex<super::Guard>, runs: &Runs, work: impl FnOnce() -> T) -> T {
        if !runs.on_gpu.load(Ordering::Acquire) || runs.first_run_done.load(Ordering::Acquire) {
            return work();
        }
        let mut work = Some(work);
        let result = guarded_in(guard, Step::FirstRun, || (work.take().expect("runs once"))());
        runs.first_run_done.store(true, Ordering::Release);
        result.unwrap_or_else(|_| (work.take().expect("did not run"))())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn without_a_loader_only_the_instance_version_answers_and_it_fails() {
            let version = without_loader(c"vkEnumerateInstanceVersion".as_ptr()).expect("a function");
            // SAFETY: the function behind it is `no_instance_version`.
            let version: unsafe extern "C" fn(*mut u32) -> i32 = unsafe { std::mem::transmute(version) };
            let mut value = 0;
            assert_eq!(unsafe { version(&mut value) }, INITIALIZATION_FAILED);
            assert!(without_loader(c"vkCreateInstance".as_ptr()).is_none());
            assert!(without_loader(std::ptr::null()).is_none());
        }

        #[test]
        fn the_first_inference_of_each_gpu_model_is_guarded() {
            let dir = tempfile::tempdir().unwrap();
            let marker = dir.path().join("whisper-vulkan.attempt");
            let guard = super::super::Guard::new(Some(marker.clone()));
            let runs = Runs { on_gpu: AtomicBool::new(false), first_run_done: AtomicBool::new(false) };
            let guarded = |runs: &Runs| first_run_in(&guard, runs, || marker.exists());

            // Nothing on the GPU yet, and a model on the CPU: no marker.
            assert!(!guarded(&runs));
            load_in(&guard, &runs, false, || ());
            assert!(!guarded(&runs));

            // A GPU model: its first inference is guarded, the next is not.
            assert!(load_in(&guard, &runs, true, || marker.exists()));
            assert!(guarded(&runs));
            assert!(!guarded(&runs));

            // Another GPU model compiles its own shaders: guarded again.
            load_in(&guard, &runs, true, || ());
            assert!(guarded(&runs));
            assert!(!guarded(&runs));
            assert!(!marker.exists());
        }
    }
}

#[cfg(all(target_os = "linux", feature = "vulkan"))]
pub use linux::{first_run, get_instance_proc_addr, instance_loader, load, look_for_devices, VoidFunction};

/// Defines the Vulkan functions ggml-vulkan calls by symbol, forwarding them
/// to the system loader (module docs): `main.rs` for the executable, and this
/// module for the lib's test binary. whisper.cpp 1.8 calls three:
/// `vkGetInstanceProcAddr`, `vkGetPhysicalDeviceFeatures2` and
/// `vkCmdCopyBuffer`. One it starts calling after an update links
/// `libvulkan.so.1` again, which the Linux release leg refuses.
#[macro_export]
macro_rules! export_vulkan_symbols {
    () => {
        #[no_mangle]
        pub unsafe extern "C" fn vkGetInstanceProcAddr(
            instance: *mut ::std::ffi::c_void,
            name: *const ::std::ffi::c_char,
        ) -> $crate::whisper_engine::vulkan::VoidFunction {
            // SAFETY: Vulkan's contract, passed on from ggml-vulkan.
            unsafe { $crate::whisper_engine::vulkan::get_instance_proc_addr(instance, name) }
        }

        #[no_mangle]
        pub unsafe extern "C" fn vkGetPhysicalDeviceFeatures2(physical_device: *mut ::std::ffi::c_void, features: *mut ::std::ffi::c_void) {
            // SAFETY: as above.
            unsafe { ($crate::whisper_engine::vulkan::instance_loader().get_physical_device_features2)(physical_device, features) }
        }

        #[no_mangle]
        pub unsafe extern "C" fn vkCmdCopyBuffer(
            command_buffer: *mut ::std::ffi::c_void,
            source: u64,
            destination: u64,
            region_count: u32,
            regions: *const ::std::ffi::c_void,
        ) {
            // SAFETY: as above.
            unsafe { ($crate::whisper_engine::vulkan::instance_loader().cmd_copy_buffer)(command_buffer, source, destination, region_count, regions) }
        }
    };
}

/// Without the Linux Vulkan build these run `work` as it is.
#[cfg(not(all(target_os = "linux", feature = "vulkan")))]
pub fn load<T>(_use_gpu: bool, work: impl FnOnce() -> T) -> T {
    work()
}

#[cfg(not(all(target_os = "linux", feature = "vulkan")))]
pub fn first_run<T>(work: impl FnOnce() -> T) -> T {
    work()
}

#[cfg(not(all(target_os = "linux", feature = "vulkan")))]
pub fn look_for_devices() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_marker_left_by_a_crash_keeps_the_gpu_off_until_a_retry() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("whisper-vulkan.attempt");
        let guard = Guard::new(Some(marker.clone()));
        // A step runs with the marker in place, and removes it after.
        let seen = guarded_in(&guard, Step::Load, || std::fs::read_to_string(&marker).unwrap()).unwrap();
        assert_eq!(seen, "loading Whisper onto the graphics card");
        assert!(!marker.exists());

        // Two steps at once (a live call and a language detection) both show.
        guarded_in(&guard, Step::FirstRun, || {
            guarded_in(&guard, Step::FirstRun, || ()).unwrap();
            assert_eq!(std::fs::read_to_string(&marker).unwrap(), "running Whisper on the graphics card for the first time");
            guarded_in(&guard, Step::Devices, || {
                assert_eq!(
                    std::fs::read_to_string(&marker).unwrap(),
                    "running Whisper on the graphics card for the first time\nlooking for the graphics card"
                );
            })
            .unwrap();
        })
        .unwrap();
        assert!(!marker.exists());

        // The next process finds a marker: the GPU stays off.
        std::fs::write(&marker, "looking for the graphics card").unwrap();
        let next = Guard::new(Some(marker.clone()));
        let stopped = stopped_in(&next).unwrap();
        assert_eq!(stopped, "Protocol closed unexpectedly the last time it was looking for the graphics card, so Whisper runs on the processor.");
        assert!(guarded_in(&next, Step::Devices, || ()).is_err());
        retry_in(&next);
        assert!(!marker.exists());
        assert_eq!(stopped_in(&next), None);
        assert!(guarded_in(&next, Step::Devices, || ()).is_ok());
    }

    #[test]
    fn a_clean_quit_during_a_step_is_not_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("whisper-vulkan.attempt");
        let guard = Guard::new(Some(marker.clone()));
        guarded_in(&guard, Step::FirstRun, || {
            assert!(marker.exists());
            set_closing_in(&guard, true);
            assert!(!marker.exists());
        })
        .unwrap();
        assert!(!marker.exists());
        assert_eq!(stopped_in(&Guard::new(Some(marker.clone()))), None);

        // An install that failed reopens the app: steps record again.
        set_closing_in(&guard, false);
        guarded_in(&guard, Step::Load, || assert!(marker.exists())).unwrap();
    }

    #[test]
    fn a_panicking_step_still_removes_the_marker() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("whisper-vulkan.attempt");
        let guard = Guard::new(Some(marker.clone()));
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = guarded_in(&guard, Step::Load, || panic!("a load that panics"));
        }));
        assert!(panicked.is_err());
        assert!(!marker.exists());
    }
}
