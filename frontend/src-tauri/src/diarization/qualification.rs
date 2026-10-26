//! Qualification of Pyannote/WeSpeaker model files on public fixtures
//! (issue #23): diarization error of the post-call pipeline, the live
//! Pyannote path, embedding agreement between two sets of model files, and
//! whether voice profiles learned with one set still match under another.
//!
//! `bundled_embedding_model_keeps_the_voice_profile_space` runs by default and
//! guards saved voice profiles. The comparison is ignored: it needs model
//! files and audio from outside the repository. Set
//!
//! - `PROTOCOL_DIARIZATION_MODELS`: `label=dir` pairs separated by `;`. Each
//!   dir holds the three files under the names `DiarizationModels::load`
//!   expects; the first pair is the baseline the others are compared with.
//! - `PROTOCOL_DIARIZATION_FIXTURES`: a folder of `<name>.wav` (16 kHz mono)
//!   files with `<name>.rttm` reference turns. Speaker names in the RTTM are
//!   taken as the same person across fixtures (AMI participant ids are).
//! - `PROTOCOL_DIARIZATION_ENROLL` (optional): comma-separated fixture names
//!   whose first half of clear turns learns the voices. The other half, and
//!   every turn of the other fixtures, is matched. Default: all fixtures.
//! - `PROTOCOL_DIARIZATION_STAGES` (optional): any of `offline`, `live`,
//!   `embeddings`, `profiles`, comma-separated. Default: all four.
//!
//! and run `cargo test -p protocol --lib --features <platform>
//! diarization::qualification::compare_model_sets -- --ignored --nocapture
//! --test-threads=1`. It prints Markdown tables, and `RESULT` lines with raw
//! frame counts on stderr, so runs of one set each can be combined. The
//! fixtures and results of issue #23 are in `docs/DIARIZATION_MODELS.md`.
//!
//! "Live" feeds each reference turn, in order, to the live Pyannote
//! assignment as a system-path segment. It shows how the embedding model
//! behaves there; the real live path gets VAD segments, not reference turns.

use super::models::DiarizationModels;
use super::voice_profiles::{best_match, VoiceProfile};
use super::{diarize_file_with_models, dsp, online, DiarizationSegment};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const FRAME: f64 = 0.01;
/// Voice profiles learn from and match turns of this length (`voice_profiles.rs`).
const CLEAR_TURN: std::ops::RangeInclusive<f64> = 2.0..=15.0;
/// Turns averaged per voice by the post-call matcher.
const MATCH_TURNS: usize = 8;
/// Turns a profile learns from per meeting.
const LEARN_TURNS: usize = 20;

#[derive(Clone)]
struct Turn {
    start: f64,
    end: f64,
    speaker: String,
}

struct Fixture {
    name: String,
    samples: Vec<f32>,
    turns: Vec<Turn>,
}

fn read_rttm(path: &Path) -> Vec<Turn> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut turns: Vec<Turn> = text
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            (fields.first() == Some(&"SPEAKER")).then(|| {
                let start: f64 = fields[3].parse().unwrap();
                let duration: f64 = fields[4].parse().unwrap();
                Turn { start, end: start + duration, speaker: fields[7].to_string() }
            })
        })
        .collect();
    turns.sort_by(|a, b| a.start.total_cmp(&b.start));
    turns
}

fn load_fixtures(dir: &Path) -> Vec<Fixture> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            (path.extension()? == "rttm" && path.with_extension("wav").is_file())
                .then(|| path.file_stem().unwrap().to_string_lossy().into_owned())
        })
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let (samples, rate) = dsp::read_wav(&dir.join(format!("{name}.wav"))).unwrap();
            assert_eq!(rate, dsp::SAMPLE_RATE, "{name}.wav must be 16 kHz");
            let turns = read_rttm(&dir.join(format!("{name}.rttm")));
            Fixture { name, samples, turns }
        })
        .collect()
}

