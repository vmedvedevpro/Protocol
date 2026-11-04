//! Which audio each encoder call sees on the NPU's static shape (#66), and
//! which of its words a row keeps. Ported from #80's
//! `scripts/npu-bench/chunking.py` (its "feed B"), plus the live variant #66
//! measured in phase 1.
//!
//! Every call is one window of at most [`WINDOW_MS`] (the 608 feature frames
//! the encoder is compiled for). Zero-padding a short VAD piece to that shape
//! loses words where the piece ends (#80: the encoder hears speech stopping
//! dead against zeros, most often at the VAD's cap cut), so the NPU path does
//! not decode piece by piece:
//!
//! - A *stretch* is continuous speech of one source: its pieces touching
//!   within [`TOUCH_MS`] (the cap cuts without a gap). A stretch no longer
//!   than a window is one call.
//! - A longer one gets windows every [`HOP_MS`], each after the first started
//!   at the quietest 20 ms within [`SNAP_MS`] of its place, the last one
//!   aligned to the stretch's end ([`plan`]). Neighbours overlap by about
//!   2.5 s, so a word near a junction is heard whole by both calls.
//! - A window of at least 4 s with fewer than 0.5 words per second runs again
//!   0.5 s later (earlier at the stretch's end) and the call with more words
//!   stays: TDT now and then emits nothing for a whole window of speech
//!   ([`decode_with_retry`]).
//! - Two calls are joined on an anchor: a word both decoded the same, at most
//!   [`ANCHOR_MS`] apart, the one nearest the middle of the overlap; without
//!   one, each keeps the words that start on its side of the middle
//!   ([`merge`]).
//! - Each kept word goes to the piece it starts in ([`assign`]), so the rows
//!   stay the VAD's pieces.
//!
//! Live pieces arrive one at a time and the text a row shows is final, so
//! [`Live`] computes the same windows as the stretch grows: words emitted by
//! an earlier piece are never dropped, and when the VAD cut a piece by its cap
//! (the speech goes on) the words of its last [`HOLD_MS`] wait for the next
//! piece's call, which hears them with context on both sides.
//!
//! Times are meeting milliseconds; audio is 16 kHz mono.

use std::borrow::Cow;

/// The audio of one call: the NPU's 608 feature frames (`npu::FRAMES`) less
/// the one `nemo128` adds, 10 ms each.
pub const WINDOW_MS: f64 = 6070.0;
/// Pieces this close are one stretch: the VAD's cap cuts without a gap.
pub const TOUCH_MS: f64 = 50.0;
/// The step between windows of a stretch.
pub const HOP_MS: f64 = 3500.0;
/// How far a window's start moves to the quietest 20 ms.
pub const SNAP_MS: f64 = 500.0;
/// Two calls time the same word within a few 80 ms encoder frames; farther
/// apart, an equal word is another occurrence.
pub const ANCHOR_MS: f64 = 320.0;
/// The live VAD cuts at its cap at the quietest 50 ms of the last second
/// before it (`vad::find_split_point`), so the word there may be cut: the
/// words of that second wait for the next piece.
pub const HOLD_MS: f64 = 1000.0;
/// Live, without an anchor: a new word must start this long after the last
/// one shown, so a word timed a frame or two apart is not shown twice.
pub const NEW_AFTER_MS: f64 = 200.0;
/// The encoder subsamples the 10 ms features 8 times.
pub const ENCODER_FRAME_MS: f64 = 80.0;

const RETRY_MIN_S: f64 = 4.0;
const RETRY_WORDS_PER_S: f64 = 0.5;
const RETRY_SHIFT_MS: f64 = 500.0;
const FRAME_MS: f64 = 20.0;
const SAMPLES_PER_MS: f64 = 16.0;

/// One decoded word: its first token's encoder frame in meeting time, and its
/// text with the leading space of a SentencePiece word start.
#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub start_ms: f64,
    pub text: String,
}

impl Word {
    pub fn new(start_ms: f64, text: &str) -> Self {
        Self { start_ms, text: text.to_string() }
    }
}

/// The audio one call decodes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    pub start_ms: f64,
    pub end_ms: f64,
    /// The index of its stretch among those [`plan`] was given.
    pub stretch: usize,
    /// The stretch's first call: nothing to join before it.
    pub first: bool,
}

/// The words of `tokens` (vocabulary pieces, a space marking a word start),
/// each emitted at the encoder frame in `frames`, for a call whose audio
/// starts at `offset_ms`.
pub fn words(tokens: &[String], frames: &[usize], offset_ms: f64) -> Vec<Word> {
    let mut out: Vec<Word> = Vec::new();
    for (token, frame) in tokens.iter().zip(frames) {
        match out.last_mut() {
            Some(word) if !token.starts_with(' ') => word.text.push_str(token),
            _ => out.push(Word { start_ms: offset_ms + *frame as f64 * ENCODER_FRAME_MS, text: token.clone() }),
        }
    }
    out
}

