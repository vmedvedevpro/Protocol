//! The Speech check's report (#233): plain text a tester pastes into a chat,
//! followed by the same data as JSON so that reports can be compared.
//!
//! Nothing personal goes in: the check reads only the sample, never a
//! meeting or an audio device, and [`scrub`] writes the home folder as `~`
//! and the user's name as `<user>` in every string, error texts included.

use serde::{Deserialize, Serialize};

use super::score::{SpeakerScore, WordErrors};

/// Bumped when a field changes meaning, so a tool comparing reports can tell.
pub const FORMAT: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    Parakeet,
    Whisper,
    Pyannote,
    Nemotron,
}

impl StepKind {
    pub const ALL: [StepKind; 4] = [StepKind::Parakeet, StepKind::Whisper, StepKind::Pyannote, StepKind::Nemotron];

    /// The step's name in the report and the UI.
    pub fn title(self) -> &'static str {
        match self {
            StepKind::Parakeet => "Parakeet (live text)",
            StepKind::Whisper => "Whisper (after the meeting)",
            StepKind::Pyannote => "Pyannote and WeSpeaker (speakers)",
            StepKind::Nemotron => "Nemotron (speakers)",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    Passed,
    Failed,
    /// Not run: the model is not on this computer, or the tester declined its download.
    NotChecked,
    Cancelled,
    /// Protocol closed while this step ran (the crash note, see `note.rs`).
    ClosedTheApp,
}

impl StepStatus {
    fn word(self) -> &'static str {
        match self {
            StepStatus::Passed => "PASS",
            StepStatus::Failed => "FAIL",
            StepStatus::NotChecked => "NOT CHECKED",
            StepStatus::Cancelled => "CANCELLED",
            StepStatus::ClosedTheApp => "CLOSED THE APP",
        }
    }
}

/// A device: the one Protocol picked, or the one the model ran on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// "Intel NPU", "Intel GPU (OpenVINO)", "GPU (Vulkan): <name>", "processor"…
    pub name: String,
    /// Why, in a sentence.
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fallback {
    pub from: String,
    pub to: String,
    /// The exact error the app recorded.
    pub error: String,
}

/// One clip through one model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipResult {
    pub clip: String,
    pub audio_ms: f64,
    pub processing_ms: f64,
    pub real_time_factor: f64,
    /// ASR: what the model wrote, the language Whisper detected, and the errors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_errors: Option<WordErrors>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_error_rate: Option<f64>,
    /// Speakers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speakers: Option<SpeakerScore>,
    pub passed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelId {
    pub id: String,
    /// The catalog commit of the installed copy, or the file's pin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepReport {
    pub kind: StepKind,
    pub status: StepStatus,
    /// Why it failed or was not checked, in a sentence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picked: Option<Device>,
    /// The inputs of the decision, name and value.
    #[serde(default)]
    pub inputs: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ran_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<Fallback>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_ms: Option<f64>,
    #[serde(default)]
    pub clips: Vec<ClipResult>,
    /// Parakeet: whether it keeps up with a meeting (`score::keeps_up`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keeps_up: Option<bool>,
}

