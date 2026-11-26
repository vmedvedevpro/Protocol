//! How the Speech check scores a model's output on the sample (#233).
//!
//! The scores flag broken output, not quality: an engine that runs but
//! writes nothing, loops, answers in the wrong language or turns the sample
//! into noise. The thresholds therefore sit far from both ends: well above
//! what the models score on the clean read speech of the sample, and well
//! below what broken output scores.

use serde::{Deserialize, Serialize};

/// The most word errors per reference word a transcript may have and pass.
///
/// Measured on this sample (Core Ultra X7 358H, Arc B390, Kubuntu 26.10,
/// 2026-11-26, the debug test build), Russian and English: Whisper Large V3
/// Turbo 0.000 and 0.000 on OpenVINO GPU and on whisper.cpp's Vulkan, and
/// Parakeet v3 int8 live 0.000 and 0.000 on the processor, each turn a live
/// piece of its own now that the turns are 1.2 s apart. Broken output scores
/// near or above 1.0: an empty transcript is 1.0 (every word deleted),
/// another language about 1.0 (every word substituted), a repetition loop
/// over 1.0 (insertions), noise near 1.0. Half the words wrong is far from
/// both, and leaves room for a device that decodes a little worse.
pub const MAX_WORD_ERROR_RATE: f64 = 0.5;

/// The least share of the speech a speaker model labels that must go to the
/// right voice.
///
/// The share counts only what the model labels inside the sample's turns, so
/// the pauses within a reading, which no model labels, cost nothing. Measured
/// on this sample (Core Ultra X7 358H, 2026-11-26), Pyannote and Nemotron
/// labelled every second with the right voice: 1.00 on both clips. A model
/// that hears one speaker everywhere scores the longer voice's part, at most
/// 0.62 here (Russian: 11.9 of 19.0 s); a few hundred milliseconds late at
/// each of the three turn changes cost a working model under 0.1. Three
/// quarters is far from both.
pub const MIN_SPEAKER_SHARE: f64 = 0.75;

/// The least share of the sample's turns a speaker model must label at all.
///
/// The turns run from a reading's first word to its last, pauses included;
/// measured on this sample the models labelled 0.78 to 0.85 of them, the rest
/// being those pauses and a reading's quiet lead-in. A model that labels
/// under half of the speech misses whole turns, which the share alone would
/// not show.
pub const MIN_SPEAKER_COVERAGE: f64 = 0.5;

/// The highest real-time factor (processing time over audio time) at which
/// the live model keeps up with a meeting.
///
/// A recording transcribes two sources live, the microphone and the system
/// audio, on one engine, so each may take at most half of real time; the
/// capture threads and the VAD need some of the processor too.
pub const MAX_LIVE_REAL_TIME_FACTOR: f64 = 0.5;

