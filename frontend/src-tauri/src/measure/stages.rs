//! Where the time of a Whisper call goes (#78): `measure::stages::whisper_stages`,
//! and the live calls at their pace: `measure::stages::whisper_paced`.
//!
//! `whisper_stages` decodes the kit's pieces of one setting as its path does (the live call:
//! greedy without timestamps; the post-meeting call: beam 5 with
//! timestamps) and splits every call into the creation of its whisper.cpp
//! state, whisper.cpp's own counters (mel, encoder, prompt, decoder steps,
//! sampling), the rest of the call, and freeing the state. Each mode decodes
//! all pieces: `fresh` creates a state per call, `reuse` decodes every piece
//! on one state, `churn` too but creates and frees another state after each
//! call. The text of each piece is compared across modes.

use std::path::Path;
use std::time::Instant;

use anyhow::{bail, ensure, Context, Result};
use serde::Serialize;
use whisper_rs::{WhisperContext, WhisperState};

use super::input::{existing_path, optional, Inputs};
use super::settings::Setting;
use super::{file_name, init_logging, ms_since, output, tracks, ONE_COMMAND, SAMPLES_PER_MS};
use crate::audio::post_meeting;
use crate::audio::transcription::worker::{is_digital_silence, peak_level};
use crate::whisper_engine::decoding::WhisperDecoding;
use crate::whisper_engine::post_meeting as whisper_pass;
use crate::whisper_engine::WhisperEngine;

/// The first fields of whisper.cpp 1.8.3's `struct whisper_state`
/// (`src/whisper.cpp`), in their order: the counters `whisper_print_timings`
/// prints. That function reads only a context's own state, which whisper-rs
/// never creates, so the probe reads them from the state it decodes on.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, Serialize)]
struct Counters {
    t_sample_us: i64,
    t_encode_us: i64,
    t_decode_us: i64,
    t_batchd_us: i64,
    t_prompt_us: i64,
    t_mel_us: i64,
    /// Tokens sampled.
    n_sample: i32,
    n_encode: i32,
    /// Decoder calls with one token: one generated token per decoder.
    n_decode: i32,
    /// Decoder calls with 2 to 15 tokens (a beam's step).
    n_batchd: i32,
    /// Decoder calls with more tokens: the prompt.
    n_prompt: i32,
    n_fail_p: i32,
    n_fail_h: i32,
}

impl Counters {
    /// The counters of `state`. whisper-rs keeps the state's pointer private;
    /// its `Debug` output shows it.
    fn of(state: &WhisperState) -> Self {
        let debug = format!("{state:?}");
        let hex = debug
            .rsplit("ptr: 0x")
            .next()
            .and_then(|rest| rest.split(|c: char| !c.is_ascii_hexdigit()).next())
            .expect("WhisperState's Debug output names its pointer");
        let address = usize::from_str_radix(hex, 16).expect("a hexadecimal pointer");
        // SAFETY: the pointer is the live state's, and `Counters` mirrors the
        // leading fields of `whisper_state`, which has no base class or
        // virtual functions, so they start at offset 0.
        unsafe { std::ptr::read(address as *const Counters) }
    }

    fn since(self, before: Self) -> Self {
        Self {
            t_sample_us: self.t_sample_us - before.t_sample_us,
            t_encode_us: self.t_encode_us - before.t_encode_us,
            t_decode_us: self.t_decode_us - before.t_decode_us,
            t_batchd_us: self.t_batchd_us - before.t_batchd_us,
            t_prompt_us: self.t_prompt_us - before.t_prompt_us,
            t_mel_us: self.t_mel_us - before.t_mel_us,
            n_sample: self.n_sample - before.n_sample,
            n_encode: self.n_encode - before.n_encode,
            n_decode: self.n_decode - before.n_decode,
            n_batchd: self.n_batchd - before.n_batchd,
            n_prompt: self.n_prompt - before.n_prompt,
            n_fail_p: self.n_fail_p - before.n_fail_p,
            n_fail_h: self.n_fail_h - before.n_fail_h,
        }
    }

