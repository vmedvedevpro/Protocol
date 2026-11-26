//! One record stream from the sound server on its own thread (#216).
//!
//! The stream asks for 48 kHz mono f32, the format the pipeline works in, so
//! the server converts and downmixes and Protocol resamples nothing. The
//! thread only reads the socket and hands each block to `on_samples`, which
//! must not block (the recording path enqueues it for the capture worker);
//! falling behind would fill the server's buffer and lose audio there.

use std::io::{Cursor, Read};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use log::{info, warn};
use pulseaudio::protocol::{self, Command};

use super::Connection;

/// The rate and layout every stream asks for: what `AudioCapture` expects.
pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 1;

/// 20 ms per delivered block. The server's default fragment for a record
/// stream is about two seconds, which would make the level ring lag and each
/// pipeline window arrive late. `max_length` stays the server's: capping it
/// at one fragment stalls the stream, as the server drops a block that does
/// not fit (RustAudio/cpal#1387).
const FRAGMENT_BYTES: u32 = SAMPLE_RATE / 50 * 4;

/// The largest message the stream reads. A record stream receives data
/// blocks of one fragment (3840 bytes) or, after a stall, of what the server
/// held for it, and short commands; PulseAudio itself refuses frames over
/// 16 MiB. The length comes off the socket before the payload, so a corrupt
/// or hostile one must not make the thread allocate gigabytes: past this it
/// is a stream failure.
const MAX_MESSAGE: u32 = 4 << 20;

/// The payload length a descriptor announces, if the stream accepts it.
fn message_length(announced: u32) -> Result<usize, String> {
    if announced > MAX_MESSAGE {
        return Err(format!(
            "the sound server announced a {announced}-byte message, over the {} MiB a record stream accepts",
            MAX_MESSAGE >> 20
        ));
    }
    Ok(announced as usize)
}

/// How far the sample count may fall behind arrival, on a block after which
/// nothing more is waiting to be read, before the clock restarts at arrival. Delivery jitter is under
/// one server quantum (1024 samples, 21 ms, on PipeWire's default); a larger
/// lag after the backlog is drained means the server lost audio (its buffer
/// overran while the thread was stopped) or the card's clock is slower than
/// the system's.
const LOST: Duration = Duration::from_millis(100);

/// When each block's samples were captured, counted in samples.
///
/// Arrival time is not capture time. PipeWire hands a record stream its
/// audio per quantum of 1024 samples, so 960-sample (20 ms) blocks arrive
/// 21 ms apart with a 10 ms gap every 15 or so (measured here with `parec`
/// at 20 ms, 10 s per source, the process exempt from pauses). A block
/// stamped with its arrival is then 1.3 ms off the one before it, and the
/// mixer pads that with silence or drops it as late. After the process is
/// stopped or starved, seconds of buffered blocks arrive within milliseconds.
/// So each block ends one block's duration after the one before, never
/// later than its arrival (a block that would is evidence the clock started
/// late, and the clock moves back with it), and the clock restarts at
/// arrival only past `LOST`, and only once the backlog is read: a block
/// with more waiting behind it was captured earlier, however long the read
/// took (a read the stop interrupted returns late).
#[derive(Default)]
struct Clock {
    last_end: Option<Instant>,
}

impl Clock {
    /// How long ago the first of `samples` samples was captured, for a block
    /// that arrived at `now`; `drained` when nothing more was waiting.
    fn first_sample_age(&mut self, samples: usize, drained: bool, now: Instant) -> Duration {
        let duration = Duration::from_secs_f64(samples as f64 / SAMPLE_RATE as f64);
        let end = match self.last_end {
            None => now,
            Some(last) => {
                let counted = last + duration;
                if counted > now || (drained && now - counted > LOST) { now } else { counted }
            }
        };
        self.last_end = Some(end);
        now.saturating_duration_since(end) + duration
    }
}

/// Whether more of the stream is already waiting to be read: in the reader's
/// buffer, or on the socket. A non-blocking fill keeps what it reads in the
/// buffer for the next message.
fn pending(reader: &mut std::io::BufReader<UnixStream>) -> bool {
    use std::io::BufRead;
    if !reader.buffer().is_empty() {
        return true;
    }
    if reader.get_ref().set_nonblocking(true).is_err() {
        return false;
    }
    let waiting = matches!(reader.fill_buf(), Ok(bytes) if !bytes.is_empty());
    // Only this thread reads, so the socket blocks again before its next read.
    let _ = reader.get_ref().set_nonblocking(false);
    waiting
}

