//! The settings a run compares, and the loop that transcribes a recording
//! with one of them as the post-meeting pass does.

use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};

use super::engines::Engines;
use super::input::Inputs;
use super::output::{PieceResult, Row, Run, Timing, TrackInfo, FORMAT};
use super::tracks::{self, Piece, Track};
use crate::audio::post_meeting::{self, PieceTranscriber};
use crate::audio::retranscription::is_silence_hallucination;
use crate::audio::vad::ContinuousSpeechCap;
use crate::whisper_engine::decoding::WhisperDecoding;
use crate::whisper_engine::post_meeting::KV_CACHE_RECREATE_FAILED;
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
    fn cap(self) -> ContinuousSpeechCap {
        match self {
            Self::PostMeeting | Self::Reference => post_meeting::vad_cap(false),
            Self::Parakeet => post_meeting::vad_cap(true),
            Self::Live => ContinuousSpeechCap::Streaming,
        }
    }

    /// Whether the run detects the language once per track on Auto, as the
    /// post-meeting pass does. Live calls detect it in every call.
    fn detects_per_track(self, language: &str) -> bool {
        matches!(self, Self::PostMeeting | Self::Reference) && post_meeting::detects_once(Some(language))
    }
}

/// How one setting turns a piece into rows (text, start ms, end ms).
enum Call<'a> {
    Pass(PieceTranscriber<'a>),
    Live(&'a WhisperEngine),
    Reference(&'a WhisperEngine),
}

impl<'a> Call<'a> {
    fn new(setting: Setting, engines: &'a Engines) -> Result<Self> {
        let whisper = || {
            engines.whisper.as_ref().map(|loaded| &loaded.engine).ok_or_else(|| anyhow!("no Whisper model is loaded"))
        };
        Ok(match setting {
            Setting::PostMeeting => Self::Pass(PieceTranscriber::new(None, Some(whisper()?))),
            Setting::Parakeet => {
                let parakeet = engines.parakeet.as_ref().ok_or_else(|| anyhow!("no Parakeet model is loaded"))?;
                Self::Pass(PieceTranscriber::new(Some(&parakeet.engine), None))
            }
            Setting::Live => Self::Live(whisper()?),
            Setting::Reference => Self::Reference(whisper()?),
        })
    }

    async fn rows(&mut self, piece: &Piece, language: Option<&str>, vocabulary: Option<&str>) -> Result<Vec<(String, f64, f64)>> {
        let segment = &piece.segment;
        let whole_piece = |text: String| {
            let text = text.trim().to_string();
            if text.is_empty() {
                Vec::new()
            } else {
                vec![(text, segment.start_timestamp_ms, segment.end_timestamp_ms)]
            }
        };
        match self {
            Self::Pass(transcriber) => transcriber.rows(segment, language, vocabulary).await,
            Self::Live(engine) => {
                let (text, _, _) = engine
                    .transcribe_audio_with_confidence(segment.samples.clone(), language.map(str::to_string), vocabulary)
                    .await?;
                Ok(whole_piece(text))
            }
            Self::Reference(engine) => Ok(whole_piece(reference_text(engine, &segment.samples, language, vocabulary).await?)),
        }
    }
}

/// One reference call: the post-meeting decoding (beam search 5 at
/// temperature 0, the shared thresholds and prompt) without timestamps, so
/// the model reads the utterance as one text. A beam's KV cache that cannot be
/// allocated ends the run: whisper.cpp has then freed the state already.
async fn reference_text(
    engine: &WhisperEngine,
    samples: &[f32],
    language: Option<&str>,
    vocabulary: Option<&str>,
) -> Result<String> {
    engine
        .with_loaded_context(|ctx| {
            let prompt = WhisperEngine::tokenize_initial_prompt(ctx, vocabulary)?;
            let mut params = WhisperDecoding::POST_MEETING.call_params(language);
            if !prompt.is_empty() {
                params.set_tokens(&prompt);
            }
            params.set_no_timestamps(true);
            let mut state = ctx.create_state()?;
            match state.full(params, samples) {
                Ok(_) => {}
                Err(whisper_rs::WhisperError::GenericError(KV_CACHE_RECREATE_FAILED)) => {
                    std::mem::forget(state);
                    bail!("the GPU has no room for the beam's KV cache of the reference model");
                }
                Err(error) => return Err(error.into()),
            }
            let texts: Vec<String> = state
                .as_iter()
                .filter_map(|segment| segment.to_str_lossy().ok().map(|text| text.trim().to_string()))
                .filter(|text| !text.is_empty())
                .collect();
            Ok(texts.join(" "))
        })
        .await
}

fn ms_since(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// Transcribes the tracks with one setting, as the post-meeting pass would:
/// the setting's pieces, the language once per track on Auto, the skip rule,
/// and the retranscription loop's silence-hallucination filter. Before the
/// timed loop the setting's first piece is decoded once untimed: the first
/// call pays the GPU's set-up, and the first beam search its cache shapes.
pub async fn run(setting: Setting, engines: &Engines, tracks: &[Track], inputs: &Inputs) -> Result<Run> {
    let mut timing = Timing::default();
    let started = Instant::now();
    let pieces = tracks::pieces(tracks, setting.cap(), inputs.span.as_ref())?;
    timing.vad_ms = ms_since(started);

    let mut track_languages = vec![None; tracks.len()];
    if setting.detects_per_track(&inputs.language) {
        let whisper = &engines.whisper.as_ref().context("no Whisper model is loaded")?.engine;
        let started = Instant::now();
        for (track, language) in
            post_meeting::detect_per_track(whisper, pieces.iter().map(|p| (&p.segment, p.track)), || false).await
        {
            track_languages[track] = Some(language);
        }
        timing.detection_ms = ms_since(started);
    }
    let language_of = |piece: &Piece| track_languages[piece.track].as_deref().or(Some(inputs.language.as_str()));
    let vocabulary = inputs.vocabulary.as_deref();

    let mut call = Call::new(setting, engines)?;
    let transcribed = |piece: &&Piece| post_meeting::skip_reason(&piece.segment.samples).is_none();
    if let Some(first) = pieces.iter().find(transcribed) {
        let started = Instant::now();
        call.rows(first, language_of(first), vocabulary).await?;
        timing.warmup_ms = ms_since(started);
    }

    let mut results = Vec::with_capacity(pieces.len());
    for (index, piece) in pieces.iter().enumerate() {
        let segment = &piece.segment;
        let mut result = PieceResult {
            track: tracks[piece.track].label,
            start_ms: segment.start_timestamp_ms,
            end_ms: segment.end_timestamp_ms,
            skipped: post_meeting::skip_reason(&segment.samples),
            dropped: false,
            wall_ms: 0.0,
            rows: Vec::new(),
        };
        if result.skipped.is_none() {
            let started = Instant::now();
            let rows = call
                .rows(piece, language_of(piece), vocabulary)
                .await
                .with_context(|| format!("{} piece at {:.1} s", setting.name(), segment.start_timestamp_ms / 1000.0))?;
            result.wall_ms = ms_since(started);
            timing.transcription_ms += result.wall_ms;
            timing.speech_ms += segment.samples.len() as f64 / 16.0;
            let text = rows.iter().map(|(text, _, _)| text.trim()).collect::<Vec<_>>().join(" ");
            result.dropped = matches!(setting, Setting::PostMeeting | Setting::Parakeet)
                && is_silence_hallucination(&text, post_meeting::rms(&segment.samples));
            result.rows = rows
                .into_iter()
                .map(|(text, start_ms, end_ms)| Row { start_ms, end_ms, text, speakers: None })
                .collect();
        }
        results.push(result);
        if (index + 1) % 50 == 0 {
            log::info!("{}: {}/{} pieces", setting.name(), index + 1, pieces.len());
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
        vocabulary: vocabulary.is_some(),
        whisper_strict_silence: setting.uses_whisper() && crate::whisper_engine::labs::strict_silence_enabled(),
        span_ms: inputs.span.map(|span| [span.start_ms, span.end_ms]),
        tracks: tracks
            .iter()
            .zip(track_languages)
            .map(|(track, language)| TrackInfo { label: track.label, speaker_hint: track.speaker_hint, language })
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
}
