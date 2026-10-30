//! How the post-meeting pass (retranscription and import) calls Whisper: one
//! pause-bounded VAD piece per call, decoded with timestamps, and the language
//! detected once with its probability (#62).
//!
//! Why timestamps. A piece runs from pause to pause (up to about 28 s, see
//! `audio::post_meeting`). Decoding without timestamps, Large V3 Turbo puts
//! more than 0.2 of its probability on end-of-text while the speech goes on,
//! 12 to 25 s into a window: forced through a reference transcript of 34
//! windows of 15–28 s from a recorded meeting, it did so in 21, alike with
//! q5_0, q8_0 and f16 weights, on Vulkan and on the CPU, in whisper.cpp 1.7.1
//! and 1.8.3 (Large V3: 4, each in the last few words). Without timestamps
//! whisper.cpp then ends the call and the rest of the window is lost. With
//! timestamps the model closes each segment with a timestamp, and when it
//! starts another one that does not fit, whisper.cpp decodes the rest of the
//! audio from the last timestamp, as OpenAI's Whisper does. The segments'
//! times become the transcript rows. Turbo can still skip speech by closing a
//! segment long after its last word: 4 stretches of 14–21 words in 20 minutes
//! of the measured meeting (development map, #62).

use anyhow::{anyhow, Result};
use whisper_rs::{WhisperContext, WhisperError};

use super::decoding::WhisperDecoding;
use super::WhisperEngine;

/// Longest output segment in bytes (`max_len` counts bytes, not characters).
/// Segments wrap only before a word: a byte wrap inside a Cyrillic word would
/// split it across two rows.
const MAX_SEGMENT_BYTES: i32 = 200;

/// `whisper_full_with_state` returns this when it cannot re-create the KV cache
/// for more than one decoder, after freeing the caller's state itself
/// (whisper.cpp 1.8.3, still so in 1.9.5). whisper-rs frees the state again
/// when it is dropped, so on this error the state must be leaked instead.
const KV_CACHE_RECREATE_FAILED: i32 = -7;

/// whisper.cpp's default thread count (`whisper_full_default_params`), which
/// the transcription calls keep; the detection's mel and encoder pass use it
/// too.
fn whisper_threads() -> usize {
    std::thread::available_parallelism().map_or(4, |n| n.get().min(4))
}

/// One Whisper segment of a piece, timed from the start of the piece.
#[derive(Debug, Clone, PartialEq)]
pub struct TimedText {
    pub start_ms: f64,
    pub end_ms: f64,
    pub text: String,
}

impl WhisperEngine {
    /// Transcribes one post-meeting piece. `language` follows the app's
    /// setting: `None` or "auto" detects it in this call, "auto-translate"
    /// detects and translates to English.
    pub async fn transcribe_piece(
        &self,
        samples: &[f32],
        language: Option<&str>,
        initial_prompt: Option<&str>,
    ) -> Result<Vec<TimedText>> {
        self.with_loaded_context(|ctx| transcribe_piece_with(ctx, samples, language, initial_prompt))
            .await
    }

    /// The language whisper.cpp detects in the first 30 s of `samples`, with
    /// its probability: one encoder pass, no decoding.
    pub async fn detect_language_with_probability(&self, samples: &[f32]) -> Result<Option<(String, f32)>> {
        self.with_loaded_context(|ctx| {
            let threads = whisper_threads();
            let mut state = ctx.create_state()?;
            state.pcm_to_mel(samples, threads)?;
            let (id, probabilities) = state.lang_detect(0, threads)?;
            Ok(whisper_rs::get_lang_str(id)
                .map(|language| (language.to_string(), probabilities.get(id as usize).copied().unwrap_or(0.0))))
        })
        .await
    }
}

fn transcribe_piece_with(
    ctx: &WhisperContext,
    samples: &[f32],
    language: Option<&str>,
    initial_prompt: Option<&str>,
) -> Result<Vec<TimedText>> {
    let prompt_tokens = WhisperEngine::tokenize_initial_prompt(ctx, initial_prompt)?;
    let mut params = WhisperDecoding::POST_MEETING.full_params();
    if !prompt_tokens.is_empty() {
        params.set_tokens(&prompt_tokens);
    }
    let (language_code, translate) = match language {
        Some("auto") | None => (None, false),
        Some("auto-translate") => (None, true),
        Some(code) => (Some(code), false),
    };
    params.set_language(language_code);
    params.set_translate(translate);
    params.set_no_timestamps(false);
    // Token times place the wraps of long segments.
    params.set_token_timestamps(true);
    params.set_max_len(MAX_SEGMENT_BYTES);
    params.set_split_on_word(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // The live calls' thresholds (`WhisperEngine::transcribe_audio_with_confidence`).
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_max_initial_ts(1.0);
    params.set_entropy_thold(2.4);
    params.set_logprob_thold(-1.0);
    params.set_no_speech_thold(if super::labs::strict_silence_enabled() { 0.45 } else { 0.55 });

    let mut state = ctx.create_state()?;
    if let Err(error) = state.full(params, samples) {
        if matches!(error, WhisperError::GenericError(KV_CACHE_RECREATE_FAILED)) {
            std::mem::forget(state);
        }
        return Err(anyhow!("Whisper failed on a {:.1}s piece: {error}", samples.len() as f64 / 16_000.0));
    }

    let mut rows = Vec::new();
    for segment in state.as_iter() {
        let Ok(text) = segment.to_str_lossy() else { continue };
        let text = WhisperEngine::clean_repetitive_text(text.trim());
        if text.is_empty() {
            continue;
        }
        // whisper.cpp times segments in units of 10 ms.
        rows.push(TimedText {
            start_ms: segment.start_timestamp() as f64 * 10.0,
            end_ms: segment.end_timestamp() as f64 * 10.0,
            text,
        });
    }
    Ok(rows)
}