/// The text of `words` with single spaces, as a row shows it.
pub fn text(words: &[Word]) -> String {
    let joined: String = words.iter().map(|word| word.text.as_str()).collect();
    joined.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The stretches of `pieces` ((start, end) in time order).
pub fn stretches(pieces: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut out: Vec<(f64, f64)> = Vec::new();
    for &(start, end) in pieces {
        match out.last_mut() {
            Some(last) if start - last.1 <= TOUCH_MS => last.1 = end,
            _ => out.push((start, end)),
        }
    }
    out
}

/// The audio of a stretch from its first sample on; reads outside it are
/// silence. Pieces of a stretch touch, so it is their samples end to end,
/// a gap of up to [`TOUCH_MS`] between two of them filled with zeros.
#[derive(Debug, Clone, Default)]
pub struct StretchAudio<'a> {
    /// The meeting sample of `samples[0]`.
    first: i64,
    samples: Cow<'a, [f32]>,
}

fn sample_at(ms: f64) -> i64 {
    (ms * SAMPLES_PER_MS).floor() as i64
}

impl<'a> StretchAudio<'a> {
    /// The audio of one piece.
    pub fn borrowed(start_ms: f64, samples: &'a [f32]) -> Self {
        Self { first: sample_at(start_ms), samples: Cow::Borrowed(samples) }
    }

    /// Appends the piece starting at `start_ms`, filling a gap with zeros. A
    /// piece that overlaps the end overwrites nothing: its first samples are
    /// dropped.
    pub fn push(&mut self, start_ms: f64, samples: &[f32]) {
        let at = sample_at(start_ms);
        if self.samples.is_empty() {
            self.first = at;
        }
        let end = self.first + self.samples.len() as i64;
        let owned = self.samples.to_mut();
        if at > end {
            owned.resize(owned.len() + (at - end) as usize, 0.0);
        }
        let skip = (end - at).max(0) as usize;
        owned.extend_from_slice(samples.get(skip..).unwrap_or_default());
    }

    /// Forgets the audio before `ms`; reads there are silence from now on.
    pub fn forget_before(&mut self, ms: f64) {
        let drop = (sample_at(ms) - self.first).clamp(0, self.samples.len() as i64) as usize;
        if drop > 0 {
            self.samples.to_mut().drain(..drop);
            self.first += drop as i64;
        }
    }

    fn sample(&self, index: i64) -> f32 {
        usize::try_from(index - self.first).ok().and_then(|at| self.samples.get(at)).copied().unwrap_or(0.0)
    }

    /// The samples of [start_ms, end_ms), as #80 sliced them from the track.
    pub fn slice(&self, start_ms: f64, end_ms: f64) -> Vec<f32> {
        (sample_at(start_ms)..sample_at(end_ms)).map(|index| self.sample(index)).collect()
    }

    /// The RMS of the 20 ms frame (of the meeting, from 0) that holds `ms`.
    pub fn energy(&self, ms: f64) -> f64 {
        let frame = (ms / FRAME_MS).floor() as i64;
        let per_frame = (FRAME_MS * SAMPLES_PER_MS) as i64;
        let sum: f64 = (frame * per_frame..(frame + 1) * per_frame).map(|index| (self.sample(index) as f64).powi(2)).sum();
        (sum / per_frame as f64).sqrt()
    }

    /// The meeting time just after the last sample.
    pub fn end_ms(&self) -> f64 {
        (self.first + self.samples.len() as i64) as f64 / SAMPLES_PER_MS
    }
}

/// The start of the quietest 20 ms frame in [lo_ms, hi_ms], or `at_ms` when
/// the range is empty; the first one on a tie.
fn quietest(audio: &StretchAudio, at_ms: f64, lo_ms: f64, hi_ms: f64) -> f64 {
    let mut best: Option<(f64, f64)> = None;
    let mut t = lo_ms;
    while t <= hi_ms {
        let energy = audio.energy(t);
        if best.map_or(true, |(lowest, _)| energy < lowest) {
            best = Some((energy, t));
        }
        t += FRAME_MS;
    }
    best.map_or(at_ms, |(_, t)| t)
}

/// The windows over `pieces` (one source's, in time order): one per stretch
/// no longer than [`WINDOW_MS`], else windows every [`HOP_MS`] started in a
/// pause, the last one ending at the stretch's end. `audio` gives the energy
/// for the snap; it holds at least the stretches' audio.
pub fn plan(pieces: &[(f64, f64)], audio: &StretchAudio) -> Vec<Window> {
    let mut windows = Vec::new();
    for (index, (start, end)) in stretches(pieces).into_iter().enumerate() {
        if end - start <= WINDOW_MS {
            windows.push(Window { start_ms: start, end_ms: end, stretch: index, first: true });
            continue;
        }
        let mut starts: Vec<f64> = Vec::new();
        let mut at = start;
        while at + WINDOW_MS < end {
            if let Some(&previous) = starts.last() {
                at = quietest(audio, at, (at - SNAP_MS).max(previous + 1000.0), at + SNAP_MS);
            }
            starts.push(at);
            at += HOP_MS;
        }
        let last = end - WINDOW_MS;
        let last = quietest(audio, last, last, (last + SNAP_MS).min(end - 2000.0));
        // Snapped starts drift later, so the window before the last can end
        // up within a second of it; it goes when the last one still overlaps
        // the window before it by a second.
        let n = starts.len();
        if n > 1 && last - starts[n - 1] < 1000.0 && last <= starts[n - 2] + WINDOW_MS - 1000.0 {
            starts.pop();
        }
        if starts.last().is_some_and(|&previous| last > previous) {
            starts.push(last);
        }
        for (i, &window_start) in starts.iter().enumerate() {
            windows.push(Window { start_ms: window_start, end_ms: (window_start + WINDOW_MS).min(end), stretch: index, first: i == 0 });
        }
    }
    windows
}