impl StepReport {
    pub fn new(kind: StepKind, status: StepStatus) -> Self {
        Self {
            kind,
            status,
            reason: None,
            model: None,
            picked: None,
            inputs: Vec::new(),
            ran_on: None,
            fallback: None,
            load_ms: None,
            clips: Vec::new(),
            keeps_up: None,
        }
    }

    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_version: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct System {
    pub protocol_version: String,
    pub package: String,
    /// How this build runs Whisper: "Vulkan", "Metal", "CPU".
    pub whisper_build: String,
    pub os: String,
    pub os_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distribution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub processor: String,
    pub threads: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avx2: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avx512: Option<bool>,
    pub ram_gb: f64,
    #[serde(default)]
    pub gpus: Vec<Gpu>,
    /// The Vulkan devices ggml lists, as it names them.
    #[serde(default)]
    pub vulkan_devices: Vec<String>,
    /// Linux: Intel's OpenCL driver is registered (OpenVINO needs it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intel_opencl: Option<bool>,
    /// Windows: the Intel NPU and its state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npu: Option<String>,
    pub onnx_runtime: String,
    #[serde(default)]
    pub onnx_providers: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Passed,
    Failed,
    Cancelled,
    /// Protocol closed during a step; the remaining steps may still be run.
    Interrupted,
    /// No step ran: every model was missing or declined.
    NothingChecked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub format: u32,
    /// UTC, RFC 3339.
    pub created: String,
    pub outcome: Outcome,
    pub system: System,
    /// The models Protocol picks for this computer, which the check runs.
    pub pair: Pair,
    /// The models the tester selected in Settings.
    pub selected: Pair,
    pub steps: Vec<StepReport>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pair {
    /// "parakeet:<id>" or "whisper:<id>".
    #[serde(default)]
    pub live: Option<String>,
    #[serde(default)]
    pub post_meeting: Option<String>,
    /// What the WebView read to choose the pair, as (name, value).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<(String, String)>,
}

impl Pair {
    /// Whether the models selected in Settings are not this pair; nothing
    /// selected (a new install) is no difference.
    pub fn differs_from(&self, selected: &Pair) -> bool {
        (selected.live.is_some() && selected.live != self.live) || (selected.post_meeting.is_some() && selected.post_meeting != self.post_meeting)
    }
}

impl Report {
    /// The outcome of the steps: any failure fails the check; a cancelled or
    /// interrupted step leaves the check cancelled or interrupted; a check
    /// passes only when at least one step ran and passed.
    pub fn outcome_of(steps: &[StepReport]) -> Outcome {
        if steps.iter().any(|step| step.status == StepStatus::ClosedTheApp) {
            Outcome::Interrupted
        } else if steps.iter().any(|step| step.status == StepStatus::Cancelled) {
            Outcome::Cancelled
        } else if steps.iter().any(|step| step.status == StepStatus::Failed) {
            Outcome::Failed
        } else if steps.iter().any(|step| step.status == StepStatus::Passed) {
            Outcome::Passed
        } else {
            Outcome::NothingChecked
        }
    }

    /// The text part, then the JSON.
    pub fn render(&self) -> String {
        let mut out = String::new();
        let line = |out: &mut String, text: String| {
            out.push_str(&text);
            out.push('\n');
        };
        let outcome = match self.outcome {
            Outcome::Passed => "passed",
            Outcome::Failed => "failed",
            Outcome::Cancelled => "cancelled",
            Outcome::Interrupted => "interrupted: Protocol closed during a step",
            Outcome::NothingChecked => "nothing was checked",
        };
        line(&mut out, format!("Protocol speech check: {outcome}"));
        line(&mut out, format!("Created {}", self.created));
        line(&mut out, String::new());
        let s = &self.system;
        line(&mut out, format!("Protocol {} ({}), Whisper built for {}", s.protocol_version, s.package, s.whisper_build));
        let mut os = format!("{} {}", s.os, s.os_version);
        if let Some(distribution) = &s.distribution {
            os.push_str(&format!(", {distribution}"));
        }
        if let Some(desktop) = &s.desktop {
            os.push_str(&format!(", {desktop}"));
        }
        if let Some(session) = &s.session {
            os.push_str(&format!(", {session}"));
        }
        line(&mut out, format!("OS: {os}"));
        let flag = |value: Option<bool>| match value {
            Some(true) => "yes",
            Some(false) => "no",
            None => "unknown",
        };
        line(
            &mut out,
            format!(
                "Processor: {} ({} threads, AVX2 {}, AVX-512 {}), RAM {:.1} GB",
                s.processor,
                s.threads,
                flag(s.avx2),
                flag(s.avx512),
                s.ram_gb
            ),
        );
        if s.gpus.is_empty() {
            line(&mut out, "GPU: none found".to_string());
        }
        for gpu in &s.gpus {
            let mut text = format!("GPU: {}", gpu.name);
            if let Some(vendor) = &gpu.vendor {
                text.push_str(&format!(" ({vendor})"));
            }
            if let Some(driver) = &gpu.driver {
                text.push_str(&format!(", driver {driver}"));
            }
            if let Some(version) = &gpu.driver_version {
                text.push_str(&format!(" {version}"));
            }
            line(&mut out, text);
        }
        if !s.vulkan_devices.is_empty() {
            line(&mut out, format!("Vulkan devices (ggml): {}", s.vulkan_devices.join("; ")));
        }
        if let Some(opencl) = s.intel_opencl {
            line(&mut out, format!("Intel OpenCL driver: {}", if opencl { "present" } else { "missing" }));
        }
        if let Some(npu) = &s.npu {
            line(&mut out, format!("NPU: {npu}"));
        }
        let providers = if s.onnx_providers.is_empty() { String::new() } else { format!(", providers {}", s.onnx_providers.join(", ")) };
        line(&mut out, format!("ONNX Runtime: {}{providers}", s.onnx_runtime));
        line(&mut out, String::new());
        let named = |value: &Option<String>| value.clone().unwrap_or_else(|| "none".to_string());
        line(&mut out, format!("Checked pair: live {}, after the meeting {}", named(&self.pair.live), named(&self.pair.post_meeting)));
        for (name, value) in &self.pair.inputs {
            line(&mut out, format!("  {name}: {value}"));
        }
        if self.pair.differs_from(&self.selected) {
            line(
                &mut out,
                format!(
                    "Selected in Settings (differs): live {}, after the meeting {}",
                    named(&self.selected.live),
                    named(&self.selected.post_meeting)
                ),
            );
        }
        for step in &self.steps {
            line(&mut out, String::new());
            line(&mut out, format!("{}: {}", step.kind.title(), step.status.word()));
            if let Some(reason) = &step.reason {
                line(&mut out, format!("  Reason: {reason}"));
            }
            if let Some(model) = &step.model {
                let version = model.version.as_ref().map(|version| format!(" ({version})")).unwrap_or_default();
                line(&mut out, format!("  Model: {}{version}", model.id));
            }
            if let Some(picked) = &step.picked {
                line(&mut out, format!("  Picked: {} ({})", picked.name, picked.why));
            }
            for (name, value) in &step.inputs {
                line(&mut out, format!("    {name}: {value}"));
            }
            if let Some(ran_on) = &step.ran_on {
                line(&mut out, format!("  Ran on: {ran_on}"));
            }
            if let Some(fallback) = &step.fallback {
                line(&mut out, format!("  Fallback: {} to {}: {}", fallback.from, fallback.to, fallback.error));
            }
            if let Some(load_ms) = step.load_ms {
                line(&mut out, format!("  Load: {}", seconds(load_ms)));
            }
            for clip in &step.clips {
                let mut text = format!(
                    "  {}: {} for {} (real-time factor {:.2})",
                    clip.clip,
                    seconds(clip.processing_ms),
                    seconds(clip.audio_ms),
                    clip.real_time_factor
                );
                if let (Some(rate), Some(errors)) = (clip.word_error_rate, clip.word_errors) {
                    text.push_str(&format!(
                        ", word errors {:.3} ({} sub, {} del, {} ins of {})",
                        rate, errors.substitutions, errors.deletions, errors.insertions, errors.reference_words
                    ));
                }
                if let Some(language) = &clip.language {
                    text.push_str(&format!(", language {language}"));
                }
                if let Some(speakers) = clip.speakers {
                    text.push_str(&format!(
                        ", {} speakers for {} voices, {:.0}% of the labelled speech to the right voice, {:.0}% of the turns labelled",
                        speakers.speakers,
                        speakers.voices,
                        speakers.share * 100.0,
                        speakers.coverage * 100.0
                    ));
                }
                text.push_str(if clip.passed { ", pass" } else { ", fail" });
                line(&mut out, text);
                if let Some(written) = &clip.text {
                    line(&mut out, format!("    Text: {written}"));
                }
            }
            if let Some(keeps_up) = step.keeps_up {
                line(&mut out, format!("  Keeps up with a meeting: {}", if keeps_up { "yes" } else { "no" }));
            }
        }
        if !self.warnings.is_empty() {
            line(&mut out, String::new());
            line(&mut out, "Warnings:".to_string());
            for warning in &self.warnings {
                line(&mut out, format!("  {warning}"));
            }
        }
        line(&mut out, String::new());
        line(&mut out, "JSON:".to_string());
        out.push_str(&serde_json::to_string_pretty(self).unwrap_or_default());
        out.push('\n');
        out
    }
}

fn seconds(ms: f64) -> String {
    format!("{:.1} s", ms / 1000.0)
}

/// What [`scrub`] takes out.
#[derive(Debug, Clone, Default)]
pub struct Private {
    /// The home folder, written as `~`.
    pub home: Option<String>,
    /// The user's login name, written as `<user>` where it stands as a word.
    pub user: Option<String>,
    /// The computer's name, written as `<computer>` where it stands as a word.
    pub computer: Option<String>,
}

impl Private {
    pub fn of_this_computer() -> Self {
        let environment = |name: &str| std::env::var(name).ok().filter(|value| !value.trim().is_empty());
        Self {
            home: dirs::home_dir().map(|home| home.to_string_lossy().into_owned()),
            user: environment("USER").or_else(|| environment("USERNAME")),
            computer: sysinfo::System::host_name().or_else(|| environment("COMPUTERNAME")),
        }
    }
}

/// `pattern`, ignoring case, as a regex; `None` for an empty one.
fn ignoring_case(pattern: &str) -> Option<regex::Regex> {
    regex::Regex::new(&format!("(?i){pattern}")).ok()
}

/// The 8.3 name Windows gives a long name, as `CHRIST~1`: the first six
/// letters and digits upper-cased, a tilde and a number.
fn short_name(name: &str) -> Option<String> {
    let kept: String = name.chars().filter(|ch| ch.is_alphanumeric() || "_-!#$%&'()@^`{}~".contains(*ch)).take(6).collect();
    (kept.chars().count() >= 2).then(|| format!(r"{}~\d+", regex::escape(&kept)))
}

/// `text` with the home folder as `~` (also with the other slash, in any case
/// and with its 8.3 name on Windows, whose paths ignore case), the user's
/// name as `<user>` and the computer's as `<computer>` wherever they stand
/// as a word (an 8.3 form of the user's name too): in a path outside the
/// home folder, a Windows profile path, an error text.
pub fn scrub(text: &str, private: &Private) -> String {
    let mut out = text.to_string();
    let mut replace = |pattern: Option<regex::Regex>, with: &str| {
        if let Some(pattern) = pattern {
            out = pattern.replace_all(&out, regex::NoExpand(with)).into_owned();
        }
    };
    if let Some(home) = private.home.as_deref().filter(|home| home.len() > 1) {
        let home = home.trim_end_matches(['/', '\\']);
        let any_slash = |path: &str| regex::escape(path).replace(r"\\", "/").replace('/', r"[/\\]");
        replace(ignoring_case(&any_slash(home)), "~");
        // The profile's 8.3 form, `C:\Users\CHRIST~1`.
        if let Some((parent, name)) = home.rsplit_once(['/', '\\']) {
            if let Some(short) = short_name(name) {
                replace(ignoring_case(&format!(r"{}[/\\]{short}\b", any_slash(parent))), "~");
            }
        }
    }
    if let Some(user) = private.user.as_deref().map(str::trim).filter(|user| user.chars().count() >= 2) {
        replace(ignoring_case(&format!(r"\b{}\b", regex::escape(user))), "<user>");
        if let Some(short) = short_name(user) {
            replace(ignoring_case(&format!(r"\b{short}\b")), "<user>");
        }
    }
    // Three letters at least: a two-letter name such as "pc" stands as a
    // word in too many texts ("x86_64-pc-linux").
    if let Some(computer) = private.computer.as_deref().map(str::trim).filter(|name| name.chars().count() >= 3) {
        replace(ignoring_case(&format!(r"\b{}\b", regex::escape(computer))), "<computer>");
    }
    out
}

impl Report {
    /// The report with every free text scrubbed. The kinds, statuses and
    /// outcome are left alone: a login named "whisper" must not rename a step.
    pub fn scrubbed(&self, private: &Private) -> Report {
        let mut report = self.clone();
        report.for_each_text(&mut |text| *text = scrub(text, private));
        report
    }

    /// Every free-text string of the report; a new string field joins here.
    fn for_each_text(&mut self, f: &mut dyn FnMut(&mut String)) {
        fn each<'a>(texts: impl IntoIterator<Item = &'a mut String>, f: &mut dyn FnMut(&mut String)) {
            texts.into_iter().for_each(f);
        }
        let s = &mut self.system;
        each([&mut s.protocol_version, &mut s.package, &mut s.whisper_build, &mut s.os, &mut s.os_version, &mut s.processor, &mut s.onnx_runtime], f);
        each([&mut s.distribution, &mut s.desktop, &mut s.session, &mut s.npu].into_iter().flatten(), f);
        each(s.vulkan_devices.iter_mut().chain(s.onnx_providers.iter_mut()), f);
        for gpu in &mut s.gpus {
            each(std::iter::once(&mut gpu.name).chain([&mut gpu.vendor, &mut gpu.driver, &mut gpu.driver_version].into_iter().flatten()), f);
        }
        for pair in [&mut self.pair, &mut self.selected] {
            each([&mut pair.live, &mut pair.post_meeting].into_iter().flatten(), f);
            each(pair.inputs.iter_mut().flat_map(|(name, value)| [name, value]), f);
        }
        for step in &mut self.steps {
            each([&mut step.reason, &mut step.ran_on].into_iter().flatten(), f);
            if let Some(model) = &mut step.model {
                each(std::iter::once(&mut model.id).chain(model.version.as_mut()), f);
            }
            if let Some(picked) = &mut step.picked {
                each([&mut picked.name, &mut picked.why], f);
            }
            if let Some(fallback) = &mut step.fallback {
                each([&mut fallback.from, &mut fallback.to, &mut fallback.error], f);
            }
            each(step.inputs.iter_mut().flat_map(|(name, value)| [name, value]), f);
            for clip in &mut step.clips {
                each(std::iter::once(&mut clip.clip).chain([&mut clip.text, &mut clip.language].into_iter().flatten()), f);
            }
        }
        each(self.warnings.iter_mut(), f);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn private() -> Private {
        Private { home: Some("/home/tyler".into()), user: Some("tyler".into()), computer: None }
    }

    #[test]
    fn the_home_folder_becomes_a_tilde() {
        let text = "Failed to load /home/tyler/.local/share/io.github.vmedvedevpro.protocol/models/ggml.bin";
        assert_eq!(scrub(text, &private()), "Failed to load ~/.local/share/io.github.vmedvedevpro.protocol/models/ggml.bin");
    }

    #[test]
    fn windows_paths_lose_the_profile_in_any_case_and_slash() {
        let private = Private { home: Some(r"C:\Users\Tyler".into()), user: Some("Tyler".into()), computer: None };
        assert_eq!(scrub(r"c:\users\tyler\AppData\x.onnx and C:/Users/Tyler/y", &private), r"~\AppData\x.onnx and ~/y");
    }

    #[test]
    fn windows_short_names_and_the_computer_name_go_too() {
        let private = Private { home: Some(r"C:\Users\Christopher".into()), user: Some("Christopher".into()), computer: Some("DESKTOP-4F2K9".into()) };
        assert_eq!(
            scrub(r"cannot open C:\Users\CHRIST~1\AppData\Local\Temp\x.onnx on desktop-4f2k9", &private),
            r"cannot open ~\AppData\Local\Temp\x.onnx on <computer>"
        );
        assert_eq!(scrub(r"D:\cache\CHRIST~2\y", &private), r"D:\cache\<user>\y");
        // A name of two letters stays: it is a word in too many texts.
        let short = Private { computer: Some("pc".into()), ..Private::default() };
        assert_eq!(scrub("x86_64-pc-linux", &short), "x86_64-pc-linux");
    }

    #[test]
    fn a_login_named_like_a_step_renames_no_step() {
        let private = Private { home: None, user: Some("whisper".into()), computer: None };
        let scrubbed = report().scrubbed(&private);
        assert_eq!(scrubbed.steps[1].kind, StepKind::Whisper);
        assert_eq!(scrubbed.pair.post_meeting.as_deref(), Some("<user>:large-v3-turbo-q5_0"));
    }

    #[test]
    fn every_text_of_the_report_is_scrubbed() {
        let home = "/home/tyler/x";
        let mut report = report();
        report.for_each_text(&mut |text| *text = format!("{text} {home}"));
        // The fields a report may leave empty, filled.
        let s = &mut report.system;
        for field in [&mut s.distribution, &mut s.desktop, &mut s.session, &mut s.npu] {
            *field = Some(home.into());
        }
        s.vulkan_devices.push(home.into());
        s.onnx_providers.push(home.into());
        s.gpus.push(Gpu { name: home.into(), vendor: Some(home.into()), driver: Some(home.into()), driver_version: Some(home.into()) });
        let step = &mut report.steps[0];
        step.model = Some(ModelId { id: home.into(), version: Some(home.into()) });
        step.picked = Some(Device { name: home.into(), why: home.into() });
        step.inputs.push((home.into(), home.into()));
        step.clips[0].language = Some(home.into());
        let json = serde_json::to_string(&report.scrubbed(&private())).unwrap();
        assert!(!json.contains("tyler"), "{json}");
    }

    #[test]
    fn the_user_name_goes_where_it_is_a_word_only() {
        assert_eq!(scrub("/tmp/tyler-cache/x owned by tyler", &private()), "/tmp/<user>-cache/x owned by <user>");
        // Inside another word it stays.
        assert_eq!(scrub("tylerson", &private()), "tylerson");
        // A one-letter name would eat every word.
        let short = Private { user: Some("a".into()), ..Private::default() };
        assert_eq!(scrub("a b a", &short), "a b a");
    }

    fn report() -> Report {
        let mut whisper = StepReport::new(StepKind::Whisper, StepStatus::Failed).with_reason("Failed to load /home/tyler/models/x.bin");
        whisper.picked = Some(Device { name: "GPU (Vulkan): Intel(R) Arc(TM) B390 GPU".into(), why: "the Vulkan build found a GPU".into() });
        whisper.ran_on = Some("processor".into());
        whisper.fallback = Some(Fallback { from: "GPU".into(), to: "processor".into(), error: "vk error at /home/tyler/x".into() });
        let mut parakeet = StepReport::new(StepKind::Parakeet, StepStatus::Passed);
        parakeet.clips.push(ClipResult {
            clip: "ru".into(),
            audio_ms: 20810.0,
            processing_ms: 2081.0,
            real_time_factor: 0.1,
            text: Some("однако".into()),
            language: None,
            word_errors: Some(WordErrors { reference_words: 30, substitutions: 2, deletions: 0, insertions: 0 }),
            word_error_rate: Some(2.0 / 30.0),
            speakers: None,
            passed: true,
        });
        parakeet.keeps_up = Some(true);
        Report {
            format: FORMAT,
            created: "2026-11-26T10:00:00Z".into(),
            outcome: Outcome::Failed,
            system: System { protocol_version: "1.0.0".into(), package: "deb".into(), os: "Linux".into(), ..Default::default() },
            pair: Pair { live: Some("parakeet:parakeet-tdt-0.6b-v3-int8".into()), post_meeting: Some("whisper:large-v3-turbo-q5_0".into()), inputs: vec![("Intel NPU".into(), "none".into())] },
            selected: Pair { live: Some("parakeet:parakeet-tdt-0.6b-v3-int8".into()), post_meeting: Some("whisper:small".into()), inputs: Vec::new() },
            steps: vec![parakeet, whisper, StepReport::new(StepKind::Nemotron, StepStatus::NotChecked).with_reason("Not downloaded")],
            warnings: vec!["Nemotron was not checked".into()],
        }
    }

    #[test]
    fn the_report_carries_text_then_the_same_data_as_json() {
        let text = report().scrubbed(&private()).render();
        assert!(text.starts_with("Protocol speech check: failed\n"));
        assert!(text.contains("Whisper (after the meeting): FAIL"));
        assert!(text.contains("Picked: GPU (Vulkan): Intel(R) Arc(TM) B390 GPU (the Vulkan build found a GPU)"));
        assert!(text.contains("Fallback: GPU to processor: vk error at ~/x"));
        assert!(text.contains("Selected in Settings (differs): live parakeet:parakeet-tdt-0.6b-v3-int8, after the meeting whisper:small"));
        assert!(text.contains("ru: 2.1 s for 20.8 s (real-time factor 0.10), word errors 0.067 (2 sub, 0 del, 0 ins of 30), pass"));
        assert!(text.contains("Nemotron (speakers): NOT CHECKED"));
        assert!(!text.contains("tyler"), "{text}");
        let json = &text[text.find("JSON:\n").unwrap() + 6..];
        let parsed: Report = serde_json::from_str(json).unwrap();
        assert_eq!(parsed, report().scrubbed(&private()));
    }

    #[test]
    fn the_outcome_follows_the_worst_step() {
        let step = |status| StepReport::new(StepKind::Parakeet, status);
        assert_eq!(Report::outcome_of(&[step(StepStatus::Passed), step(StepStatus::NotChecked)]), Outcome::Passed);
        assert_eq!(Report::outcome_of(&[step(StepStatus::Passed), step(StepStatus::Failed)]), Outcome::Failed);
        assert_eq!(Report::outcome_of(&[step(StepStatus::Failed), step(StepStatus::Cancelled)]), Outcome::Cancelled);
        assert_eq!(Report::outcome_of(&[step(StepStatus::Cancelled), step(StepStatus::ClosedTheApp)]), Outcome::Interrupted);
        // Not one model ran: that is no pass.
        assert_eq!(Report::outcome_of(&[step(StepStatus::NotChecked), step(StepStatus::NotChecked)]), Outcome::NothingChecked);
        assert_eq!(Report::outcome_of(&[]), Outcome::NothingChecked);
    }

    #[test]
    fn a_selection_that_matches_the_pair_is_not_mentioned() {
        let mut same = report();
        same.selected = same.pair.clone();
        assert!(!same.render().contains("differs"));
        // Nothing selected (a new install) is no difference either.
        same.selected = Pair::default();
        assert!(!same.pair.differs_from(&same.selected));
    }
}
