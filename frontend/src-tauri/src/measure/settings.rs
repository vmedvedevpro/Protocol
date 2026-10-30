//! The settings a run compares, and the loop that transcribes a recording
//! with one of them as its path does.

use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};

use super::engines::Engines;
use super::input::{Inputs, Span};
use super::output::{PieceResult, Row, Run, Timing, TrackInfo, FORMAT};
use super::tracks::{Cut, Piece, Track};
use super::{ms_since, SAMPLES_PER_MS};
use crate::audio::post_meeting::{self, Pass, PieceOutcome};
use crate::audio::transcription::worker::{is_digital_silence, peak_level};
use crate::audio::vad::{ContinuousSpeechCap, SpeechSegment};
use crate::whisper_engine::decoding::WhisperDecoding;
use crate::whisper_engine::WhisperEngine;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Setting {
    /// The post-meeting pass with Whisper (retranscription and import): pieces
    /// from pause to pause, rows from Whisper's segments.
    PostMeeting,
    /// The live Whisper call on the batch VAD's capped pieces, one row per
    /// piece. The live pipeline cuts its own pieces while recording; that VAD
    /// is not reproduced, only the call and pieces of live size.
    Live,
    /// The post-meeting pass with Parakeet: capped pieces, one row each.
    Parakeet,
    /// The reference transcript (`build_reference`), not a compared setting.
    Reference,
}

impl Setting {
    /// The compared settings named in `MEASURE_SETTINGS`, in order;
    /// `post-meeting,live` when it is unset.
    pub fn list(names: Option<&str>) -> Result<Vec<Self>> {
        let settings = names
            .unwrap_or("post-meeting,live")
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| match name {
                "post-meeting" => Ok(Self::PostMeeting),
                "live" => Ok(Self::Live),
                "parakeet" => Ok(Self::Parakeet),
                other => Err(anyhow!("MEASURE_SETTINGS names {other:?}: use post-meeting, live or parakeet")),
            })
            .collect::<Result<Vec<_>>>()?;
        if settings.is_empty() {
            bail!("MEASURE_SETTINGS names no setting");
        }
        Ok(settings)
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::PostMeeting => "post-meeting",
            Self::Live => "live",
            Self::Parakeet => "parakeet",
            Self::Reference => "reference",
        }
    }

    pub fn uses_whisper(self) -> bool {
        self != Self::Parakeet
    }

    /// The reference takes the post-meeting pass's pieces: one call per
    /// utterance from pause to pause.
    pub fn cap(self) -> ContinuousSpeechCap {
        match self {
            Self::PostMeeting | Self::Reference => post_meeting::vad_cap(false),
            Self::Parakeet => post_meeting::vad_cap(true),
            Self::Live => ContinuousSpeechCap::Streaming,
        }
    }
}

/// The live worker skips only digital silence.
fn live_skip_reason(samples: &[f32]) -> Option<&'static str> {
    is_digital_silence(peak_level(samples)).then_some("silent")
}