/// Decodes the window [start_ms, end_ms) with `decode`, and once more 0.5 s
/// later (or earlier, when the audio known so far ends before that) when a
/// window of at least 4 s gave fewer than 0.5 words per second; the call
/// with more words stays. Returns the window that stayed and its words.
pub fn decode_with_retry<E>(
    start_ms: f64,
    end_ms: f64,
    known_end_ms: f64,
    decode: &mut impl FnMut(f64, f64) -> Result<Vec<Word>, E>,
) -> Result<((f64, f64), Vec<Word>), E> {
    let found = decode(start_ms, end_ms)?;
    let seconds = (end_ms - start_ms) / 1000.0;
    if seconds >= RETRY_MIN_S && (found.len() as f64) < RETRY_WORDS_PER_S * seconds {
        let shift = if end_ms + RETRY_SHIFT_MS <= known_end_ms { RETRY_SHIFT_MS } else { -RETRY_SHIFT_MS };
        let again = decode(start_ms + shift, end_ms + shift)?;
        log::debug!(
            "[npu] {} words in {:.0}-{:.0} ms, {} with the window {:+.0} ms",
            found.len(),
            start_ms,
            end_ms,
            again.len(),
            shift
        );
        if again.len() > found.len() {
            return Ok(((start_ms + shift, end_ms + shift), again));
        }
    }
    Ok(((start_ms, end_ms), found))
}

/// Whether two words are the same: their letters and digits, ignoring case.
fn same(a: &str, b: &str) -> bool {
    let plain = |text: &str| text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>();
    let a = plain(a);
    !a.is_empty() && a == plain(b)
}

/// The anchor of a junction: the indices in `out` and in `current` of the
/// word both decoded the same nearest the middle of the overlap. `out` is
/// searched back to the later window's start, `current` up to the earlier
/// window's end; `skip_before` leaves out the words of `out` before it.
fn anchor(out: &[Word], current: &[Word], window_start: f64, previous_end: f64, skip_before: usize) -> Option<(usize, usize)> {
    let middle = (window_start + previous_end) / 2.0;
    let mut best: Option<(f64, usize, usize)> = None;
    for i in (0..out.len()).rev() {
        if out[i].start_ms < window_start {
            break;
        }
        if i < skip_before {
            continue;
        }
        for (j, word) in current.iter().enumerate() {
            if word.start_ms > previous_end {
                break;
            }
            if (word.start_ms - out[i].start_ms).abs() <= ANCHOR_MS && same(&word.text, &out[i].text) {
                let distance = ((word.start_ms + out[i].start_ms) / 2.0 - middle).abs();
                if best.map_or(true, |(nearest, _, _)| distance < nearest) {
                    best = Some((distance, i, j));
                }
            }
        }
    }
    best.map(|(_, i, j)| (i, j))
}

/// The words of all calls (`decoded[k]` from `windows[k]`), joined at each
/// junction of a stretch's neighbouring calls: on an anchor the earlier
/// call's words run up to and including it and the later call's after it;
/// without one each keeps the words on its side of the middle.
pub fn merge(windows: &[Window], decoded: &[Vec<Word>]) -> Vec<Word> {
    let mut out: Vec<Word> = Vec::new();
    let mut previous: Option<Window> = None;
    for (window, current) in windows.iter().zip(decoded) {
        let Some(earlier) = previous.filter(|_| !window.first) else {
            out.extend(current.iter().cloned());
            previous = Some(*window);
            continue;
        };
        match anchor(&out, current, window.start_ms, earlier.end_ms, 0) {
            Some((i, j)) => {
                out.truncate(i + 1);
                out.extend(current[j + 1..].iter().cloned());
            }
            None => {
                let middle = (window.start_ms + earlier.end_ms) / 2.0;
                out.retain(|word| word.start_ms < middle);
                out.extend(current.iter().filter(|word| word.start_ms >= middle).cloned());
            }
        }
        previous = Some(*window);
    }
    out
}

/// Each word to the piece it starts in (or the last piece that starts before
/// it: a word timed in a gap between pieces), as each piece's text.
pub fn assign(pieces: &[(f64, f64)], kept: &[Word]) -> Vec<String> {
    let mut words: Vec<Vec<Word>> = vec![Vec::new(); pieces.len()];
    for word in kept {
        let index = pieces.iter().rposition(|&(start, _)| start <= word.start_ms).unwrap_or(0);
        if let Some(piece) = words.get_mut(index) {
            piece.push(word.clone());
        }
    }
    words.iter().map(|piece| text(piece)).collect()
}

/// The text of each of `pieces` (one source's, in time order, all in
/// `audio`): the windows of their stretches decoded with the retry, joined
/// and assigned. `decode(samples, offset_ms)` decodes one window's samples.
pub fn transcribe<E>(
    pieces: &[(f64, f64)],
    audio: &StretchAudio,
    mut decode: impl FnMut(&[f32], f64) -> Result<Vec<Word>, E>,
) -> Result<Vec<String>, E> {
    let mut windows = plan(pieces, audio);
    let ends: Vec<f64> = stretches(pieces).iter().map(|&(_, end)| end).collect();
    let mut decoded = Vec::with_capacity(windows.len());
    for window in &mut windows {
        let mut call = |start: f64, end: f64| decode(&audio.slice(start, end), start);
        let ((start, end), found) = decode_with_retry(window.start_ms, window.end_ms, ends[window.stretch], &mut call)?;
        window.start_ms = start;
        window.end_ms = end;
        decoded.push(found);
    }
    Ok(assign(pieces, &merge(&windows, &decoded)))
}