    /// The time whisper.cpp's counters account for.
    fn counted_ms(&self) -> f64 {
        (self.t_sample_us + self.t_encode_us + self.t_decode_us + self.t_batchd_us + self.t_prompt_us + self.t_mel_us)
            as f64
            / 1000.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Mode {
    Fresh,
    Reuse,
    /// Decodes on one state, and after each call creates and frees another
    /// state without decoding on it: the work `Fresh` does between calls.
    Churn,
}

impl Mode {
    fn list(names: &str) -> Result<Vec<Self>> {
        names
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| match name {
                "fresh" => Ok(Self::Fresh),
                "reuse" => Ok(Self::Reuse),
                "churn" => Ok(Self::Churn),
                other => bail!("PROBE_MODES names {other:?}: use fresh, reuse or churn"),
            })
            .collect()
    }

    fn name(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Reuse => "reuse",
            Self::Churn => "churn",
        }
    }
}

#[derive(Serialize)]
struct Call {
    start_ms: f64,
    audio_ms: f64,
    /// `whisper_init_state`; 0 on a reused state, the other state's in `churn`.
    create_ms: f64,
    /// `whisper_full_with_state`.
    full_ms: f64,
    /// `whisper_free_state`; 0 on a reused state, the other state's in `churn`.
    free_ms: f64,
    counters: Counters,
    text: String,
}

#[derive(Serialize)]
struct ModeRun {
    mode: &'static str,
    calls: Vec<Call>,
}

#[derive(Serialize)]
struct Profile {
    setting: &'static str,
    model: String,
    flash_attn: bool,
    language: String,
    whisper_cpp: &'static str,
    /// The first call, on a new state, untimed in the modes.
    warmup_ms: f64,
    runs: Vec<ModeRun>,
}

/// The parameters of `setting`'s call, as its path passes them.
fn call_params<'a, 'b>(
    setting: Setting,
    language: Option<&'a str>,
    prompt_tokens: &'b [whisper_rs::WhisperTokenId],
) -> whisper_rs::FullParams<'a, 'b> {
    match setting {
        Setting::Live => WhisperEngine::live_params(language, prompt_tokens),
        _ => whisper_pass::piece_params(WhisperDecoding::POST_MEETING, prompt_tokens, language, true),
    }
}

/// The text of a call as its path keeps it: the live call's segments joined
/// and cleaned (`transcribe_audio_with_confidence`), the pass's rows.
fn text_of(setting: Setting, state: &WhisperState) -> String {
    match setting {
        Setting::Live => {
            let segments: Vec<String> = state
                .as_iter()
                .filter_map(|segment| segment.to_str_lossy().ok().map(|text| text.trim().to_string()))
                .filter(|text| !text.is_empty())
                .collect();
            WhisperEngine::clean_repetitive_text(segments.join(" ").trim())
        }
        _ => whisper_pass::timed_segments(state).into_iter().map(|row| row.text).collect::<Vec<_>>().join(" | "),
    }
}

fn decode(
    ctx: &WhisperContext,
    state: Option<&mut WhisperState>,
    setting: Setting,
    samples: &[f32],
    language: Option<&str>,
    prompt_tokens: &[whisper_rs::WhisperTokenId],
) -> Result<(f64, f64, f64, Counters, String)> {
    let params = call_params(setting, language, prompt_tokens);
    match state {
        Some(state) => {
            let before = Counters::of(state);
            let started = Instant::now();
            state.full(params, samples)?;
            let full_ms = ms_since(started);
            Ok((0.0, full_ms, 0.0, Counters::of(state).since(before), text_of(setting, state)))
        }
        None => {
            let started = Instant::now();
            let mut state = ctx.create_state()?;
            let create_ms = ms_since(started);
            let started = Instant::now();
            state.full(params, samples)?;
            let full_ms = ms_since(started);
            let counters = Counters::of(&state);
            let text = text_of(setting, &state);
            let started = Instant::now();
            drop(state);
            Ok((create_ms, full_ms, ms_since(started), counters, text))
        }
    }
}

