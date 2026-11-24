# System audio level advice

System gain is applied in `audio/pipeline.rs` before the source meter, VAD,
transcription, and saved tracks. There is no universal Windows volume percentage
or amplitude that guarantees transcription. VAD thresholds are model speech
probabilities, not digital amplitude thresholds.

`frontend/src/components/ring/levelAdvice.ts` owns an advisory heuristic using
existing native post-gain RMS/peak events (`recording-audio-levels`):
`QuietMonitor` and `LoudMonitor` count the samples, and
`useSystemAudioWarning(active)` owns the lifecycle. `SourceMeter` shows the
result as its warning state (a warning icon, an outline, the advice in its
tooltip) on the computer-audio meter of the recording bar, and the minibar
(#116) can use the same hook. Too loud comes from the limiter's hits and takes
precedence. Device preview meters do not run this recording-only check or
multiply gain twice. (The old UI, `162e8be`, had it in
`lib/system-audio-level.ts` and `LiveAudioVisualizer.tsx`.)

Five seconds of consecutive nonzero samples with RMS between -80 and -45 dBFS
and peaks below -30 dBFS triggers the advice. Silence, stronger audio, invalid
samples, an event gap over 300 ms or a lifecycle reset clears accumulation.
No callbacks clears displayed advice after one second. Pause, source changes
and unmount clean up the timer. Microphone input is excluded.

Too loud needs limiter hits no more than 250 ms apart for 750 ms, and clears
1.5 s after the last hit.

These are advisory heuristics, not calibrated ASR minimums. Quiet background noise
can qualify, so the text says "If someone is speaking" and points to System volume
in Settings › Recording. Short quiet utterances may not trigger advice. Gain, VAD
and recordings are never modified automatically.
Tests (`levelAdvice.test.ts`, `levelAdvice.hook.test.tsx`, `SourceMeter.test.tsx`)
cover the timing, gaps, louder samples, digital silence, invalid samples, hits
too far apart, source filtering, expiry and the muted state.
Real-call threshold calibration remains open.
