//! How a Whisper call decodes, per caller, and the parameters every call
//! shares (#62): live calls, the post-meeting pass and the
//! `whisper_transcribe_audio` command differ only in decoding, timestamps and
//! prompt.
//!
//! whisper.cpp (1.8) runs beam search only at temperature 0. Above 0 a
//! `BeamSearch` call is one sampling decoder, because whisper-rs leaves
//! `greedy.best_of` at -1 for that strategy, so the live calls' former
//! hardware-profile decodings (beam 2 at 0.2 on Windows, beam 1–5 at 0.1–0.4
//! elsewhere) all sampled with one decoder (#62). Both decodings here start at
//! temperature 0 and keep whisper.cpp's fallback: a result that fails the
//! entropy or log-probability check is decoded again at +0.2 temperature, up
//! to 1.0, with one sampling decoder.

use whisper_rs::{FullParams, SamplingStrategy};

/// Longest output segment in bytes (`max_len` counts bytes, not characters).
const MAX_SEGMENT_BYTES: i32 = 200;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WhisperDecoding {
    /// The most likely token at each step. `best_of` 1 keeps the fallback on
    /// one decoder, as before: several decoders make whisper.cpp re-create the
    /// KV cache, and the live calls have no guard for its failure (see
    /// `post_meeting::KV_CACHE_RECREATE_FAILED`).
    Greedy,
    BeamSearch { beam_size: i32 },
}

impl WhisperDecoding {
    /// Live transcription on every hardware tier. On the 6 s pieces of a
    /// recorded meeting it was as accurate as the former sampling at 0.2 and a
    /// little faster. Both repeat on the same audio (whisper.cpp seeds its
    /// sampler per state), but greedy takes the most likely token instead of
    /// a seeded draw.
    pub const LIVE: Self = Self::Greedy;

    /// The post-meeting pass (retranscription and import). Five is
    /// whisper.cpp's and OpenAI's default width; greedy decoding with
    /// timestamps can lock into repeating one word segment after segment on a
    /// long piece, which the beam avoids. Unlike OpenAI's, whisper.cpp's beam
    /// draws its candidates from seeded samplers rather than taking the top
    /// ones, so a call repeats only on a new state.
    pub const POST_MEETING: Self = Self::BeamSearch { beam_size: 5 };

    /// Parameters for one call with this decoding. `language` is the app's
    /// setting: `None` or "auto" detects the language in the call,
    /// "auto-translate" detects it and translates to English. The caller
    /// chooses timestamps and the prompt.
    pub fn call_params<'a, 'b>(self, language: Option<&'a str>) -> FullParams<'a, 'b> {
        let strategy = match self {
            Self::Greedy => SamplingStrategy::Greedy { best_of: 1 },
            Self::BeamSearch { beam_size } => SamplingStrategy::BeamSearch { beam_size, patience: 1.0 },
        };
        let mut params = FullParams::new(strategy);
        params.set_temperature(0.0);
        let (language, translate) = language_and_translation(language);
        params.set_language(language);
        params.set_translate(translate);
        // whisper.cpp wraps segments at `max_len` only with token timestamps.
        params.set_token_timestamps(true);
        params.set_max_len(MAX_SEGMENT_BYTES);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        // OpenAI's defaults for the first timestamp and for the entropy and
        // log-probability checks that trigger the temperature fallback.
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_max_initial_ts(1.0);
        params.set_entropy_thold(2.4);
        params.set_logprob_thold(-1.0);
        // Upstream lowered it from 0.75, which dropped quiet speech; Labs'
        // strict silence filter lowers it further.
        params.set_no_speech_thold(if super::labs::strict_silence_enabled() { 0.45 } else { 0.55 });
        params
    }
}

/// whisper.cpp's language and translate flag for the app's language setting.
fn language_and_translation(language: Option<&str>) -> (Option<&str>, bool) {
    match language {
        Some("auto") | None => (None, false),
        Some("auto-translate") => (None, true),
        Some(code) => (Some(code), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // whisper-rs keeps the C parameters private; their Debug output is the
    // only view of what a call passes to whisper.cpp.
    fn debug(decoding: WhisperDecoding) -> String {
        format!("{:?}", decoding.call_params(Some("ru")))
    }

    #[test]
    fn live_decoding_is_greedy_at_temperature_zero_with_one_decoder() {
        let params = debug(WhisperDecoding::LIVE);
        assert!(params.contains("strategy: 0,"), "{params}");
        assert!(params.contains("best_of: 1 }"), "{params}");
        assert!(params.contains("temperature: 0.0,"), "{params}");
    }

    #[test]
    fn post_meeting_decoding_is_a_beam_search_at_temperature_zero() {
        let params = debug(WhisperDecoding::POST_MEETING);
        assert!(params.contains("strategy: 1,"), "{params}");
        assert!(params.contains("beam_size: 5,"), "{params}");
        assert!(params.contains("temperature: 0.0,"), "{params}");
    }

    #[test]
    fn both_decodings_keep_the_temperature_fallback() {
        for decoding in [WhisperDecoding::LIVE, WhisperDecoding::POST_MEETING] {
            let params = debug(decoding);
            assert!(params.contains("temperature_inc: 0.2,"), "{params}");
        }
    }

    #[test]
    fn every_call_shares_the_thresholds_and_the_wrap() {
        for decoding in [WhisperDecoding::LIVE, WhisperDecoding::POST_MEETING] {
            let params = debug(decoding);
            for expected in [
                "token_timestamps: true,",
                "max_len: 200,",
                "max_initial_ts: 1.0,",
                "entropy_thold: 2.4,",
                "logprob_thold: -1.0,",
                "no_speech_thold: 0.55,",
                "suppress_blank: true,",
                "suppress_nst: true,",
            ] {
                assert!(params.contains(expected), "{expected} missing in {params}");
            }
        }
    }

    #[test]
    fn the_language_setting_maps_to_whisper_language_and_translation() {
        assert_eq!(language_and_translation(None), (None, false));
        assert_eq!(language_and_translation(Some("auto")), (None, false));
        assert_eq!(language_and_translation(Some("auto-translate")), (None, true));
        assert_eq!(language_and_translation(Some("ru")), (Some("ru"), false));
    }
}