fn audio<'a>(samples: &'a [f32], start: f64, end: f64) -> &'a [f32] {
    let first = ((start * 16_000.0) as usize).min(samples.len());
    let last = ((end * 16_000.0) as usize).min(samples.len());
    &samples[first..last]
}

/// Turns of the length voice profiles use, with nobody else talking.
fn clear_turns(turns: &[Turn]) -> Vec<Turn> {
    turns
        .iter()
        .filter(|turn| CLEAR_TURN.contains(&(turn.end - turn.start)))
        .filter(|turn| {
            !turns.iter().any(|other| {
                other.speaker != turn.speaker && other.start < turn.end && other.end > turn.start
            })
        })
        .cloned()
        .collect()
}

/// Per-frame sets of active speakers.
fn frames<S: Ord + Clone>(segments: impl Iterator<Item = (f64, f64, S)>, count: usize) -> Vec<BTreeSet<S>> {
    let mut out = vec![BTreeSet::new(); count];
    for (start, end, speaker) in segments {
        let first = (start / FRAME).round().max(0.0) as usize;
        let last = ((end / FRAME).round() as usize).min(count);
        for frame in out.iter_mut().take(last).skip(first) {
            frame.insert(speaker.clone());
        }
    }
    out
}

/// Maximum-weight assignment of rows to columns (Hungarian algorithm on the
/// negated, square-padded matrix). Returns the column of each row.
fn assign(weights: &[Vec<f64>]) -> Vec<Option<usize>> {
    let rows = weights.len();
    let cols = weights.first().map_or(0, Vec::len);
    let n = rows.max(cols);
    if n == 0 {
        return Vec::new();
    }
    let cost = |i: usize, j: usize| -> f64 {
        if i < rows && j < cols { -weights[i][j] } else { 0.0 }
    };
    // Potentials and matching over 1-based indices (e-maxx formulation).
    let (mut u, mut v) = (vec![0.0; n + 1], vec![0.0; n + 1]);
    let (mut p, mut way) = (vec![0usize; n + 1], vec![0usize; n + 1]);
    for i in 1..=n {
        p[0] = i;
        let mut j0 = 0;
        let mut minv = vec![f64::INFINITY; n + 1];
        let mut used = vec![false; n + 1];
        loop {
            used[j0] = true;
            let i0 = p[j0];
            let mut delta = f64::INFINITY;
            let mut j1 = 0;
            for j in 1..=n {
                if !used[j] {
                    let current = cost(i0 - 1, j - 1) - u[i0] - v[j];
                    if current < minv[j] {
                        minv[j] = current;
                        way[j] = j0;
                    }
                    if minv[j] < delta {
                        delta = minv[j];
                        j1 = j;
                    }
                }
            }
            for j in 0..=n {
                if used[j] {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
            if p[j0] == 0 {
                break;
            }
        }
        loop {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
            if j0 == 0 {
                break;
            }
        }
    }
    let mut out = vec![None; rows];
    for j in 1..=n {
        if p[j] >= 1 && p[j] <= rows && j <= cols {
            out[p[j] - 1] = Some(j - 1);
        }
    }
    out
}

#[derive(Default, Clone, Copy)]
struct Der {
    missed: f64,
    false_alarm: f64,
    confusion: f64,
    speech: f64,
}

impl Der {
    fn total(&self) -> f64 {
        (self.missed + self.false_alarm + self.confusion) / self.speech.max(1e-9) * 100.0
    }
    fn part(&self, value: f64) -> f64 {
        value / self.speech.max(1e-9) * 100.0
    }
}

/// Frames to score: all of them, or with a collar, none within `collar`
/// seconds of a reference turn's start or end (the usual 0.25 s forgives
/// boundary placement, which references mark by hand).
fn scored_frames(turns: &[Turn], count: usize, collar: f64) -> Vec<bool> {
    let mut scored = vec![true; count];
    if collar > 0.0 {
        for turn in turns {
            for edge in [turn.start, turn.end] {
                let first = ((edge - collar) / FRAME).round().max(0.0) as usize;
                let last = (((edge + collar) / FRAME).round() as usize).min(count);
                for frame in scored.iter_mut().take(last).skip(first) {
                    *frame = false;
                }
            }
        }
    }
    scored
}

/// Frame-based diarization error rate over the `scored` frames, overlap
/// scored, with the speaker mapping that maximizes the matched time.
fn der<R: Ord + Clone, H: Ord + Clone>(reference: &[BTreeSet<R>], hypothesis: &[BTreeSet<H>], scored: &[bool]) -> Der {
    let ref_ids: Vec<R> = reference.iter().flatten().cloned().collect::<BTreeSet<_>>().into_iter().collect();
    let hyp_ids: Vec<H> = hypothesis.iter().flatten().cloned().collect::<BTreeSet<_>>().into_iter().collect();
    let mut weights = vec![vec![0.0; hyp_ids.len()]; ref_ids.len()];
    let frames = || reference.iter().zip(hypothesis).zip(scored).filter(|(_, &keep)| keep).map(|(pair, _)| pair);
    for (r, h) in frames() {
        for speaker in r {
            let i = ref_ids.binary_search(speaker).unwrap();
            for other in h {
                weights[i][hyp_ids.binary_search(other).unwrap()] += 1.0;
            }
        }
    }
    let mapping = assign(&weights);
    let mut out = Der::default();
    for (r, h) in frames() {
        let (nr, nh) = (r.len() as f64, h.len() as f64);
        let correct = r
            .iter()
            .filter(|speaker| {
                let i = ref_ids.binary_search(speaker).unwrap();
                mapping[i].is_some_and(|j| h.contains(&hyp_ids[j]))
            })
            .count() as f64;
        out.speech += nr;
        out.missed += (nr - nh).max(0.0);
        out.false_alarm += (nh - nr).max(0.0);
        out.confusion += nr.min(nh) - correct;
    }
    out
}

fn segment_frames(segments: &[DiarizationSegment], count: usize) -> Vec<BTreeSet<usize>> {
    frames(segments.iter().map(|s| (s.start as f64, s.end as f64, s.speaker)), count)
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    dot / (na * nb).max(1e-9)
}

fn normalized(sum: Vec<f32>) -> Vec<f32> {
    let norm = sum.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
    sum.into_iter().map(|x| x / norm).collect()
}

fn mean(vectors: &[Vec<f32>]) -> Vec<f32> {
    let mut sum = vec![0.0f32; vectors[0].len()];
    for vector in vectors {
        for (target, value) in sum.iter_mut().zip(vector) {
            *target += value;
        }
    }
    normalized(sum)
}

fn percentile(sorted: &[f32], p: f64) -> f32 {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

fn spread<T: Clone>(items: &[T], count: usize) -> Vec<T> {
    if items.len() <= count {
        return items.to_vec();
    }
    (0..count).map(|index| items[index * items.len() / count].clone()).collect()
}

/// Correct, wrong and unmatched results of matching against `profiles`.
#[derive(Default)]
struct Matches {
    correct: usize,
    wrong: usize,
    none: usize,
}

impl Matches {
    fn add(&mut self, expected: &str, found: Option<&VoiceProfile>) {
        match found {
            Some(profile) if profile.name == expected => self.correct += 1,
            Some(_) => self.wrong += 1,
            None => self.none += 1,
        }
    }
    fn row(&self) -> String {
        let total = (self.correct + self.wrong + self.none).max(1) as f64;
        format!(
            "{} / {} / {} ({:.1}% correct)",
            self.correct,
            self.wrong,
            self.none,
            self.correct as f64 / total * 100.0
        )
    }
}

/// Runs the live Pyannote assignment over the reference turns in order, as
/// system-path VAD segments, and returns turn-level speaker frames.
fn live_frames(models: DiarizationModels, fixture: &Fixture, count: usize) -> (Vec<BTreeSet<usize>>, usize) {
    online::start_with_models(models);
    let mut labelled = Vec::new();
    let mut speakers = BTreeSet::new();
    for turn in &fixture.turns {
        let samples = audio(&fixture.samples, turn.start, turn.end);
        if samples.is_empty() {
            continue;
        }
        if let Some(live) = online::assign_speaker(samples, false) {
            speakers.insert(live.index);
            labelled.push((turn.start, turn.end, live.index));
        }
    }
    online::stop();
    (frames(labelled.into_iter(), count), speakers.len())
}

#[test]
#[ignore = "Needs model files and public fixtures; see the module comment"]
fn compare_model_sets() {
    let sets: Vec<(String, PathBuf)> = std::env::var("PROTOCOL_DIARIZATION_MODELS")
        .expect("PROTOCOL_DIARIZATION_MODELS")
        .split(';')
        .map(|pair| {
            let (label, dir) = pair.split_once('=').expect("label=dir");
            (label.to_string(), PathBuf::from(dir))
        })
        .collect();
    let fixtures = load_fixtures(Path::new(
        &std::env::var("PROTOCOL_DIARIZATION_FIXTURES").expect("PROTOCOL_DIARIZATION_FIXTURES"),
    ));
    let enroll: Option<BTreeSet<String>> = std::env::var("PROTOCOL_DIARIZATION_ENROLL")
        .ok()
        .map(|list| list.split(',').map(|name| name.trim().to_string()).collect());
    let enrolls = |name: &str| enroll.as_ref().is_none_or(|set| set.contains(name));

    let stages = std::env::var("PROTOCOL_DIARIZATION_STAGES")
        .unwrap_or_else(|_| "offline,live,embeddings,profiles".into());
    let stage = |name: &str| stages.split(',').any(|item| item.trim() == name);
    let fixtures_dir = PathBuf::from(std::env::var("PROTOCOL_DIARIZATION_FIXTURES").unwrap());
    let reference_of = |fixture: &Fixture| {
        let count = (fixture.samples.len() as f64 / 16_000.0 / FRAME).ceil() as usize;
        let reference = frames(fixture.turns.iter().map(|t| (t.start, t.end, t.speaker.clone())), count);
        let speakers = fixture.turns.iter().map(|t| &t.speaker).collect::<BTreeSet<_>>().len();
        (count, reference, speakers)
    };

    if stage("offline") {
        const METRICS: [&str; 4] = ["auto", "auto, collar", "oracle", "oracle, collar"];
        println!("\n## Post-call Pyannote pipeline (DER %, overlap scored)\n");
        println!("Auto: speaker count from the default threshold. Oracle: the reference count. Collar: 0.25 s around each reference boundary is not scored.\n");
        println!("| fixture | ref spk | set | spk found | auto | auto, collar | miss / FA / conf (auto) | oracle | oracle, collar | auto vs {} | seconds |", sets[0].0);
        println!("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
        // [set][fixture][metric]
        let mut results: Vec<Vec<[Der; 4]>> = vec![Vec::new(); sets.len()];
        for fixture in &fixtures {
            let (count, reference, speakers) = reference_of(fixture);
            let all = vec![true; count];
            let collar = scored_frames(&fixture.turns, count, 0.25);
            let wav = fixtures_dir.join(format!("{}.wav", fixture.name));
            let mut baseline: Option<Vec<BTreeSet<usize>>> = None;
            for (index, (label, dir)) in sets.iter().enumerate() {
                let started = std::time::Instant::now();
                let auto = diarize_file_with_models(&wav, dir, None, None).unwrap();
                let seconds = started.elapsed().as_secs_f64();
                let oracle = diarize_file_with_models(&wav, dir, Some(speakers), None).unwrap();
                let hyp = segment_frames(&auto.segments, count);
                let oracle_hyp = segment_frames(&oracle.segments, count);
                let scores = [
                    der(&reference, &hyp, &all),
                    der(&reference, &hyp, &collar),
                    der(&reference, &oracle_hyp, &all),
                    der(&reference, &oracle_hyp, &collar),
                ];
                let versus = match &baseline {
                    Some(base) => format!("{:.2}", der(base, &hyp, &all).total()),
                    None => "-".into(),
                };
                if baseline.is_none() {
                    baseline = Some(hyp);
                }
                let auto_der = scores[0];
                println!(
                    "| {} | {} | {} | {} | {:.2} | {:.2} | {:.2} / {:.2} / {:.2} | {:.2} | {:.2} | {} | {:.1} |",
                    fixture.name,
                    speakers,
                    label,
                    auto.num_speakers,
                    scores[0].total(),
                    scores[1].total(),
                    auto_der.part(auto_der.missed),
                    auto_der.part(auto_der.false_alarm),
                    auto_der.part(auto_der.confusion),
                    scores[2].total(),
                    scores[3].total(),
                    versus,
                    seconds
                );
                // Raw frame counts, to combine runs made in separate processes.
                for (name, score) in METRICS.iter().zip(&scores) {
                    eprintln!(
                        "RESULT\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                        fixture.name, label, name, auto.num_speakers, score.missed, score.false_alarm, score.confusion, score.speech
                    );
                }
                results[index].push(scores);
            }
        }
        println!("\n### All fixtures, time-weighted\n");
        println!("| set | {} | miss / FA / conf (auto) |", METRICS.join(" | "));
        println!("| --- | --- | --- | --- | --- | --- |");
        for (index, (label, _)) in sets.iter().enumerate() {
            let mut sums = [Der::default(); 4];
            for scores in &results[index] {
                for (sum, part) in sums.iter_mut().zip(scores) {
                    sum.missed += part.missed;
                    sum.false_alarm += part.false_alarm;
                    sum.confusion += part.confusion;
                    sum.speech += part.speech;
                }
            }
            println!(
                "| {} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} / {:.2} / {:.2} |",
                label,
                sums[0].total(),
                sums[1].total(),
                sums[2].total(),
                sums[3].total(),
                sums[0].part(sums[0].missed),
                sums[0].part(sums[0].false_alarm),
                sums[0].part(sums[0].confusion)
            );
        }
        println!("\n### Per-fixture change against {} (DER points; negative is better)\n", sets[0].0);
        println!("| set | metric | mean change | better / same / worse (0.1 point) | best | worst |");
        println!("| --- | --- | --- | --- | --- | --- |");
        for (index, (label, _)) in sets.iter().enumerate().skip(1) {
            for (metric, name) in METRICS.iter().enumerate() {
                let changes: Vec<f64> = results[index]
                    .iter()
                    .zip(&results[0])
                    .map(|(new, old)| new[metric].total() - old[metric].total())
                    .collect();
                let mean = changes.iter().sum::<f64>() / changes.len() as f64;
                let better = changes.iter().filter(|c| **c < -0.1).count();
                let worse = changes.iter().filter(|c| **c > 0.1).count();
                let best = changes.iter().copied().fold(f64::INFINITY, f64::min);
                let worst = changes.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                println!(
                    "| {} | {} | {:+.2} | {} / {} / {} | {:+.2} | {:+.2} |",
                    label,
                    name,
                    mean,
                    better,
                    changes.len() - better - worse,
                    worse,
                    best,
                    worst
                );
            }
        }
    }

    if stage("live") {
        println!("\n## Live Pyannote path (reference turns fed as system-path segments)\n");
        println!("| fixture | ref spk | set | live speakers | turn-frame DER |");
        println!("| --- | --- | --- | --- | --- |");
        for fixture in &fixtures {
            let (count, reference, speakers) = reference_of(fixture);
            let all = vec![true; count];
            for (label, dir) in &sets {
                let (hyp, live) = live_frames(DiarizationModels::load(dir).unwrap(), fixture, count);
                println!("| {} | {} | {} | {} | {:.2} |", fixture.name, speakers, label, live, der(&reference, &hyp, &all).total());
            }
        }
    }
    if !stage("embeddings") && !stage("profiles") {
        return;
    }

    // Embeddings of every clear turn under each set.
    let mut embedded: Vec<Vec<Vec<Vec<f32>>>> = Vec::new(); // [set][fixture][turn]
    for (_, dir) in &sets {
        let mut models = DiarizationModels::load(dir).unwrap();
        embedded.push(
            fixtures
                .iter()
                .map(|fixture| {
                    clear_turns(&fixture.turns)
                        .iter()
                        .map(|turn| models.embed(audio(&fixture.samples, turn.start, turn.end)).unwrap())
                        .collect()
                })
                .collect(),
        );
    }

    if stage("embeddings") {
        println!("\n## Embedding agreement with {} (cosine of the same clear turn)\n", sets[0].0);
        println!("| set | turns | min | p1 | p5 | median |");
        println!("| --- | --- | --- | --- | --- | --- |");
    }
    for (index, (label, _)) in sets.iter().enumerate().skip(1).filter(|_| stage("embeddings")) {
        let mut values: Vec<f32> = embedded[0]
            .iter()
            .zip(&embedded[index])
            .flat_map(|(base, other)| base.iter().zip(other).map(|(a, b)| cosine(a, b)))
            .collect();
        values.sort_by(f32::total_cmp);
        println!(
            "| {} | {} | {:.6} | {:.6} | {:.6} | {:.6} |",
            label,
            values.len(),
            values[0],
            percentile(&values, 0.01),
            percentile(&values, 0.05),
            percentile(&values, 0.5)
        );
    }

    // Voice profiles: learn from the first half of each voice's clear turns
    // in the enrolment fixtures, match the rest.
    if !stage("profiles") {
        return;
    }
    println!("\n## Voice profiles (correct / wrong / no match; threshold 0.80, margin 0.08)\n");
    println!("| profiles learned with | turns embedded with | live matcher, per turn | post-call matcher, per voice and meeting |");
    println!("| --- | --- | --- | --- |");
    let split = |fixture: &Fixture| -> (Vec<usize>, Vec<usize>) {
        let clear = clear_turns(&fixture.turns);
        let mut learn = Vec::new();
        let mut test = Vec::new();
        let names: BTreeSet<&String> = clear.iter().map(|t| &t.speaker).collect();
        for name in names {
            let own: Vec<usize> = (0..clear.len()).filter(|&i| &clear[i].speaker == name).collect();
            if enrolls(&fixture.name) {
                let half = own.len() / 2;
                learn.extend(spread(&own[..half], LEARN_TURNS));
                test.extend_from_slice(&own[half..]);
            } else {
                test.extend(own);
            }
        }
        (learn, test)
    };
    let pairs: Vec<(usize, usize)> = std::iter::once((0, 0))
        .chain((1..sets.len()).flat_map(|i| [(0, i), (i, i)]))
        .collect();
    for (learned, matched) in pairs {
        let mut sums: BTreeMap<String, Vec<Vec<f32>>> = BTreeMap::new();
        for (f, fixture) in fixtures.iter().enumerate() {
            let clear = clear_turns(&fixture.turns);
            for i in split(fixture).0 {
                sums.entry(clear[i].speaker.clone()).or_default().push(embedded[learned][f][i].clone());
            }
        }
        let profiles: Vec<VoiceProfile> = sums
            .into_iter()
            .filter(|(_, vectors)| vectors.len() >= 2)
            .map(|(name, vectors)| VoiceProfile {
                person_id: name.clone(),
                name,
                embedding: mean(&vectors),
                samples: vectors.len() as u32,
                model: String::new(),
                sources: Vec::new(),
            })
            .collect();
        let known: BTreeSet<&str> = profiles.iter().map(|p| p.name.as_str()).collect();
        let (mut live, mut post) = (Matches::default(), Matches::default());
        for (f, fixture) in fixtures.iter().enumerate() {
            let clear = clear_turns(&fixture.turns);
            let mut per_voice: BTreeMap<&str, Vec<Vec<f32>>> = BTreeMap::new();
            for i in split(fixture).1 {
                let name = clear[i].speaker.as_str();
                if !known.contains(name) {
                    continue;
                }
                let vector = &embedded[matched][f][i];
                live.add(name, best_match(vector, &profiles));
                let entries = per_voice.entry(name).or_default();
                if entries.len() < MATCH_TURNS {
                    entries.push(vector.clone());
                }
            }
            for (name, vectors) in per_voice {
                if vectors.len() >= 2 {
                    post.add(name, best_match(&mean(&vectors), &profiles));
                }
            }
        }
        println!("| {} ({} voices) | {} | {} | {} |", sets[learned].0, profiles.len(), sets[matched].0, live.row(), post.row());
    }
}

/// A fixed voice-like signal: 3 s of a 120 Hz harmonic tone with vibrato, a
/// formant-shaped spectrum and a 4 Hz syllable envelope.
fn synthetic_voice() -> Vec<f32> {
    use std::f32::consts::PI;
    let formant = |f: f32, centre: f32, width: f32| (-((f - centre) / width).powi(2)).exp();
    (0..48_000)
        .map(|n| {
            let t = n as f32 / 16_000.0;
            // Phase of 120 Hz with a 3% vibrato at 5 Hz.
            let phase = 2.0 * PI * 120.0 * t - 120.0 * 0.03 / 5.0 * (2.0 * PI * 5.0 * t).cos();
            let tone: f32 = (1..=30)
                .map(|k| {
                    let f = 120.0 * k as f32;
                    let gain = formant(f, 700.0, 300.0) + 0.6 * formant(f, 1200.0, 400.0) + 0.3 * formant(f, 2500.0, 500.0);
                    gain / k as f32 * (k as f32 * phase).sin()
                })
                .sum();
            0.1 * (0.55 + 0.45 * (2.0 * PI * 4.0 * t).sin()) * tone
        })
        .collect()
}

/// Prints the embedding of [`synthetic_voice`] under each model set, the
/// source of [`PROFILE_SPACE_REFERENCE`].
#[test]
#[ignore = "Needs model files; see the module comment"]
fn print_synthetic_voice_embeddings() {
    for pair in std::env::var("PROTOCOL_DIARIZATION_MODELS").unwrap().split(';') {
        let (label, dir) = pair.split_once('=').unwrap();
        let embedding = DiarizationModels::load(Path::new(dir)).unwrap().embed(&synthetic_voice()).unwrap();
        let values: Vec<String> = embedding.iter().map(|value| format!("{value:.5}")).collect();
        println!("{label}: [{}]", values.join(", "));
    }
}

/// The embedding of [`synthetic_voice`] under the WeSpeaker export Protocol
/// 0.3.0 bundled (`wespeaker-resnet34-LM.onnx`, SHA-256 `992a5632...`), as
/// [`print_synthetic_voice_embeddings`] printed it.
#[rustfmt::skip]
const PROFILE_SPACE_REFERENCE: [f32; 128] = [
    -0.23564, -0.47648, -0.07782, 0.12356, -0.00220, 0.00765, -0.00757, 0.02761,
    -0.12269, 0.16239, -0.06784, 0.18201, -0.09164, 0.01173, -0.04418, -0.04720,
    -0.02879, 0.05769, -0.01904, -0.07470, 0.07043, 0.05253, -0.00075, 0.06605,
    0.01581, -0.10548, 0.06177, -0.01218, 0.08562, -0.02313, -0.02803, -0.02108,
    0.12409, -0.00150, 0.01709, 0.03028, -0.04179, 0.06840, 0.07425, -0.04783,
    0.01636, 0.05579, -0.04058, -0.01100, 0.04634, 0.08708, 0.01042, -0.01519,
    -0.02262, 0.17442, 0.00780, 0.07508, -0.08391, -0.07986, -0.04987, -0.18351,
    -0.05109, 0.02930, -0.08523, -0.01647, 0.14280, -0.09986, 0.02704, -0.02053,
    0.09180, -0.00042, -0.04147, 0.06382, 0.08579, -0.05322, -0.00038, 0.06271,
    0.00992, -0.00940, -0.03589, 0.20194, -0.12502, 0.06812, 0.02645, 0.10010,
    -0.04461, 0.06754, 0.12189, 0.09327, -0.03886, -0.01143, 0.03825, 0.06294,
    -0.06542, -0.03507, 0.04184, -0.00038, 0.04071, 0.02199, 0.08690, 0.06998,
    0.01150, -0.00721, 0.11198, -0.13178, -0.07038, 0.07809, 0.15134, 0.01966,
    -0.07979, -0.00027, 0.04056, -0.01103, -0.04772, 0.08249, 0.18056, -0.01069,
    -0.02674, 0.01990, 0.19402, 0.01831, -0.05682, 0.08205, 0.03582, 0.02064,
    -0.02671, 0.00899, -0.14424, -0.00041, -0.08542, 0.03826, -0.15326, 0.04878,
];

/// Saved voice profiles and the local voiceprint are embeddings tagged only
/// with `voice_profiles::MODEL`, so the bundled embedding model and front-end
/// must keep producing the space they were learned in. Protocol 0.3.0 bundled
/// another export of the same weights; this pins the bundled files to it. A
/// model that fails here needs a new `MODEL` id and a re-enrolment path.
#[test]
fn bundled_embedding_model_keeps_the_voice_profile_space() {
    let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/diarization");
    let embedding = DiarizationModels::load(&bundled).unwrap().embed(&synthetic_voice()).unwrap();
    let similarity = cosine(&embedding, &PROFILE_SPACE_REFERENCE);
    assert!(similarity > 0.9999, "cosine {similarity} to the 0.3.0 embedding");
}

#[test]
fn der_counts_misses_false_alarms_and_confusion_with_the_best_mapping() {
    let reference = frames([(0.0, 1.0, "a"), (1.0, 2.0, "b")].into_iter(), 300);
    // Speaker labels swapped, plus 0.5 s of extra speech at the end.
    let hypothesis = frames([(0.0, 1.0, 7usize), (1.0, 2.5, 3)].into_iter(), 300);
    let all = [true; 300];
    let result = der(&reference, &hypothesis, &all);
    assert_eq!(result.speech, 200.0);
    assert_eq!((result.missed, result.false_alarm, result.confusion), (0.0, 50.0, 0.0));
    let merged = frames([(0.0, 2.0, 1usize)].into_iter(), 300);
    assert_eq!(der(&reference, &merged, &all).confusion, 100.0);
    assert_eq!(assign(&[vec![1.0, 5.0], vec![4.0, 1.0], vec![0.0, 0.0]]), vec![Some(1), Some(0), None]);

    // A 0.25 s collar leaves out 0.25 s on each side of 0, 1 and 2 s.
    let turns = [
        Turn { start: 0.0, end: 1.0, speaker: "a".into() },
        Turn { start: 1.0, end: 2.0, speaker: "b".into() },
    ];
    let collar = scored_frames(&turns, 300, 0.25);
    assert_eq!(collar.iter().filter(|&&keep| !keep).count(), 25 + 50 + 50);
    assert_eq!(der(&reference, &hypothesis, &collar).speech, 100.0);
}