/// Why a stream ended without being stopped.
#[derive(Debug)]
pub enum Ended {
    /// The server removed the stream: its source went away (unplugged).
    SourceRemoved,
    /// The connection failed or the server went away.
    Failed(String),
}

pub struct RecordStream {
    source: String,
    stopping: Arc<AtomicBool>,
    socket: UnixStream,
    thread: Option<JoinHandle<()>>,
}

impl RecordStream {
    /// Connects to `source` (the server's name for it) and starts delivering
    /// blocks of 48 kHz mono samples to `on_samples` on the stream's thread,
    /// with how long ago the block's first sample was captured (`Clock`).
    /// `on_ended` runs there once if the stream ends before `stop`.
    pub fn open(
        source: &str,
        media_name: &str,
        mut on_samples: impl FnMut(&[f32], Duration) + Send + 'static,
        on_ended: impl FnOnce(Ended) + Send + 'static,
    ) -> Result<Self> {
        let mut connection = Connection::open()?;
        let mut props = protocol::Props::new();
        props.set(protocol::Prop::MediaName, std::ffi::CString::new(media_name)?);
        let reply: protocol::CreateRecordStreamReply = connection
            .roundtrip(Command::CreateRecordStream(protocol::RecordStreamParams {
                source_name: Some(std::ffi::CString::new(source)?),
                sample_spec: protocol::SampleSpec {
                    format: protocol::SampleFormat::Float32Le,
                    channels: CHANNELS as u8,
                    sample_rate: SAMPLE_RATE,
                },
                channel_map: protocol::ChannelMap::mono(),
                buffer_attr: protocol::stream::BufferAttr { fragment_size: FRAGMENT_BYTES, ..Default::default() },
                flags: protocol::stream::StreamFlags {
                    adjust_latency: true,
                    // When the chosen device goes away the server would move
                    // the stream to another source; this makes it end the
                    // stream instead, so the recording reports the unplugged
                    // device rather than quietly recording a different one.
                    no_move: true,
                    ..Default::default()
                },
                props,
                ..Default::default()
            }))
            .with_context(|| format!("the sound server cannot record from {source}"))?;
        let spec = reply.sample_spec;
        anyhow::ensure!(
            spec.format == protocol::SampleFormat::Float32Le && spec.channels as u16 == CHANNELS && spec.sample_rate == SAMPLE_RATE,
            "the sound server offered {spec:?} for {source}, not 48 kHz mono f32",
        );
        info!(
            "Recording {} from {source} (stream {}, {} bytes per block)",
            media_name, reply.channel, reply.buffer_attr.fragment_size
        );

        let version = connection.version();
        let mut reader = connection.into_reader();
        let socket = reader.get_ref().try_clone()?;
        // The thread waits for blocks as long as the stream lives (a stream
        // stays open through silence); `stop` ends the wait by closing the socket.
        reader.get_ref().set_read_timeout(None)?;
        let stopping = Arc::new(AtomicBool::new(false));
        let stop_seen = stopping.clone();
        let channel = reply.channel;
        let name = source.to_owned();
        let thread = std::thread::Builder::new()
            .name("pulse-record".into())
            .spawn(move || {
                let mut payload = Vec::new();
                let mut samples = Vec::new();
                let mut carry = Vec::new();
                let mut clock = Clock::default();
                let ended = loop {
                    fn lost(error: impl std::fmt::Display) -> String {
                        format!("lost the sound server: {error}")
                    }
                    let message = protocol::read_descriptor(&mut reader).map_err(lost).and_then(|descriptor| {
                        payload.resize(message_length(descriptor.length)?, 0);
                        reader.read_exact(&mut payload).map_err(lost)?;
                        Ok(descriptor)
                    });
                    let descriptor = match message {
                        Ok(descriptor) => descriptor,
                        Err(error) => break Ended::Failed(error),
                    };
                    if stop_seen.load(Ordering::Acquire) {
                        return;
                    }
                    if descriptor.channel != u32::MAX {
                        if descriptor.channel == channel {
                            decode(&payload, &mut carry, &mut samples);
                            if !samples.is_empty() {
                                let now = Instant::now();
                                let age = clock.first_sample_age(samples.len(), !pending(&mut reader), now);
                                on_samples(&samples, age);
                            }
                        }
                        continue;
                    }
                    match Command::read_tag_prefixed(&mut Cursor::new(&payload), version) {
                        Ok((_, Command::RecordStreamKilled(killed))) if killed == channel => break Ended::SourceRemoved,
                        Ok((_, Command::Overflow(_))) => warn!("{name}: the sound server's buffer overflowed; some audio was lost"),
                        Ok((_, Command::RecordStreamSuspended(params))) => info!("{name}: suspended {}", params.suspended),
                        Ok((_, Command::RecordStreamMoved(params))) => info!("{name}: moved to {:?}", params.device_name),
                        Ok((_, other)) => log::debug!("{name}: ignoring {:?}", other.tag()),
                        Err(error) => break Ended::Failed(format!("unreadable message from the sound server: {error}")),
                    }
                };
                if !stop_seen.load(Ordering::Acquire) {
                    warn!("Record stream from {name} ended: {ended:?}");
                    on_ended(ended);
                }
            })?;
        Ok(Self { source: source.to_owned(), stopping, socket, thread: Some(thread) })
    }

