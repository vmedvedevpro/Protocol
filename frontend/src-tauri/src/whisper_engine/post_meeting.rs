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

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, Result};
use log::warn;
use whisper_rs::{FullParams, WhisperContext, WhisperError, WhisperState};

use super::decoding::WhisperDecoding;
use super::WhisperEngine;

/// `whisper_full_with_state` returns this when it cannot re-create the KV cache
/// for more than one decoder, after freeing the caller's state itself
/// (whisper.cpp 1.8.3, still so in 1.9.5). whisper-rs frees the state again
/// when it is dropped, so on this error the state is leaked instead. The leak
/// also keeps the model loaded until the app restarts: a whisper-rs state holds
/// a reference to its model context (private fields), so unloading or
/// switching the model then frees nothing. Remove the leak once whisper.cpp
/// stops freeing the caller's state or whisper-rs stops freeing it again.
const KV_CACHE_RECREATE_FAILED: i32 = -7;

/// Set by the first [`KV_CACHE_RECREATE_FAILED`] of this app session. Every
/// later post-meeting pass then decodes greedily from its first piece: the
/// leaked model stays in memory, so a later pass would have less room for the
/// beam's cache than the one that failed, and each failure would leak one
/// more copy of the model (the engine reloads it for the next pass). With the
/// flag the model is leaked at most once per app session. It is not keyed by
/// model, because any model loaded after the leak shares the device with it.
static BEAM_CACHE_FAILED: AtomicBool = AtomicBool::new(false);

/// The decoding a new pass starts with.
fn session_decoding(beam_cache_failed: bool) -> WhisperDecoding {
    if beam_cache_failed {
        WhisperDecoding::Greedy
    } else {
        WhisperDecoding::POST_MEETING
    }
}

/// Records a beam cache failure; true the first time in the session.
fn note_beam_cache_failure(flag: &AtomicBool) -> bool {
    !flag.swap(true, Ordering::SeqCst)
}

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

/// The Whisper side of one post-meeting pass.
///
/// Each piece gets a new whisper.cpp state. whisper.cpp's beam search draws
/// its candidates from each decoder's sampler even at temperature 0
/// (`whisper_sample_token_topk`), and decoder 0's sampler is seeded only when
/// a state is created; on a shared state a piece's text would depend on the
/// pieces decoded before it (the same audio decoded twice on one state ended
/// two segments 20 ms apart). The cost: every piece grows its state's KV
/// cache to 7 decoder slots (beam 5 plus 2 against fragmentation: about 73 MB
/// for Turbo, 587 MB for Large V3, against 84 MB for one Large V3 decoder).
///
/// When that allocation fails, the piece and everything after it until the
/// app restarts decode greedily with one decoder, which never grows the cache
/// ([`BEAM_CACHE_FAILED`]; see [`KV_CACHE_RECREATE_FAILED`] for what the
/// failure leaves behind).
pub struct PostMeetingWhisper<'a> {
    engine: &'a WhisperEngine,
    decoding: WhisperDecoding,
}

impl<'a> PostMeetingWhisper<'a> {
    pub fn new(engine: &'a WhisperEngine) -> Self {
        Self { engine, decoding: session_decoding(BEAM_CACHE_FAILED.load(Ordering::SeqCst)) }
    }

    /// Transcribes one piece. `language` follows the app's setting: `None` or
    /// "auto" detects it in this call, "auto-translate" detects and translates
    /// to English.
    pub async fn transcribe_piece(
        &mut self,
        samples: &[f32],
        language: Option<&str>,
        initial_prompt: Option<&str>,
    ) -> Result<Vec<TimedText>> {
        let Self { engine, decoding } = self;
        engine
            .with_loaded_context(|ctx| transcribe_piece_with(ctx, decoding, samples, language, initial_prompt))
            .await
    }
}

impl WhisperEngine {
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