/// One source's live stretch: the windows decoded so far and the words not
/// shown yet.
#[derive(Debug, Default)]
struct LiveStretch {
    start_ms: f64,
    end_ms: f64,
    audio: StretchAudio<'static>,
    /// The last window decoded.
    last: Option<(f64, f64)>,
    /// Words shown, the latest ones only: those a later anchor can reach.
    shown: Vec<Word>,
    /// Words decoded but not shown: held at a cap cut, or of this piece.
    pending: Vec<Word>,
}

impl LiveStretch {
    fn new(start_ms: f64) -> Self {
        Self { start_ms, end_ms: start_ms, ..Self::default() }
    }

    /// The windows to decode now for the stretch known up to `end_ms`: as
    /// [`plan`] for its first piece, then windows every hop after the last
    /// one decoded, the last one ending at the piece's end.
    fn plan_new(&self) -> Vec<(f64, f64)> {
        let (start, end) = (self.start_ms, self.end_ms);
        if end - start <= WINDOW_MS {
            return vec![(start, end)];
        }
        let Some((last_start, _)) = self.last else {
            return plan(&[(start, end)], &self.audio).iter().map(|window| (window.start_ms, window.end_ms)).collect();
        };
        let mut starts: Vec<f64> = Vec::new();
        let mut at = last_start + HOP_MS;
        while at + WINDOW_MS < end {
            let lo = (at - SNAP_MS).max(starts.last().copied().unwrap_or(last_start) + 1000.0);
            at = quietest(&self.audio, at, lo, at + SNAP_MS);
            starts.push(at);
            at += HOP_MS;
        }
        let last = end - WINDOW_MS;
        let last = quietest(&self.audio, last, last, (last + SNAP_MS).min(end - 2000.0));
        let n = starts.len();
        let before = if n > 1 { starts[n - 2] } else { last_start };
        if n > 0 && last - starts[n - 1] < 1000.0 && last <= before + WINDOW_MS - 1000.0 {
            starts.pop();
        }
        if last > starts.last().copied().unwrap_or(last_start) {
            starts.push(last);
        }
        starts.into_iter().map(|start| (start, (start + WINDOW_MS).min(end))).collect()
    }

    /// Joins `new`, decoded from `window`, to the pending words by
    /// [`merge`]'s rule, except that shown words stay: an anchor may not
    /// drop them, and without one the new call's words start after the last
    /// shown word. With `held` (the pending words are the previous piece's
    /// last second), a call that decoded nothing where they are keeps them:
    /// TDT skipped that span, as the retry's rule assumes.
    fn join(&mut self, new: Vec<Word>, window: (f64, f64), previous_end: f64, held: bool) {
        let fixed = self.shown.len();
        let combined: Vec<Word> = self.shown.iter().chain(&self.pending).cloned().collect();
        if let Some((i, j)) = anchor(&combined, &new, window.0, previous_end, fixed.saturating_sub(1)) {
            let mut kept: Vec<Word> = combined[..=i].to_vec();
            kept.extend(new[j + 1..].iter().cloned());
            self.pending = kept.split_off(fixed.min(kept.len()));
            return;
        }
        let middle = (window.0 + previous_end) / 2.0;
        let last_shown = self.shown.last().map_or(f64::NEG_INFINITY, |word| word.start_ms);
        let dropped = self.pending.iter().find(|word| word.start_ms >= middle).map(|word| word.start_ms);
        if let (true, Some(from)) = (held, dropped) {
            if !new.iter().any(|word| word.start_ms >= from && word.start_ms <= previous_end) {
                let last_kept = self.pending.last().map_or(last_shown, |word| word.start_ms);
                let after = middle.max(last_kept + NEW_AFTER_MS);
                self.pending.extend(new.into_iter().filter(|word| word.start_ms >= after));
                return;
            }
        }
        let after = middle.max(last_shown + NEW_AFTER_MS);
        self.pending.retain(|word| word.start_ms < middle);
        self.pending.extend(new.into_iter().filter(|word| word.start_ms >= after));
    }
}

/// Words a stretch held at a cap cut that no continuation joined: shown on
/// their own, in a row that ends where the stretch ended.
#[derive(Debug, Clone, PartialEq)]
pub struct Held {
    pub words: Vec<Word>,
    pub end_ms: f64,
}

/// The live windows of one source (#66, phase 1's `live-hold`): pieces come
/// one at a time with the VAD's word on whether it cut them by its cap, and
/// each gets the words it shows, final from then on.
#[derive(Debug, Default)]
pub struct Live {
    stretch: Option<LiveStretch>,
}

impl Live {
    /// Whether a piece at `start_ms` continues the stretch (touches its end).
    /// One that does not ends it: the caller shows what it held first
    /// ([`Self::flush`]), as a row of its own.
    pub fn continues(&self, start_ms: f64) -> bool {
        self.stretch.as_ref().is_some_and(|stretch| start_ms - stretch.end_ms <= TOUCH_MS)
    }