/// How one setting turns a piece into rows.
enum Call<'a> {
    /// Retranscription's loop (`post_meeting::Pass`) with its
    /// silence-hallucination filter: the post-meeting setting with Whisper,
    /// and Parakeet.
    Pass(Pass<'a, &'static str>),
    /// The live worker's call: the language setting in every call, one row
    /// per piece.
    Live(&'a WhisperEngine),
    /// One reference call per utterance (`WhisperEngine::reference_text`)
    /// after the pass's skip rule; the pass only detects the language.
    Reference(Pass<'a, &'static str>, &'a WhisperEngine),
}

impl<'a> Call<'a> {
    fn new(setting: Setting, engines: &'a Engines, inputs: &Inputs) -> Result<Self> {
        let whisper = engines.whisper.as_ref().map(|loaded| &loaded.engine).context("no Whisper model is loaded");
        let pass = |parakeet, whisper| {
            Pass::new(parakeet, whisper, Some(inputs.language.as_str()), inputs.vocabulary.as_deref())
        };
        Ok(match setting {
            Setting::PostMeeting => Self::Pass(pass(None, Some(whisper?)).dropping_silence_hallucinations()),
            Setting::Parakeet => {
                let parakeet = engines.parakeet.as_ref().map(|loaded| &loaded.engine).context("no Parakeet model is loaded")?;
                Self::Pass(pass(Some(parakeet), None).dropping_silence_hallucinations())
            }
            Setting::Live => Self::Live(whisper?),
            Setting::Reference => {
                let whisper = whisper?;
                Self::Reference(pass(None, Some(whisper)), whisper)
            }
        })
    }

    /// On Auto, detects each track's language on `pieces` as retranscription
    /// does before its loop; false when the setting's path does not (live
    /// calls detect it in every call).
    async fn detect_languages(&mut self, pieces: &[Piece]) -> bool {
        match self {
            Self::Pass(pass) | Self::Reference(pass, _) if pass.detects_language() => {
                pass.detect_languages(pieces.iter().map(|(segment, track)| (segment, *track)), || false).await;
                true
            }
            _ => false,
        }
    }

    fn detected_language(&self, track: &'static str) -> Option<String> {
        match self {
            Self::Pass(pass) | Self::Reference(pass, _) => pass.detected_language(track).map(str::to_string),
            Self::Live(_) => None,
        }
    }

    async fn transcribe(&mut self, piece: &SpeechSegment, track: &'static str, inputs: &Inputs) -> Result<PieceOutcome> {
        let whole_piece = |text: String| {
            let text = text.trim().to_string();
            if text.is_empty() {
                Vec::new()
            } else {
                vec![(text, piece.start_timestamp_ms, piece.end_timestamp_ms)]
            }
        };
        let vocabulary = inputs.vocabulary.as_deref();
        match self {
            Self::Pass(pass) => pass.transcribe(piece, track).await,
            Self::Live(engine) => {
                if let Some(reason) = live_skip_reason(&piece.samples) {
                    return Ok(PieceOutcome::Skipped(reason));
                }
                let (text, _, _) = engine
                    .transcribe_audio_with_confidence(piece.samples.clone(), Some(inputs.language.clone()), vocabulary)
                    .await?;
                Ok(PieceOutcome::Rows(whole_piece(text)))
            }
            Self::Reference(pass, engine) => {
                if let Some(reason) = post_meeting::skip_reason(&piece.samples) {
                    return Ok(PieceOutcome::Skipped(reason));
                }
                let text = engine.reference_text(&piece.samples, pass.language(track), vocabulary).await?;
                Ok(PieceOutcome::Rows(whole_piece(text)))
            }
        }
    }

    /// The Whisper decoding of the last piece. The pass turns greedy for the
    /// rest of the process when a beam's KV cache cannot be allocated; a
    /// reference call fails instead.
    fn decoding(&self) -> Option<WhisperDecoding> {
        match self {
            Self::Pass(pass) => pass.whisper_decoding(),
            Self::Live(_) => Some(WhisperDecoding::LIVE),
            Self::Reference(..) => Some(WhisperDecoding::POST_MEETING),
        }
    }
}

fn decoding_name(decoding: WhisperDecoding) -> String {
    match decoding {
        WhisperDecoding::Greedy => "greedy".to_string(),
        WhisperDecoding::BeamSearch { beam_size } => format!("beam {beam_size}"),
    }
}

/// Transcribes the recording with one setting, as its path would: on Auto
/// the language once per track from all of `cut`'s pieces, then the pieces
/// that reach into the span, each through the setting's call. Before the
/// timed loop the first piece that is not skipped is decoded once untimed:
/// the first call pays the GPU's set-up, and the first beam search its cache
/// shapes.
pub async fn run(
    setting: Setting,
    engines: &Engines,
    tracks: &[Track],
    cut: &Cut,
    span: Option<Span>,
    inputs: &Inputs,
) -> Result<Run> {
    debug_assert_eq!(cut.cap, setting.cap());
    let mut timing = Timing { vad_ms: cut.vad_ms, ..Timing::default() };
    let mut call = Call::new(setting, engines, inputs)?;
    let started = Instant::now();
    if call.detect_languages(&cut.pieces).await {
        timing.detection_ms = ms_since(started);
    }

    let measured: Vec<(&SpeechSegment, &'static str)> = cut
        .pieces
        .iter()
        .map(|(segment, track)| (segment, *track))
        .filter(|(segment, _)| {
            span.map_or(true, |span| span.overlaps(segment.start_timestamp_ms, segment.end_timestamp_ms))
        })
        .collect();

    let started = Instant::now();
    for &(segment, track) in &measured {
        let outcome = call.transcribe(segment, track, inputs).await.context("the warm-up call")?;
        if !matches!(outcome, PieceOutcome::Skipped(_)) {
            break;
        }
    }
    timing.warmup_ms = ms_since(started);

    let mut results = Vec::with_capacity(measured.len());
    for (index, &(segment, track)) in measured.iter().enumerate() {
        let started = Instant::now();
        let outcome = call
            .transcribe(segment, track, inputs)
            .await
            .with_context(|| format!("{} piece at {:.1} s", setting.name(), segment.start_timestamp_ms / 1000.0))?;
        let wall_ms = ms_since(started);
        let mut result = PieceResult {
            track,
            start_ms: segment.start_timestamp_ms,
            end_ms: segment.end_timestamp_ms,
            skipped: None,
            dropped: false,
            decoding: None,
            wall_ms: 0.0,
            rows: Vec::new(),
        };
        let rows = match outcome {
            PieceOutcome::Skipped(reason) => {
                result.skipped = Some(reason);
                Vec::new()
            }
            PieceOutcome::Dropped(rows) => {
                result.dropped = true;
                rows
            }
            PieceOutcome::Rows(rows) => rows,
        };
        if result.skipped.is_none() {
            result.wall_ms = wall_ms;
            result.decoding = call.decoding().map(decoding_name);
            timing.transcription_ms += wall_ms;
            timing.speech_ms += segment.samples.len() as f64 / SAMPLES_PER_MS;
        }
        result.rows =
            rows.into_iter().map(|(text, start_ms, end_ms)| Row { start_ms, end_ms, text, speakers: None }).collect();
        results.push(result);
        if (index + 1) % 50 == 0 {
            log::info!("{}: {}/{} pieces", setting.name(), index + 1, measured.len());
        }
    }

    let loaded_model = match setting {
        Setting::Parakeet => engines.parakeet.as_ref().map(|p| (p.model.clone(), p.acceleration)),
        _ => engines.whisper.as_ref().map(|w| (w.model.clone(), w.acceleration)),
    };
    let (model, acceleration) = loaded_model.context("no model is loaded")?;
    Ok(Run {
        format: FORMAT,
        setting: setting.name(),
        model,
        acceleration,
        optimized: !cfg!(debug_assertions),
        language: inputs.language.clone(),
        vocabulary: inputs.vocabulary.is_some(),
        vocabulary_sha256: inputs.vocabulary_sha256(),
        whisper_strict_silence: setting.uses_whisper() && crate::whisper_engine::labs::strict_silence_enabled(),
        span_ms: span.map(|span| [span.start_ms, span.end_ms]),
        tracks: tracks
            .iter()
            .map(|track| TrackInfo {
                label: track.label,
                speaker_hint: track.speaker_hint,
                audio: track.audio.clone(),
                language: call.detected_language(track.label),
            })
            .collect(),
        timing,
        pieces: results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_compared_settings_are_read_in_order() {
        assert_eq!(Setting::list(None).unwrap(), [Setting::PostMeeting, Setting::Live]);
        assert_eq!(Setting::list(Some(" parakeet, post-meeting ")).unwrap(), [Setting::Parakeet, Setting::PostMeeting]);
        assert!(Setting::list(Some("reference")).is_err());
        assert!(Setting::list(Some(",")).is_err());
    }

    #[test]
    fn each_setting_cuts_the_pieces_its_pass_transcribes() {
        assert_eq!(Setting::PostMeeting.cap(), ContinuousSpeechCap::PauseToPause);
        assert_eq!(Setting::Reference.cap(), ContinuousSpeechCap::PauseToPause);
        assert_eq!(Setting::Parakeet.cap(), ContinuousSpeechCap::Streaming);
        assert_eq!(Setting::Live.cap(), ContinuousSpeechCap::Streaming);
    }

    #[test]
    fn the_live_setting_skips_only_digital_silence() {
        // The pass skips this quiet piece (`post_meeting::skip_reason`); the live worker sends it.
        assert_eq!(live_skip_reason(&[0.001; 16_000]), None);
        assert_eq!(live_skip_reason(&[0.0; 16_000]), Some("silent"));
    }

    #[test]
    fn a_decoding_is_named_as_the_docs_name_it() {
        assert_eq!(decoding_name(WhisperDecoding::POST_MEETING), "beam 5");
        assert_eq!(decoding_name(WhisperDecoding::LIVE), "greedy");
    }
}