    /// One call of the measurement kit's reference (`crate::measure`, #62's
    /// REF-u): the pass's beam search on one utterance, without timestamps,
    /// so that the model reads it as one text. A beam's KV cache that cannot
    /// be allocated fails the call instead of turning the decoding greedy,
    /// so a reference never mixes decodings. The text skips the pass's
    /// repetition cleanup: the kit reports the repeats a reference has
    /// instead of hiding them.
    #[cfg(test)]
    pub(crate) async fn reference_text(
        &self,
        samples: &[f32],
        language: Option<&str>,
        initial_prompt: Option<&str>,
    ) -> Result<String> {
        self.with_loaded_context(|ctx| {
            let prompt_tokens = WhisperEngine::tokenize_initial_prompt(ctx, initial_prompt)?;
            let params = piece_params(WhisperDecoding::POST_MEETING, &prompt_tokens, language, false);
            let texts = decode_on_new_state(ctx, params, samples, |state| {
                state
                    .as_iter()
                    .filter_map(|segment| segment.to_str_lossy().ok().map(|text| text.trim().to_string()))
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
            })?
            .ok_or_else(|| anyhow!("whisper.cpp could not allocate the KV cache for the reference's beam"))?;
            Ok(texts.join(" "))
        })
        .await
    }
}

/// One call on a new state, its result read by `read`; `None` when
/// whisper.cpp could not allocate the KV cache for the decoders, in which case
/// the state is leaked (see [`KV_CACHE_RECREATE_FAILED`]).
fn decode_on_new_state<T>(
    ctx: &WhisperContext,
    params: FullParams,
    samples: &[f32],
    read: impl FnOnce(&WhisperState) -> T,
) -> Result<Option<T>> {
    let mut state = ctx.create_state()?;
    match state.full(params, samples) {
        Ok(_) => Ok(Some(read(&state))),
        Err(WhisperError::GenericError(KV_CACHE_RECREATE_FAILED)) => {
            std::mem::forget(state);
            Ok(None)
        }
        Err(error) => Err(anyhow!("decoding a {:.1}s piece failed: {error}", samples.len() as f64 / 16_000.0)),
    }
}

fn transcribe_piece_with(
    ctx: &WhisperContext,
    decoding: &mut WhisperDecoding,
    samples: &[f32],
    language: Option<&str>,
    initial_prompt: Option<&str>,
) -> Result<Vec<TimedText>> {
    let prompt_tokens = WhisperEngine::tokenize_initial_prompt(ctx, initial_prompt)?;
    loop {
        match decode_on_new_state(ctx, piece_params(*decoding, &prompt_tokens, language, true), samples, timed_segments)? {
            Some(segments) => return Ok(segments),
            None => {
                if *decoding == WhisperDecoding::Greedy {
                    return Err(anyhow!("whisper.cpp could not allocate the KV cache for one decoder"));
                }
                if note_beam_cache_failure(&BEAM_CACHE_FAILED) {
                    warn!(
                        "whisper.cpp could not allocate the KV cache for {:?}; post-meeting passes decode greedily \
                         with one decoder until the app restarts, and this model stays loaded until then",
                        decoding
                    );
                }
                *decoding = WhisperDecoding::Greedy;
            }
        }
    }
}

fn piece_params<'a, 'b>(
    decoding: WhisperDecoding,
    prompt_tokens: &'b [whisper_rs::WhisperTokenId],
    language: Option<&'a str>,
    timestamps: bool,
) -> FullParams<'a, 'b> {
    let mut params = decoding.call_params(language);
    if !prompt_tokens.is_empty() {
        params.set_tokens(prompt_tokens);
    }
    params.set_no_timestamps(!timestamps);
    params
}

fn timed_segments(state: &WhisperState) -> Vec<TimedText> {
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
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn after_a_beam_cache_failure_later_passes_start_greedy() {
        assert_eq!(session_decoding(false), WhisperDecoding::POST_MEETING);
        assert_eq!(session_decoding(true), WhisperDecoding::Greedy);
    }

    #[test]
    fn only_the_first_beam_cache_failure_of_a_session_is_reported() {
        let flag = AtomicBool::new(false);
        assert!(note_beam_cache_failure(&flag));
        assert!(!note_beam_cache_failure(&flag));
        assert!(flag.load(Ordering::SeqCst));
    }
}