    /// The words to show with the piece at `start_ms`: the stretch's windows
    /// decoded with the retry and joined. With `capped` the stretch goes on
    /// and the words of the piece's last [`HOLD_MS`] wait for the next piece.
    /// A piece that does not continue the stretch starts a new one; words the
    /// old one still held, if the caller did not flush them, come first.
    pub fn piece<E>(
        &mut self,
        start_ms: f64,
        samples: &[f32],
        capped: bool,
        mut decode: impl FnMut(&[f32], f64) -> Result<Vec<Word>, E>,
    ) -> Result<Vec<Word>, E> {
        let mut shown = Vec::new();
        if !self.continues(start_ms) {
            shown.extend(self.flush().map(|held| held.words).unwrap_or_default());
            self.stretch = Some(LiveStretch::new(start_ms));
        }
        let Some(stretch) = self.stretch.as_mut() else { return Ok(shown) };
        stretch.audio.push(start_ms, samples);
        stretch.end_ms = stretch.audio.end_ms();
        let mut held = !stretch.pending.is_empty();
        for (start, end) in stretch.plan_new() {
            let audio = &stretch.audio;
            let mut call = |from: f64, to: f64| decode(&audio.slice(from, to), from);
            let (window, found) = decode_with_retry(start, end, stretch.end_ms, &mut call)?;
            match stretch.last {
                None => stretch.pending = found,
                Some((_, previous_end)) => stretch.join(found, window, previous_end, held),
            }
            held = false;
            stretch.last = Some(window);
        }
        let hold_from = if capped { stretch.end_ms - HOLD_MS } else { f64::INFINITY };
        let split = stretch.pending.iter().position(|word| word.start_ms >= hold_from).unwrap_or(stretch.pending.len());
        let rest = stretch.pending.split_off(split);
        let now = std::mem::replace(&mut stretch.pending, rest);
        stretch.shown.extend(now.iter().cloned());
        shown.extend(now);
        // What a later call can still reach: its windows start after the
        // last one's start (a retry moves them 0.5 s at most).
        if let Some((last_start, _)) = stretch.last {
            let reach = last_start - 1000.0;
            let keep_from = stretch.shown.iter().position(|word| word.start_ms >= reach).unwrap_or(stretch.shown.len());
            stretch.shown.drain(..keep_from.min(stretch.shown.len().saturating_sub(1)));
            stretch.audio.forget_before(reach);
        }
        Ok(shown)
    }

    /// Ends the stretch, at the end of the recording or before a piece that
    /// does not continue it: the words it still held, if any.
    pub fn flush(&mut self) -> Option<Held> {
        let stretch = self.stretch.take()?;
        (!stretch.pending.is_empty()).then_some(Held { words: stretch.pending, end_ms: stretch.end_ms })
    }

    /// The continuation did not come in time: the held words are shown now,
    /// final like any shown word, and the stretch stays for a late one.
    pub fn release(&mut self) -> Option<Held> {
        let stretch = self.stretch.as_mut()?;
        if stretch.pending.is_empty() {
            return None;
        }
        let words = std::mem::take(&mut stretch.pending);
        stretch.shown.extend(words.iter().cloned());
        Some(Held { words, end_ms: stretch.end_ms })
    }