/// The text every comparison works on, as the measuring kit's
/// `kit/text.py` makes it: lower case, "ё" as "е", and every character
/// that is neither a letter nor a digit as a space. The kit also applies
/// NFKC first; the sample's text and the engines' output are composed
/// already, so this leaves it out rather than add a dependency.
pub fn normalize(text: &str) -> String {
    let lowered: String = text.chars().flat_map(char::to_lowercase).map(|ch| if ch == 'ё' { 'е' } else { ch }).collect();
    let kept: String = lowered.chars().map(|ch| if ch.is_alphanumeric() { ch } else { ' ' }).collect();
    kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Word errors of `hypothesis` against `reference`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordErrors {
    pub reference_words: usize,
    pub substitutions: usize,
    pub deletions: usize,
    pub insertions: usize,
}

impl WordErrors {
    /// Errors per reference word; 1.0 for an empty reference with any word
    /// written, 0.0 for both empty.
    pub fn rate(&self) -> f64 {
        let errors = (self.substitutions + self.deletions + self.insertions) as f64;
        if self.reference_words == 0 {
            return if errors > 0.0 { 1.0 } else { 0.0 };
        }
        errors / self.reference_words as f64
    }
}

/// The edit distance between the normalised word lists, with its kinds of
/// errors (Levenshtein; ties prefer a substitution, as jiwer's do).
pub fn word_errors(reference: &str, hypothesis: &str) -> WordErrors {
    let reference: Vec<String> = normalize(reference).split(' ').filter(|w| !w.is_empty()).map(str::to_string).collect();
    let hypothesis: Vec<String> = normalize(hypothesis).split(' ').filter(|w| !w.is_empty()).map(str::to_string).collect();
    let (rows, cols) = (reference.len() + 1, hypothesis.len() + 1);
    // (cost, substitutions, deletions, insertions) per cell.
    let mut table = vec![(0usize, 0usize, 0usize, 0usize); rows * cols];
    for i in 1..rows {
        table[i * cols] = (i, 0, i, 0);
    }
    for j in 1..cols {
        table[j] = (j, 0, 0, j);
    }
    for i in 1..rows {
        for j in 1..cols {
            let diagonal = table[(i - 1) * cols + j - 1];
            let same = reference[i - 1] == hypothesis[j - 1];
            let substitute = if same { diagonal } else { (diagonal.0 + 1, diagonal.1 + 1, diagonal.2, diagonal.3) };
            let up = table[(i - 1) * cols + j];
            let delete = (up.0 + 1, up.1, up.2 + 1, up.3);
            let left = table[i * cols + j - 1];
            let insert = (left.0 + 1, left.1, left.2, left.3 + 1);
            table[i * cols + j] = [substitute, delete, insert].into_iter().min_by_key(|cell| cell.0).expect("three candidates");
        }
    }
    let (_, substitutions, deletions, insertions) = table[rows * cols - 1];
    WordErrors { reference_words: reference.len(), substitutions, deletions, insertions }
}

/// A stretch of speech and who says it: a voice of the sample (`"a"`,
/// `"b"`), or a speaker a model found.
#[derive(Debug, Clone, PartialEq)]
pub struct Turn<L> {
    pub start_ms: f64,
    pub end_ms: f64,
    pub label: L,
}

/// What a speaker model made of the sample.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerScore {
    /// Speakers the model found.
    pub speakers: usize,
    /// Voices in the sample.
    pub voices: usize,
    /// Of the speech the model labelled inside the turns, the share
    /// labelled with its own voice, each found speaker standing for at most
    /// one voice (the pairing that gives the most): a voice split in two
    /// counts only its larger part, and two voices merged count only one.
    pub share: f64,
    /// The share of the turns' time the model labelled with any speaker.
    #[serde(default)]
    pub coverage: f64,
}

fn overlap(a: (f64, f64), b: (f64, f64)) -> f64 {
    (a.1.min(b.1) - a.0.max(b.0)).max(0.0)
}

/// `spans` as the time they cover: overlapping or touching spans become one,
/// so a stretch labelled twice counts once.
fn merged(mut spans: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (start, end) in spans {
        match out.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => out.push((start, end)),
        }
    }
    out
}

/// Scores `found` against the sample's `voices`.
pub fn speaker_score<F: PartialEq + Clone>(voices: &[Turn<&str>], found: &[Turn<F>]) -> SpeakerScore {
    let mut voice_labels: Vec<&str> = Vec::new();
    for turn in voices {
        if !voice_labels.contains(&turn.label) {
            voice_labels.push(turn.label);
        }
    }
    let mut speakers: Vec<F> = Vec::new();
    for turn in found {
        if !speakers.contains(&turn.label) {
            speakers.push(turn.label.clone());
        }
    }
    // Each speaker's spans merged: Nemotron emits overlapping spans of one
    // speaker, which would otherwise count the same speech twice.
    let spans_of = |speaker: &F| merged(found.iter().filter(|other| &other.label == speaker).map(|other| (other.start_ms, other.end_ms)).collect());
    let speaker_spans: Vec<Vec<(f64, f64)>> = speakers.iter().map(spans_of).collect();
    let inside_turns = |spans: &[(f64, f64)]| -> f64 {
        spans.iter().map(|span| voices.iter().map(|turn| overlap((turn.start_ms, turn.end_ms), *span)).sum::<f64>()).sum()
    };
    // Time each found speaker shares with each voice.
    let together = |voice: &str, speaker: usize| -> f64 {
        voices
            .iter()
            .filter(|turn| turn.label == voice)
            .map(|turn| speaker_spans[speaker].iter().map(|span| overlap((turn.start_ms, turn.end_ms), *span)).sum::<f64>())
            .sum()
    };
    let speech: f64 = voices.iter().map(|turn| (turn.end_ms - turn.start_ms).max(0.0)).sum();
    // The share's whole: what each speaker labelled inside the turns (the
    // turns never overlap). Two speakers at one moment both count, as one
    // of them must be wrong: the sample's voices never overlap.
    let labelled: f64 = speaker_spans.iter().map(|spans| inside_turns(spans)).sum();
    // Coverage: the time any speaker labelled inside the turns, counted once.
    let covered = inside_turns(&merged(speaker_spans.concat()));
    // The best one-to-one pairing; the sample has two voices, so trying every
    // assignment of voices to distinct speakers is cheap.
    fn best(voice: usize, voices: &[&str], speakers: usize, used: &mut Vec<bool>, gain: &dyn Fn(usize, usize) -> f64) -> f64 {
        if voice == voices.len() {
            return 0.0;
        }
        // The voice may also get no speaker.
        let mut top = best(voice + 1, voices, speakers, used, gain);
        for speaker in 0..speakers {
            if !used[speaker] {
                used[speaker] = true;
                top = top.max(gain(voice, speaker) + best(voice + 1, voices, speakers, used, gain));
                used[speaker] = false;
            }
        }
        top
    }
    let gain = |voice: usize, speaker: usize| together(voice_labels[voice], speaker);
    let matched = best(0, &voice_labels, speakers.len(), &mut vec![false; speakers.len()], &gain);
    SpeakerScore {
        speakers: speakers.len(),
        voices: voice_labels.len(),
        share: if labelled > 0.0 { (matched / labelled).min(1.0) } else { 0.0 },
        coverage: if speech > 0.0 { (covered / speech).min(1.0) } else { 0.0 },
    }
}

