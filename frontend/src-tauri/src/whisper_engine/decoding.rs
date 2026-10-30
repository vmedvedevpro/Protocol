//! How a Whisper call decodes, per caller.
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
    /// long piece, which the beam avoids.
    pub const POST_MEETING: Self = Self::BeamSearch { beam_size: 5 };

    pub fn full_params<'a, 'b>(self) -> FullParams<'a, 'b> {
        let strategy = match self {
            Self::Greedy => SamplingStrategy::Greedy { best_of: 1 },
            Self::BeamSearch { beam_size } => SamplingStrategy::BeamSearch { beam_size, patience: 1.0 },
        };
        let mut params = FullParams::new(strategy);
        params.set_temperature(0.0);
        params
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // whisper-rs keeps the C parameters private; their Debug output is the
    // only view of what a call passes to whisper.cpp.
    fn debug(decoding: WhisperDecoding) -> String {
        format!("{:?}", decoding.full_params())
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
}
