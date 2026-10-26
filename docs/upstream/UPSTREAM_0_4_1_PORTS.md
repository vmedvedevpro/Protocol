# Selective upstream 0.4.1 integration

Based on upstream tag `v0.4.1`, integrated onto Actually Free v0.2.15 for
the Windows v0.2.16 release. These are adapted changes, not a wholesale merge.

Many improvements listed in upstream 0.4.1 already have equivalents in this
fork, including Claude thinking-block handling, short-transcript preservation,
responsive toolbar controls, and much of the model-download recovery behavior.
The integration retains those existing fixes and incorporates the remaining
applicable changes with fork-specific adaptations. Release notes should describe
this as selective incorporation, not imply that every upstream fix is new here.

## Included

- [#603](https://github.com/Zackriya-Solutions/meetily/pull/603), by ShiroKSH:
  advance summary chunks from the actual emitted sentence/word boundary.
- [#608](https://github.com/Zackriya-Solutions/meetily/pull/608), by iphixit:
  use decoded sample rate for HE-AAC imports and preserve the upstream fixture.
  The metadata-repair part of [#737](https://github.com/Zackriya-Solutions/meetily/pull/737)
  updates duration during explicit retranscription without replacing other fields.
- The camelCase IPC argument correction from
  [#748](https://github.com/Zackriya-Solutions/meetily/pull/748), by athulchandroth.
- The navigation/progress and home-button positioning concepts from
  [#779](https://github.com/Zackriya-Solutions/meetily/pull/779), by athulchandroth:
  reattach polling on return, suppress stale/history updates, scope polling
  cleanup by owner, and remove the home-page entrance translation.
- [#767](https://github.com/Zackriya-Solutions/meetily/pull/767), by safvanatzack:
  pinned, validated Windows ONNX Runtime and recoverable startup failures.
  This fork additionally routes diarization through the same runtime and keeps
  all three retained audio tracks. Both VADs are constructed before the saver;
  destination validation still completes before any producer receives a sender.
- Recovery ideas from [#682](https://github.com/Zackriya-Solutions/meetily/pull/682)
  by VictorMaxWang and [#749](https://github.com/Zackriya-Solutions/meetily/pull/749)
  by safvanatzack: the fork already preserved siblings and exact-size validation.
  Added one retry without Range after 416, strict end-offset validation, per-attempt
  cancellation tokens that interrupt stalled headers/body reads, and scoped
  cancellation release so a stale Cancel cannot clear a newer Retry.

## Deliberately excluded

- #744 and its bundled layout/reasoning rewrite.
- Bluetooth hot-swap, automatic device fallback policy, and macOS probe changes.
- Upstream's 500 ms VAD policy: retain this fork's calibrated 800 ms live value,
  separate mic/system thresholds, and 2,000 ms offline value.
- Changes to trained speaker identity, source mute, or existing runtime crash fix.

## Verification and remaining platform checks

Frontend hook tests use mocked IPC and synthetic summaries; native download tests
use a loopback HTTP server. ONNX tests load the actual verified DLL and exercise
the bundled diarization models. A subprocess checks that a missing runtime leaves
recording state stopped and creates no recording directory. The HE-AAC fixture
checks decoded and 16 kHz resampled duration.

A modern x64 machine cannot establish compatibility with every non-AVX2 CPU.
Physical older-CPU Record/Import tests remain necessary before advertising broad
hardware compatibility. Physical non-AVX2 and real install/update testing were
explicitly waived as publication gates for v0.2.16; neither is claimed as passed.
Payload checks do not exercise installer registry, shortcut, or upgrade behavior.
The user's existing installation and data are not used for these checks.

Local verification passed:

- 28 frontend library/rendering tests and seven summary-recovery hook tests.
- Production Next.js build and standalone TypeScript checking.
- 70 targeted native tests on v0.2.16: six runtime/staging/startup/diarization
  tests and 64 summary/import/download/VAD/saver/pipeline tests, including mute
  and source alignment.
- Fresh CPU, Vulkan, and multi-architecture CUDA release builds with
  `custom-protocol`, plus a fresh universal setup/updater package.
- Updater cryptographic signatures, checksums, manifest routing, archive
  integrity, packaged variant hashes, and bootstrapper payload verification.
- Extracted ONNX, template, and diarization resources match their build-stage
  SHA-256 hashes. The extracted ONNX DLL loads in a separate process and reports
  version 1.22.0 with API 22. This is a native-library smoke test, not a GUI,
  recording-session, or installer rehearsal.
- Matching x64 EXE/PDB identities retained for every shipped backend before
  the Tauri packaging pass can replace the CPU placeholder's symbols.
- The dependency tree contains one `ort`/`ort-sys` version shared with Silero.

The earlier CPU-only test bundle retained v0.2.15 as its base version and is not
a release artifact. Only the newly built v0.2.16 universal assets are publishable.