    /// Ends the stream: closing the socket makes the server drop it and wakes
    /// the thread's read at once, so the join does not wait on the server.
    pub fn stop(mut self) -> Result<()> {
        self.shutdown()
    }

    fn shutdown(&mut self) -> Result<()> {
        self.stopping.store(true, Ordering::Release);
        let _ = self.socket.shutdown(Shutdown::Both);
        if let Some(thread) = self.thread.take() {
            thread.join().map_err(|_| anyhow!("the record thread for {} panicked", self.source))?;
        }
        Ok(())
    }
}

impl Drop for RecordStream {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

/// Little-endian f32 samples from a data block. A block may in principle end
/// inside a sample; its bytes wait in `carry` for the next block.
fn decode(block: &[u8], carry: &mut Vec<u8>, samples: &mut Vec<f32>) {
    samples.clear();
    carry.extend_from_slice(block);
    let whole = carry.len() / 4 * 4;
    samples.extend(carry[..whole].chunks_exact(4).map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])));
    carry.drain(..whole);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_split_across_blocks_are_joined() {
        let bytes: Vec<u8> = [0.5f32, -0.25, 1.0].iter().flat_map(|sample| sample.to_le_bytes()).collect();
        let (mut carry, mut samples) = (Vec::new(), Vec::new());
        decode(&bytes[..6], &mut carry, &mut samples);
        assert_eq!(samples, [0.5]);
        decode(&bytes[6..], &mut carry, &mut samples);
        assert_eq!(samples, [-0.25, 1.0]);
        assert!(carry.is_empty());
    }

    const BLOCK: usize = 960; // 20 ms
    const fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// Feeds blocks arriving at the given offsets from `start`, each with
    /// whether nothing more was waiting, and returns when each block ends on
    /// the capture clock.
    fn ends(start: Instant, arrivals: &[(Duration, bool)]) -> Vec<Instant> {
        let mut clock = Clock::default();
        arrivals
            .iter()
            .map(|&(at, drained)| {
                let now = start + at;
                now - clock.first_sample_age(BLOCK, drained, now) + ms(20)
            })
            .collect()
    }

    #[test]
    fn blocks_delivered_per_pipewire_quantum_stay_twenty_milliseconds_apart() {
        // 1024-sample quanta carrying 960-sample blocks: 21.33 ms apart, and
        // a second block in the same quantum now and then.
        let mut arrivals = Vec::new();
        let (mut delivered, mut quantum) = (0usize, 0u64);
        while arrivals.len() < 200 {
            quantum += 1;
            let at = Duration::from_nanos(quantum * 1024 * 1_000_000_000 / 48_000);
            while (delivered + 1) * BLOCK <= quantum as usize * 1024 {
                delivered += 1;
                // The first of two blocks in one quantum has the second behind it.
                arrivals.push((at, (delivered + 1) * BLOCK > quantum as usize * 1024));
            }
        }
        let start = Instant::now();
        let stamped = ends(start, &arrivals);
        // The first block arrived 1.3 ms after it ended, so the clock starts
        // that late; block 16 ends exactly as quantum 15 does and arrives
        // with it, which moves the clock back. From then on, 20 ms apart.
        assert_eq!(stamped[15], start + ms(320));
        for (n, pair) in stamped.windows(2).enumerate().skip(15) {
            assert_eq!(pair[1] - pair[0], ms(20), "block {}", n + 1);
        }
        for (end, (at, _)) in stamped.iter().zip(&arrivals) {
            assert!(*end <= start + *at);
        }
    }

    #[test]
    fn a_backlog_read_at_once_keeps_its_capture_times() {
        let start = Instant::now();
        // One block, then the process stops for a second; the server buffers
        // 50 blocks, which arrive within a millisecond, each but the last
        // with more behind it.
        let mut arrivals = vec![(ms(20), true)];
        arrivals.extend((0..50).map(|n| (ms(1020) + Duration::from_micros(n * 20), n == 49)));
        for (n, end) in ends(start, &arrivals).iter().enumerate() {
            assert_eq!(*end, start + ms(20 * (n as u64 + 1)), "block {n}");
        }
    }

    #[test]
    fn the_clock_restarts_when_the_server_lost_audio() {
        let start = Instant::now();
        // Half a second goes missing: the next block with nothing behind it
        // is stamped at its arrival, not 480 ms early.
        let lost = ends(start, &[(ms(20), true), (ms(40), true), (ms(540), true), (ms(560), true)]);
        assert_eq!(lost, [start + ms(20), start + ms(40), start + ms(540), start + ms(560)]);
        // A block with more behind it is backlog, whatever its lag.
        let backlog = ends(start, &[(ms(20), true), (ms(540), false)]);
        assert_eq!(backlog, [start + ms(20), start + ms(40)]);
        // A lag under `LOST` is jitter and keeps counting.
        let jitter = ends(start, &[(ms(20), true), (ms(90), true)]);
        assert_eq!(jitter, [start + ms(20), start + ms(40)]);
    }

    #[test]
    fn a_card_slower_than_the_system_clock_restarts_the_clock_past_lost() {
        let start = Instant::now();
        // Each 20 ms block arrives 21 ms after the one before: the card runs
        // 5 % slow, and the count falls 1 ms further behind arrival per block.
        let arrivals: Vec<_> = (0..104).map(|n| (ms(21 * (n + 1)), true)).collect();
        let stamped = ends(start, &arrivals);
        // Block 100 lags its arrival by 100 ms, which is not past `LOST`: counted.
        assert_eq!(stamped[100], start + ms(21 + 20 * 100));
        assert_eq!(start + arrivals[100].0 - stamped[100], LOST);
        // Block 101 would lag by 101 ms: it is stamped at its arrival, a jump
        // of 121 ms instead of 20, and counting goes on from there.
        assert_eq!(stamped[101], start + arrivals[101].0);
        assert_eq!(stamped[101] - stamped[100], ms(121));
        assert_eq!(stamped[102], stamped[101] + ms(20));
        assert_eq!(stamped[103], stamped[102] + ms(20));
    }

    #[test]
    fn a_message_over_the_limit_fails_the_stream_before_anything_is_allocated() {
        assert_eq!(message_length(FRAGMENT_BYTES), Ok(3840));
        assert_eq!(message_length(MAX_MESSAGE), Ok(4 << 20));
        for announced in [MAX_MESSAGE + 1, u32::MAX] {
            let error = message_length(announced).unwrap_err();
            assert!(error.contains(&format!("{announced}-byte message")), "{error}");
        }
    }

    #[test]
    fn the_fragment_is_twenty_milliseconds_of_mono_f32() {
        assert_eq!(FRAGMENT_BYTES, 960 * 4);
    }

    /// Records two seconds from each device the select lists under the
    /// labels in `PROTOCOL_QA_INPUT` and `PROTOCOL_QA_OUTPUT` (an input and
    /// an output monitor) and prints what arrived. With
    /// `PROTOCOL_QA_MIN_RMS`, each must reach that level: play a tone into
    /// the output first. Ignored: it needs a running sound server.
    #[test]
    #[ignore]
    fn records_the_chosen_input_and_output_monitor() {
        use std::sync::Mutex;
        let listing = super::super::devices::current().expect("a sound server runs");
        let min_rms: f32 = std::env::var("PROTOCOL_QA_MIN_RMS").ok().and_then(|v| v.parse().ok()).unwrap_or(0.0);
        for (variable, output) in [("PROTOCOL_QA_INPUT", false), ("PROTOCOL_QA_OUTPUT", true)] {
            let fallback = if output { listing.default_output.clone() } else { listing.default_input.clone() };
            let label = std::env::var(variable).ok().or(fallback).expect("a device to record");
            let source = listing.source(&label, output).unwrap_or_else(|| panic!("'{label}' is not listed: {listing:#?}")).source.clone();
            let collected = Arc::new(Mutex::new(Vec::<f32>::new()));
            let sink = collected.clone();
            let stream = RecordStream::open(&source, "QA", move |samples, _| sink.lock().unwrap().extend_from_slice(samples), |ended| panic!("ended: {ended:?}")).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(2));
            stream.stop().unwrap();
            let samples = collected.lock().unwrap();
            let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt();
            eprintln!("{label} ({source}): {} samples, {:.2} s, RMS {rms:.4}", samples.len(), samples.len() as f32 / SAMPLE_RATE as f32);
            assert!(samples.len() as u32 > SAMPLE_RATE * 3 / 2, "two seconds should bring at least 1.5 s of audio");
            assert!(rms >= min_rms, "{label}: RMS {rms} below {min_rms}");
        }
    }
}