    /// Whether words are held.
    pub fn holds(&self) -> bool {
        self.stretch.as_ref().is_some_and(|stretch| !stretch.pending.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Made-up audio: speech (0.1) with pauses (0.0) at `pauses` (start ms,
    /// length ms), over [start_ms, end_ms).
    fn audio(start_ms: f64, end_ms: f64, pauses: &[(f64, f64)]) -> StretchAudio<'static> {
        let mut samples = vec![0.1f32; ((end_ms - start_ms) * 16.0) as usize];
        for &(at, length) in pauses {
            let from = ((at - start_ms) * 16.0) as usize;
            let to = (((at + length) - start_ms) * 16.0) as usize;
            let to = to.min(samples.len());
            samples[from..to].iter_mut().for_each(|sample| *sample = 0.0);
        }
        let mut out = StretchAudio::default();
        out.push(start_ms, &samples);
        out
    }

    fn texts(words: &[Word]) -> Vec<&str> {
        words.iter().map(|word| word.text.trim()).collect()
    }

    #[cfg(windows)]
    #[test]
    fn a_window_is_the_npus_input_shape() {
        assert_eq!(WINDOW_MS, (super::super::npu::FRAMES - 1) as f64 * 10.0);
    }

    #[test]
    fn words_start_at_a_space_and_take_their_first_tokens_frame() {
        let tokens: Vec<String> = [" при", "вет", ",", " мир", "."].iter().map(|token| token.to_string()).collect();
        let found = words(&tokens, &[1, 2, 3, 10, 11], 1000.0);
        assert_eq!(found, vec![Word::new(1080.0, " привет,"), Word::new(1800.0, " мир.")]);
        assert_eq!(text(&found), "привет, мир.");
        // A call whose first token continues a word still starts one.
        assert_eq!(words(&tokens[1..2], &[0], 0.0), vec![Word::new(0.0, "вет")]);
    }

    #[test]
    fn touching_pieces_make_one_stretch_and_a_short_stretch_one_window() {
        let pieces = [(0.0, 3000.0), (3020.0, 5000.0), (6000.0, 8000.0)];
        assert_eq!(stretches(&pieces), vec![(0.0, 5000.0), (6000.0, 8000.0)]);
        let windows = plan(&pieces, &audio(0.0, 8000.0, &[]));
        assert_eq!(
            windows,
            vec![
                Window { start_ms: 0.0, end_ms: 5000.0, stretch: 0, first: true },
                Window { start_ms: 6000.0, end_ms: 8000.0, stretch: 1, first: true },
            ]
        );
    }

    #[test]
    fn a_long_stretch_gets_windows_every_hop_started_in_a_pause_and_one_at_its_end() {
        // 0-12 s of speech with pauses at 3.7 s and 9.8 s.
        let sound = audio(0.0, 12_000.0, &[(3700.0, 40.0), (9800.0, 40.0)]);
        let windows = plan(&[(0.0, 6000.0), (6000.0, 12_000.0)], &sound);
        let spans: Vec<(f64, f64)> = windows.iter().map(|window| (window.start_ms, window.end_ms)).collect();
        // The second window snaps from 3.5 s to the pause; the last one ends
        // at 12 s and snaps from 5.93 s within 0.5 s, finding only speech.
        assert_eq!(spans, vec![(0.0, WINDOW_MS), (3700.0, 3700.0 + WINDOW_MS), (12_000.0 - WINDOW_MS, 12_000.0)]);
        assert!(windows[0].first && !windows[1].first && !windows[2].first);
        assert!(spans.iter().all(|(start, end)| end - start <= WINDOW_MS));
    }

    #[test]
    fn a_window_close_to_the_last_one_goes_when_the_last_still_overlaps_its_predecessor() {
        // 0-10.2 s with a pause at 3.9 s: windows at 0 and 3.9 s, the last
        // at 4.13 s: within a second of 3.9 s and overlapping the first by
        // more than a second.
        let windows = plan(&[(0.0, 10_200.0)], &audio(0.0, 10_200.0, &[(3900.0, 40.0)]));
        let starts: Vec<f64> = windows.iter().map(|window| window.start_ms).collect();
        assert_eq!(starts, vec![0.0, 10_200.0 - WINDOW_MS]);
    }

    #[test]
    fn a_window_with_too_few_words_runs_again_and_the_richer_call_stays() {
        let mut calls = Vec::new();
        let mut decode = |start: f64, end: f64| -> Result<Vec<Word>, ()> {
            calls.push((start, end));
            Ok(if calls.len() == 1 { vec![Word::new(start, " a")] } else { vec![Word::new(start, " a"), Word::new(start + 900.0, " b"), Word::new(start + 1800.0, " c")] })
        };
        // 6 s with one word: under 0.5 words per second; the audio goes on,
        // so the retry runs 0.5 s later.
        let (window, found) = decode_with_retry(1000.0, 7000.0, 20_000.0, &mut decode).unwrap();
        assert_eq!(window, (1500.0, 7500.0));
        assert_eq!(found.len(), 3);
        assert_eq!(calls, vec![(1000.0, 7000.0), (1500.0, 7500.0)]);

        // At the end of the audio it runs 0.5 s earlier; a poorer retry is dropped.
        let mut decode = |start: f64, _end: f64| -> Result<Vec<Word>, ()> { Ok(if start == 1000.0 { vec![Word::new(1000.0, " a")] } else { Vec::new() }) };
        let (window, found) = decode_with_retry(1000.0, 7000.0, 7000.0, &mut decode).unwrap();
        assert_eq!((window, found.len()), ((1000.0, 7000.0), 1));

        // Under 4 s, or with enough words, there is no retry.
        let mut count = 0;
        let mut decode = |_: f64, _: f64| -> Result<Vec<Word>, ()> {
            count += 1;
            Ok(Vec::new())
        };
        decode_with_retry(0.0, 3900.0, 10_000.0, &mut decode).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn neighbouring_calls_join_on_the_anchor_nearest_the_middle() {
        let windows = [
            Window { start_ms: 0.0, end_ms: 6000.0, stretch: 0, first: true },
            Window { start_ms: 3500.0, end_ms: 9500.0, stretch: 0, first: false },
        ];
        // Middle of the overlap: 4750 ms. Both calls heard "один" (3600 and
        // 3680 ms) and "два" (4700, 4760 ms); "два" is nearer the middle.
        // The first call misheard the cut word "трии" at 5900 ms.
        let decoded = vec![
            vec![Word::new(100.0, " ноль"), Word::new(3600.0, " один"), Word::new(4700.0, " два"), Word::new(5900.0, " трии")],
            vec![Word::new(3680.0, " Один"), Word::new(4760.0, " два,"), Word::new(5880.0, " три"), Word::new(8000.0, " четыре")],
        ];
        assert_eq!(texts(&merge(&windows, &decoded)), vec!["ноль", "один", "два", "три", "четыре"]);

        // An equal word farther apart than ANCHOR_MS is another occurrence:
        // no anchor, so each call keeps its side of the middle.
        let decoded = vec![
            vec![Word::new(3600.0, " да"), Word::new(4500.0, " нет")],
            vec![Word::new(4100.0, " да"), Word::new(5000.0, " нет"), Word::new(6000.0, " ещё")],
        ];
        assert_eq!(texts(&merge(&windows, &decoded)), vec!["да", "нет", "нет", "ещё"]);
    }

    #[test]
    fn words_go_to_the_piece_they_start_in() {
        let pieces = [(0.0, 2000.0), (2000.0, 4000.0), (5000.0, 6000.0)];
        let kept = [Word::new(100.0, " a"), Word::new(1990.0, " b"), Word::new(2000.0, " c"), Word::new(4500.0, " d"), Word::new(5100.0, " e")];
        assert_eq!(assign(&pieces, &kept), vec!["a b", "c d", "e"]);
        // A word timed before the first piece goes to it.
        assert_eq!(assign(&pieces, &[Word::new(-50.0, " z")]), vec!["z", "", ""]);
    }

    #[test]
    fn transcribe_decodes_the_planned_windows_and_assigns_the_joined_words() {
        // Two touching pieces of 4 s: one stretch of 8 s, two windows.
        let pieces = [(0.0, 4000.0), (4000.0, 8000.0)];
        let sound = audio(0.0, 8000.0, &[]);
        // A made-up decoder: one word per second of the window's audio, at
        // the full second, named after it.
        let mut calls = Vec::new();
        let result = transcribe(&pieces, &sound, |samples, offset| -> Result<Vec<Word>, ()> {
            calls.push((offset, samples.len()));
            let end = offset + samples.len() as f64 / 16.0;
            let first = (offset / 1000.0).ceil() as i64;
            Ok((first..).map(|second| second as f64 * 1000.0).take_while(|&at| at < end).map(|at| Word::new(at, &format!(" w{}", at / 1000.0))).collect())
        })
        .unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], (0.0, (WINDOW_MS * 16.0) as usize));
        assert_eq!(result, vec!["w0 w1 w2 w3", "w4 w5 w6 w7"]);
    }

    #[test]
    fn stretch_audio_fills_gaps_with_silence_and_reads_outside_as_silence() {
        let mut sound = StretchAudio::default();
        sound.push(1000.0, &[1.0; 16]);
        sound.push(1002.0, &[2.0; 16]);
        assert_eq!(sound.slice(999.0, 1004.0)[..16], [0.0; 16]);
        assert_eq!(sound.slice(1000.0, 1001.0), vec![1.0; 16]);
        assert_eq!(sound.slice(1001.0, 1002.0), vec![0.0; 16]);
        assert_eq!(sound.slice(1002.0, 1003.0), vec![2.0; 16]);
        assert_eq!(sound.end_ms(), 1003.0);
        sound.forget_before(1002.0);
        assert_eq!(sound.slice(1000.0, 1001.0), vec![0.0; 16]);
        assert_eq!(sound.slice(1002.0, 1003.0), vec![2.0; 16]);
    }

    /// A made-up decoder over a script of words (time, text): a call hears
    /// the words inside its window.
    fn scripted<'s>(script: &'s [(f64, &'s str)]) -> impl FnMut(&[f32], f64) -> Result<Vec<Word>, ()> + 's {
        move |samples, offset| {
            let end = offset + samples.len() as f64 / 16.0;
            let heard = script.iter().filter(|(at, _)| *at >= offset && *at < end);
            Ok(heard.map(|(at, text)| Word::new(*at, &format!(" {text}"))).collect())
        }
    }

    #[test]
    fn live_holds_the_last_second_at_a_cap_cut_and_shows_it_with_the_next_piece() {
        let script = [(500.0, "раз"), (2500.0, "два"), (5500.0, "три"), (6500.0, "четыре"), (8000.0, "пять")];
        let sound = audio(0.0, 9000.0, &[]);
        let mut live = Live::default();
        // The VAD cut the first piece at its 6 s cap: "три" (5.5 s) waits.
        let first = live.piece(0.0, &sound.slice(0.0, 6000.0), true, scripted(&script)).unwrap();
        assert_eq!(texts(&first), vec!["раз", "два"]);
        assert!(live.holds());
        let second = live.piece(6000.0, &sound.slice(6000.0, 9000.0), false, scripted(&script)).unwrap();
        assert_eq!(texts(&second), vec!["три", "четыре", "пять"]);
        assert!(!live.holds());
    }

    #[test]
    fn held_words_stay_when_the_next_call_hears_nothing_there() {
        let script = [(500.0, "раз"), (2500.0, "два"), (5500.0, "три"), (8000.0, "пять")];
        let sound = audio(0.0, 9000.0, &[]);
        let mut live = Live::default();
        live.piece(0.0, &sound.slice(0.0, 6000.0), true, scripted(&script)).unwrap();
        // The next call (2.93-9 s, and its retry) skips the held span: TDT
        // emitted nothing there. Its words after the hold still come.
        let second = live
            .piece(6000.0, &sound.slice(6000.0, 9000.0), false, |_: &[f32], _| -> Result<Vec<Word>, ()> { Ok(vec![Word::new(8000.0, " пять")]) })
            .unwrap();
        assert_eq!(texts(&second), vec!["три", "пять"]);

        // Without the hold rule the midpoint would have dropped "три": a
        // call that hears something in the held span joins as usual.
        let mut live = Live::default();
        live.piece(0.0, &sound.slice(0.0, 6000.0), true, scripted(&script)).unwrap();
        let second = live
            .piece(6000.0, &sound.slice(6000.0, 9000.0), false, |_: &[f32], _| -> Result<Vec<Word>, ()> {
                Ok(vec![Word::new(5800.0, " трина"), Word::new(8000.0, " пять")])
            })
            .unwrap();
        assert_eq!(texts(&second), vec!["трина", "пять"]);
    }

    #[test]
    fn shown_words_are_never_taken_back_and_not_shown_twice() {
        // Two pieces that touch, neither capped: the second call re-hears
        // the first piece's words a frame later and adds one.
        let sound = audio(0.0, 5000.0, &[]);
        let mut live = Live::default();
        let mut first_call = |_: &[f32], _: f64| -> Result<Vec<Word>, ()> { Ok(vec![Word::new(400.0, " раз"), Word::new(1500.0, " два")]) };
        let first = live.piece(0.0, &sound.slice(0.0, 2000.0), false, &mut first_call).unwrap();
        assert_eq!(texts(&first), vec!["раз", "два"]);
        // The whole stretch (0-5 s) again: "два" 80 ms later is the anchor.
        let mut second_call = |_: &[f32], _: f64| -> Result<Vec<Word>, ()> {
            Ok(vec![Word::new(400.0, " Раз"), Word::new(1580.0, " два"), Word::new(3000.0, " три")])
        };
        let second = live.piece(2000.0, &sound.slice(2000.0, 5000.0), false, &mut second_call).unwrap();
        assert_eq!(texts(&second), vec!["три"]);
    }

    #[test]
    fn a_new_stretch_first_shows_what_its_predecessor_still_held() {
        let sound = audio(0.0, 20_000.0, &[]);
        let mut live = Live::default();
        let mut call = |_: &[f32], offset: f64| -> Result<Vec<Word>, ()> { Ok(vec![Word::new(offset + 5600.0, " конец")]) };
        let first = live.piece(0.0, &sound.slice(0.0, 6000.0), true, &mut call).unwrap();
        assert!(first.is_empty() && live.holds());
        // The continuation never came: a piece 4 s later starts a stretch.
        let mut later = |_: &[f32], offset: f64| -> Result<Vec<Word>, ()> { Ok(vec![Word::new(offset + 100.0, " новое")]) };
        let second = live.piece(10_000.0, &sound.slice(10_000.0, 12_000.0), false, &mut later).unwrap();
        assert_eq!(texts(&second), vec!["конец", "новое"]);
        // The end of the recording flushes what is held, with the stretch's end.
        live.piece(12_000.0, &sound.slice(12_000.0, 18_000.0), true, &mut call).unwrap();
        let held = live.flush().unwrap();
        assert_eq!((texts(&held.words), held.end_ms), (vec!["конец"], 18_000.0));
        assert!(!live.holds() && live.flush().is_none());
    }

    #[test]
    fn a_caller_flushes_a_stretch_a_piece_does_not_continue_and_releases_a_late_one() {
        let sound = audio(0.0, 30_000.0, &[]);
        let mut live = Live::default();
        let mut call = |_: &[f32], offset: f64| -> Result<Vec<Word>, ()> { Ok(vec![Word::new(offset + 5600.0, " конец")]) };
        live.piece(0.0, &sound.slice(0.0, 6000.0), true, &mut call).unwrap();
        assert!(live.continues(6000.0) && live.continues(6050.0) && !live.continues(6100.0));
        // Flushed before the unrelated piece, the words keep their own time
        // and that piece shows only its own.
        let held = live.flush().unwrap();
        assert_eq!((held.words[0].start_ms, held.end_ms), (5600.0, 6000.0));
        let mut later = |_: &[f32], offset: f64| -> Result<Vec<Word>, ()> { Ok(vec![Word::new(offset + 100.0, " новое")]) };
        let next = live.piece(10_000.0, &sound.slice(10_000.0, 12_000.0), false, &mut later).unwrap();
        assert_eq!(texts(&next), vec!["новое"]);

        // Released after a wait, they are shown and stay shown: a late
        // continuation that hears them again does not repeat them.
        let mut live = Live::default();
        live.piece(0.0, &sound.slice(0.0, 6000.0), true, &mut call).unwrap();
        let held = live.release().unwrap();
        assert_eq!(texts(&held.words), vec!["конец"]);
        assert!(!live.holds() && live.release().is_none());
        let mut again = |_: &[f32], _: f64| -> Result<Vec<Word>, ()> { Ok(vec![Word::new(5600.0, " конец"), Word::new(7000.0, " дальше")]) };
        let late = live.piece(6000.0, &sound.slice(6000.0, 8000.0), false, &mut again).unwrap();
        assert_eq!(texts(&late), vec!["дальше"]);
    }

    #[test]
    fn a_long_live_stretch_decodes_only_new_windows_and_keeps_bounded_state() {
        let mut live = Live::default();
        let mut calls: Vec<(f64, usize)> = Vec::new();
        let mut at = 0.0;
        for _ in 0..20 {
            let samples = vec![0.1f32; 6000 * 16];
            live.piece(at, &samples, true, |window: &[f32], offset| -> Result<Vec<Word>, ()> {
                calls.push((offset, window.len()));
                Ok((0..(window.len() / 16 / 500)).map(|k| Word::new(offset + k as f64 * 500.0, " слово")).collect())
            })
            .unwrap();
            at += 6000.0;
        }
        // Every window fits the shape, each piece adds about two of them.
        assert!(calls.iter().all(|&(_, samples)| samples as f64 <= WINDOW_MS * 16.0 + 1.0));
        assert!(calls.len() <= 20 * 3, "{} calls", calls.len());
        let stretch = live.stretch.as_ref().unwrap();
        assert!(stretch.audio.samples.len() < 20 * 16_000, "{} samples kept", stretch.audio.samples.len());
        assert!(stretch.shown.len() < 40, "{} words kept", stretch.shown.len());
    }
}