fn median(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn print_profile(profile: &Profile) {
    println!();
    println!(
        "{:<6} {:>5} {:>8} {:>7} {:>6} | per call, ms: {:>7} {:>7} {:>6} {:>7} {:>6} {:>7} {:>7} {:>6} {:>6} | {:>6} {:>8}",
        "mode", "calls", "audio s", "wall s", "x RT", "create", "full", "mel", "encode", "prompt", "decode", "sample",
        "other", "free", "tokens", "ms/token"
    );
    for run in &profile.runs {
        let n = run.calls.len().max(1) as f64;
        let sum = |f: &dyn Fn(&Call) -> f64| run.calls.iter().map(f).sum::<f64>();
        let audio_s = sum(&|c| c.audio_ms) / 1000.0;
        let wall_s = sum(&|c| c.create_ms + c.full_ms + c.free_ms) / 1000.0;
        let decode_steps = sum(&|c| (c.counters.n_decode + c.counters.n_batchd) as f64);
        let decode_ms = sum(&|c| (c.counters.t_decode_us + c.counters.t_batchd_us) as f64 / 1000.0);
        println!(
            "{:<6} {:>5} {:>8.1} {:>7.2} {:>6.1} | {:>22.1} {:>7.1} {:>6.1} {:>7.1} {:>6.1} {:>7.1} {:>7.1} {:>6.1} {:>6.1} | {:>6.1} {:>8.2}",
            run.mode,
            run.calls.len(),
            audio_s,
            wall_s,
            audio_s / wall_s,
            sum(&|c| c.create_ms) / n,
            sum(&|c| c.full_ms) / n,
            sum(&|c| c.counters.t_mel_us as f64 / 1000.0) / n,
            sum(&|c| c.counters.t_encode_us as f64 / 1000.0) / n,
            sum(&|c| c.counters.t_prompt_us as f64 / 1000.0) / n,
            decode_ms / n,
            sum(&|c| c.counters.t_sample_us as f64 / 1000.0) / n,
            sum(&|c| c.full_ms - c.counters.counted_ms()) / n,
            sum(&|c| c.free_ms) / n,
            decode_steps / n,
            decode_ms / decode_steps.max(1.0),
        );
        println!(
            "       medians, ms: create {:.1}, full {:.1}, encode {:.1}, free {:.1}; fallbacks {} logprob / {} entropy",
            median(run.calls.iter().map(|c| c.create_ms).collect()),
            median(run.calls.iter().map(|c| c.full_ms).collect()),
            median(run.calls.iter().map(|c| c.counters.t_encode_us as f64 / 1000.0).collect()),
            median(run.calls.iter().map(|c| c.free_ms).collect()),
            run.calls.iter().map(|c| c.counters.n_fail_p).sum::<i32>(),
            run.calls.iter().map(|c| c.counters.n_fail_h).sum::<i32>(),
        );
    }
    if let Some((first, rest)) = profile.runs.split_first() {
        for run in rest {
            let same = first.calls.iter().zip(&run.calls).filter(|(a, b)| a.text == b.text).count();
            println!("{} vs {}: {} of {} texts identical", first.mode, run.mode, same, first.calls.len());
        }
    }
}

/// Opens the model with the app's context parameters, or with flash
/// attention set by `PROBE_FLASH_ATTN`.
fn open(path: &Path, flash_attn: Option<bool>) -> Result<(WhisperContext, bool)> {
    let (mut params, acceleration) = crate::whisper_engine::whisper_engine::context_parameters(&crate::audio::HardwareProfile::detect());
    if let Some(flash_attn) = flash_attn {
        params.flash_attn = flash_attn;
    }
    let flash_attn = params.flash_attn;
    log::info!("{} with flash attention {}", acceleration.status_label(), flash_attn);
    let ctx = WhisperContext::new_with_params(path, params)
        .map_err(|error| anyhow::anyhow!("opening {}: {error}", path.display()))?;
    Ok((ctx, flash_attn))
}

/// Inputs: `MEASURE_AUDIO`, `MEASURE_OUT`, `MEASURE_WHISPER_MODEL`, and
/// optionally `MEASURE_LANGUAGE`, `MEASURE_VOCABULARY`; `PROBE_SETTING`
/// (`live`, default, or `post-meeting`), `PROBE_MODES` (default
/// `fresh,reuse`; also `churn`), `PROBE_PIECES` (the first N pieces),
/// `PROBE_FLASH_ATTN` (`true` or `false` instead of the app's choice),
/// `PROBE_GAP_MS` (a pause after each call). Writes `stages-<setting>.json`.
#[tokio::test]
#[ignore = "measurement command; inputs from MEASURE_* and PROBE_* (measure/stages.rs)"]
async fn whisper_stages() -> Result<()> {
    let _one = ONE_COMMAND.lock().await;
    init_logging();
    let inputs = Inputs::from_env()?;
    ensure!(inputs.span.is_none(), "whisper_stages decodes whole recordings: unset MEASURE_SPAN");
    let model = existing_path("MEASURE_WHISPER_MODEL", "the ggml model file")?;
    let setting = match optional("PROBE_SETTING").as_deref() {
        None | Some("live") => Setting::Live,
        Some("post-meeting") => Setting::PostMeeting,
        Some(other) => bail!("PROBE_SETTING is {other:?}: use live or post-meeting"),
    };
    let modes = Mode::list(&optional("PROBE_MODES").unwrap_or_else(|| "fresh,reuse".to_string()))?;
    let limit = optional("PROBE_PIECES").map(|n| n.parse::<usize>()).transpose().context("PROBE_PIECES")?;
    let flash_attn = optional("PROBE_FLASH_ATTN").map(|v| v.parse::<bool>()).transpose().context("PROBE_FLASH_ATTN")?;
    let gap = optional("PROBE_GAP_MS")
        .map(|ms| ms.parse::<u64>().map(std::time::Duration::from_millis))
        .transpose()
        .context("PROBE_GAP_MS")?;

    let mut tracks = tracks::load(&inputs.audio)?;
    let cut = tracks::cut(&tracks, setting.cap())?;
    tracks.iter_mut().for_each(tracks::Track::release_samples);
    // Each path's skip rule: the live worker skips digital silence, the pass
    // quiet pieces.
    let mut pieces: Vec<_> = cut
        .pieces
        .iter()
        .map(|(segment, _)| segment)
        .filter(|segment| match setting {
            Setting::Live => !is_digital_silence(peak_level(&segment.samples)),
            _ => post_meeting::skip_reason(&segment.samples).is_none(),
        })
        .collect();
    if let Some(limit) = limit {
        pieces.truncate(limit);
    }
    ensure!(!pieces.is_empty(), "no piece to decode");

    let (ctx, flash_attn) = open(&model, flash_attn)?;
    let language = (inputs.language != "auto").then_some(inputs.language.as_str());
    let prompt_tokens = WhisperEngine::tokenize_initial_prompt(&ctx, inputs.vocabulary.as_deref())?;

    let started = Instant::now();
    decode(&ctx, None, setting, &pieces[0].samples, language, &prompt_tokens)?;
    let warmup_ms = ms_since(started);

    let mut runs = Vec::new();
    for mode in modes {
        let mut shared = match mode {
            Mode::Fresh => None,
            Mode::Reuse | Mode::Churn => Some(ctx.create_state()?),
        };
        let mut calls = Vec::with_capacity(pieces.len());
        for piece in &pieces {
            let (mut create_ms, full_ms, mut free_ms, counters, text) =
                decode(&ctx, shared.as_mut(), setting, &piece.samples, language, &prompt_tokens)?;
            if mode == Mode::Churn {
                let started = Instant::now();
                let other = ctx.create_state()?;
                create_ms = ms_since(started);
                let started = Instant::now();
                drop(other);
                free_ms = ms_since(started);
            }
            if let Some(gap) = gap {
                std::thread::sleep(gap);
            }
            calls.push(Call {
                start_ms: piece.start_timestamp_ms,
                audio_ms: piece.samples.len() as f64 / SAMPLES_PER_MS,
                create_ms,
                full_ms,
                free_ms,
                counters,
                text,
            });
        }
        runs.push(ModeRun { mode: mode.name(), calls });
    }

    let profile = Profile {
        setting: setting.name(),
        model: file_name(&model),
        flash_attn,
        language: inputs.language.clone(),
        whisper_cpp: whisper_rs::WHISPER_CPP_VERSION,
        warmup_ms,
        runs,
    };
    output::write(&inputs.out, &format!("stages-{}", setting.name()), &profile)?;
    print_profile(&profile);
    Ok(())
}

fn unix_now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

/// Appends a phase to `BENCH_MARKS` in the format of #66's energy harness
/// (`scripts/npu-bench/marks.py` on branch `66-npu-benchmark`), which reads
/// the energy between `t0` and `t1`; nothing without it.
fn mark(phase: &str, t0: f64, t1: f64, fields: serde_json::Value) -> Result<()> {
    use std::io::Write;
    let Some(path) = optional("BENCH_MARKS") else { return Ok(()) };
    let mut record = serde_json::json!({ "phase": phase, "t0": t0, "t1": t1 });
    if let (Some(record), Some(fields)) = (record.as_object_mut(), fields.as_object()) {
        record.extend(fields.clone());
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{record}")?;
    Ok(())
}

/// The live scenario at its pace (#66's `paced_live` for Whisper): one
/// window of `PACED_PERIOD` seconds (6) every period for `PACED_SECONDS`
/// (300), cut from `MEASURE_AUDIO` in a loop, each decoded by the live
/// worker's call (`transcribe_audio_with_confidence`) after a warm-up call.
/// Inputs: `MEASURE_AUDIO`, `MEASURE_WHISPER_MODEL`, optionally
/// `MEASURE_LANGUAGE`.
#[tokio::test]
#[ignore = "measurement command; inputs from MEASURE_* and PACED_* (measure/stages.rs)"]
async fn whisper_paced() -> Result<()> {
    let _one = ONE_COMMAND.lock().await;
    init_logging();
    let seconds: f64 = optional("PACED_SECONDS").map_or(Ok(300.0), |v| v.parse())?;
    let period: f64 = optional("PACED_PERIOD").map_or(Ok(6.0), |v| v.parse())?;
    let audio = existing_path("MEASURE_AUDIO", "a 16 kHz speech file")?;
    let samples = tracks::load(&audio)?.into_iter().next().context("the audio has no track")?.samples;
    let window = (period * 1000.0 * SAMPLES_PER_MS) as usize;
    let calls = (seconds / period) as usize;
    let looped: Vec<f32> = samples.iter().copied().cycle().take(window * calls).collect();
    let language = optional("MEASURE_LANGUAGE");

    let t0 = unix_now();
    let engines =
        super::engines::Engines::open(Some(&existing_path("MEASURE_WHISPER_MODEL", "the ggml model")?), None).await?;
    let loaded = engines.whisper.as_ref().context("no Whisper engine")?;
    mark("load", t0, unix_now(), serde_json::json!({}))?;
    println!("engine: whisper on {}", loaded.acceleration);

    let t0 = unix_now();
    loaded.engine.transcribe_audio_with_confidence(looped[..window].to_vec(), language.clone(), None).await?;
    mark("warmup", t0, unix_now(), serde_json::json!({}))?;

    let mut latencies = Vec::with_capacity(calls);
    let mut texts = Vec::with_capacity(calls);
    let mut late = 0;
    let start = Instant::now();
    let t0 = unix_now();
    for (i, piece) in looped.chunks(window).enumerate() {
        let due = std::time::Duration::from_secs_f64(i as f64 * period);
        match due.checked_sub(start.elapsed()) {
            Some(wait) => tokio::time::sleep(wait).await,
            None => late += usize::from(i > 0),
        }
        let began = Instant::now();
        let (text, _, _) = loaded.engine.transcribe_audio_with_confidence(piece.to_vec(), language.clone(), None).await?;
        latencies.push(ms_since(began));
        texts.push(text);
    }
    let end = std::time::Duration::from_secs_f64(calls as f64 * period);
    if let Some(wait) = end.checked_sub(start.elapsed()) {
        tokio::time::sleep(wait).await;
    }
    let mut sorted = latencies.clone();
    sorted.sort_by(f64::total_cmp);
    let median = sorted[sorted.len() / 2];
    let busy = latencies.iter().sum::<f64>() / 1000.0 / (calls as f64 * period);
    mark(
        "paced",
        t0,
        unix_now(),
        serde_json::json!({
            "audio_s": calls as f64 * period, "calls": calls, "period_s": period, "late_calls": late,
            "latency_ms_median": median, "latency_ms_max": sorted[sorted.len() - 1], "busy_share": busy,
        }),
    )?;
    if let Some(out) = optional("MEASURE_OUT") {
        let out = std::path::PathBuf::from(out);
        std::fs::create_dir_all(&out)?;
        output::write(&out, "paced", &serde_json::json!({ "latencies_ms": latencies, "texts": texts }))?;
    }
    println!(
        "paced: {calls} calls, median {median:.0} ms, max {:.0} ms, busy {:.1} %, late {late}",
        sorted[sorted.len() - 1],
        busy * 100.0
    );
    Ok(())
}