pub fn transcript_passes(errors: &WordErrors) -> bool {
    errors.rate() <= MAX_WORD_ERROR_RATE
}

pub fn speakers_pass(score: &SpeakerScore) -> bool {
    score.share >= MIN_SPEAKER_SHARE && score.coverage >= MIN_SPEAKER_COVERAGE
}

pub fn keeps_up(real_time_factor: f64) -> bool {
    real_time_factor <= MAX_LIVE_REAL_TIME_FACTOR
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn<L>(start_ms: f64, end_ms: f64, label: L) -> Turn<L> {
        Turn { start_ms, end_ms, label }
    }

    #[test]
    fn normalisation_drops_case_punctuation_and_yo() {
        assert_eq!(normalize("Рождество – это ЁЛКА, и \"Christmas\"!"), "рождество это елка и christmas");
        assert_eq!(normalize("  don't\tstop  "), "don t stop");
    }

    #[test]
    fn word_errors_count_each_kind() {
        let errors = word_errors("a b c d", "a x c");
        assert_eq!(errors, WordErrors { reference_words: 4, substitutions: 1, deletions: 1, insertions: 0 });
        assert_eq!(errors.rate(), 0.5);
        assert_eq!(word_errors("a b", "a b c").insertions, 1);
        assert_eq!(word_errors("A, b.", "a b").rate(), 0.0);
    }

    #[test]
    fn broken_output_fails_and_clean_output_passes() {
        let reference = "since students are often the most critical audience the blog writer begins to strive";
        assert!(transcript_passes(&word_errors(reference, "since students are often the most critical audience the blog writer begins to strike")));
        // Empty.
        assert_eq!(word_errors(reference, "").rate(), 1.0);
        assert!(!transcript_passes(&word_errors(reference, "")));
        // The wrong language.
        assert!(!transcript_passes(&word_errors(reference, "поскольку студенты часто самая критичная аудитория блогер начинает стремиться")));
        // A loop.
        let looped = "the blog writer ".repeat(20);
        assert!(word_errors(reference, &looped).rate() > 1.0);
        // Noise.
        assert!(!transcript_passes(&word_errors(reference, "uh")));
    }

    #[test]
    fn an_empty_reference_is_scored_without_dividing_by_zero() {
        assert_eq!(word_errors("", "").rate(), 0.0);
        assert_eq!(word_errors("", "words").rate(), 1.0);
    }

    fn sample() -> Vec<Turn<&'static str>> {
        vec![turn(0.0, 6000.0, "a"), turn(6600.0, 10000.0, "b"), turn(10600.0, 16000.0, "a"), turn(16600.0, 20000.0, "b")]
    }

    #[test]
    fn the_right_voices_score_their_whole_speech() {
        let found = vec![turn(0.0, 6000.0, 1), turn(6600.0, 10000.0, 0), turn(10600.0, 16000.0, 1), turn(16600.0, 20000.0, 0)];
        let score = speaker_score(&sample(), &found);
        assert_eq!((score.speakers, score.voices), (2, 2));
        assert!((score.share - 1.0).abs() < 1e-9);
        assert!((score.coverage - 1.0).abs() < 1e-9);
        assert!(speakers_pass(&score));
    }

    #[test]
    fn pauses_inside_a_turn_cost_nothing_but_coverage() {
        // Each turn's first second is a quiet lead-in the model leaves unlabelled.
        let found = vec![turn(1000.0, 6000.0, 1), turn(7600.0, 10000.0, 0), turn(11600.0, 16000.0, 1), turn(17600.0, 20000.0, 0)];
        let score = speaker_score(&sample(), &found);
        assert!((score.share - 1.0).abs() < 1e-9);
        assert!((score.coverage - 14200.0 / 18200.0).abs() < 1e-9);
        assert!(speakers_pass(&score));
    }

    #[test]
    fn a_model_that_labels_little_fails_on_coverage() {
        let found = vec![turn(0.0, 2000.0, 1), turn(6600.0, 8000.0, 0)];
        let score = speaker_score(&sample(), &found);
        assert!((score.share - 1.0).abs() < 1e-9);
        assert!(!speakers_pass(&score), "{score:?}");
    }

    #[test]
    fn one_speaker_everywhere_scores_the_longer_voice_and_fails() {
        let score = speaker_score(&sample(), &[turn(0.0, 20000.0, 0)]);
        assert_eq!(score.speakers, 1);
        // It labels the turns' 18.2 s, of which voice a has 11.4.
        assert!((score.share - 11400.0 / 18200.0).abs() < 1e-9);
        assert!(!speakers_pass(&score));
        let none: Vec<Turn<usize>> = Vec::new();
        assert_eq!(speaker_score(&sample(), &none).share, 0.0);
    }

    #[test]
    fn overlapping_spans_of_one_speaker_count_once() {
        // Nemotron's windows overlap: each turn comes twice, shifted.
        let once = vec![turn(0.0, 6000.0, 1), turn(6600.0, 10000.0, 0), turn(10600.0, 16000.0, 1), turn(16600.0, 20000.0, 0)];
        let mut twice = once.clone();
        twice.extend([turn(500.0, 5500.0, 1), turn(7000.0, 9000.0, 0), turn(11000.0, 16000.0, 1), turn(16600.0, 19000.0, 0)]);
        assert_eq!(speaker_score(&sample(), &twice), speaker_score(&sample(), &once));
    }

    #[test]
    fn two_speakers_at_one_moment_count_once_for_coverage_and_against_the_share() {
        // Half of the first turn is labelled with both speakers.
        let found = vec![turn(0.0, 6000.0, 1), turn(0.0, 3000.0, 0), turn(6600.0, 10000.0, 0), turn(10600.0, 16000.0, 1), turn(16600.0, 20000.0, 0)];
        let score = speaker_score(&sample(), &found);
        assert!((score.coverage - 1.0).abs() < 1e-9, "{score:?}");
        assert!((score.share - 18200.0 / 21200.0).abs() < 1e-9, "{score:?}");
    }

    #[test]
    fn a_voice_split_in_two_counts_its_larger_part() {
        // Voice a's second turn goes to a third speaker.
        let found = vec![turn(0.0, 6000.0, 0), turn(6600.0, 10000.0, 1), turn(10600.0, 16000.0, 2), turn(16600.0, 20000.0, 1)];
        let score = speaker_score(&sample(), &found);
        assert_eq!(score.speakers, 3);
        assert!((score.share - (6000.0 + 6800.0) / 18200.0).abs() < 1e-9);
    }

    #[test]
    fn swapped_turn_boundaries_cost_only_their_overlap() {
        // The model ends each turn half a second late.
        let found = vec![turn(0.0, 6500.0, 0), turn(6500.0, 10500.0, 1), turn(10500.0, 16500.0, 0), turn(16500.0, 20000.0, 1)];
        let score = speaker_score(&sample(), &found);
        assert!(score.share > 0.95 && speakers_pass(&score), "{score:?}");
    }

    #[test]
    fn the_live_model_keeps_up_at_half_of_real_time() {
        assert!(keeps_up(0.12));
        assert!(keeps_up(MAX_LIVE_REAL_TIME_FACTOR));
        assert!(!keeps_up(0.8));
    }
}
