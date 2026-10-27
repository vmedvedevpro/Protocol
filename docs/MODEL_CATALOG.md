# Model catalog and model updates

[#50](https://github.com/vmedvedevpro/Protocol/issues/50). The transcription
models (Whisper ggml, Parakeet INT8) and the built-in summary models (GGUF) the
app offers are listed in `model-catalog/catalog.json` on this repository's
`main` branch. The list changes by a pull request, without an app release, and
installed apps pick it up within a day. A model's version and size are not in
the list: the app resolves them from Hugging Face, and offers an update when
Hugging Face's files differ from the installed ones. Diarization models are not in the
catalog; they ship with the app and stay pinned in `model_integrity.rs`.

The owner's decisions behind this (2026-10-27): no signature, key, publish
workflow or history file. Trust is HTTPS to GitHub and Hugging Face, plus the
checks below.

## The file

`{ "schema": 1, "models": [ … ] }`. An entry:

| Field | Meaning |
| --- | --- |
| `id` | The value saved in settings and the database. Permanent: never renamed or reused. 1–64 of `a-z 0-9 . _ : -`. |
| `engine`, `format` | `whisper`/`ggml`, `parakeet`/`onnx-tdt-int8` or `llama`/`gguf`. A build hides an engine or format it does not know. |
| `name`, `description` | Display text (≤ 80 and ≤ 300 characters). |
| `languages` | `["*"]` or language codes. |
| `accuracy`, `speed` | Short display labels (Whisper, Parakeet). |
| `tier` | `basic` or `advanced` (Whisper: basic models are listed first, the rest under Advanced Models). |
| `recommended`, `rank`, `min_ram_gb` | Summary models: the recommendation is the recommended model with the highest `rank` that fits in the machine's RAM; "best available" picks the installed model with the highest `rank`. Parakeet: the recommended card. |
| `listed` | `false`: not offered for new downloads; an installed copy keeps working (Parakeet v2). Default `true`. |
| `license` | `{ name, url }` (https). |
| `repo` | The Hugging Face repository, `owner/name`. |
| `revision` | Optional 40-character commit: the entry stays on it instead of following the default branch. |
| `files` | `[{ name, path }]`: the name on disk and the path in the repository. Whisper: one `ggml-<id>.bin`; Parakeet: exactly `encoder-model.int8.onnx`, `decoder_joint-model.int8.onnx`, `nemo128.onnx`, `vocab.txt`; summary: one `.gguf`. |
| `min_app_version` | Optional `X.Y.Z`: older apps leave the entry out. |
| `params` | Summary models only: `chat_format` (`gemma3` or `qwen3.5_nonthinking`, the templates in `summary_engine/models.rs`), `context_size` (512–1048576), `sampling` (`temperature`, `top_k`, `top_p`, `presence_penalty`, `frequency_penalty`, `repeat_penalty`, `penalty_last_n`) and `stop_tokens`. |

The rules live twice, kept equal by shared cases:
`scripts/model-catalog/check-catalog.mjs` (pull requests) and
`model_catalog::schema` (the app). Both run
`scripts/model-catalog/test/entry-cases.json`. Numbers are read as the app's
reader takes them: `rank` (u32), `context_size`, `top_k` and `penalty_last_n`
(i32) are whole numbers written without a fraction or exponent (`3.0` and
`1e2` are refused) and within their type; the other sampling values must fit
an f32. Of two entries with the same
engine and id, or two summary models with the same file name, the first wins.
An entry that breaks a rule is hidden on its own; only a document that is not
JSON, has another `schema` or no `models` is refused whole.

### Changing the list

1. Edit `model-catalog/catalog.json`. Keep ids; a model replaced by another
   gets a new id, and the old entry stays (`listed: false`) while installs may
   remain.
2. Run `node scripts/model-catalog/check-catalog.mjs model-catalog/catalog.json`
   and `node --test "scripts/model-catalog/test/*.test.mjs"`. `pr-checks.yml`
   runs both; a failure blocks the merge.
3. To check that every built-in entry resolves on Hugging Face, run the ignored
   `model_catalog::huggingface::tests::every_built_in_entry_resolves_on_hugging_face`.

A new engine, format or chat template needs app code; give such an entry the
`min_app_version` that brings it, so older apps do not even try. Removing an
entry stops new downloads; models this build shipped with keep working from
its built-in copy (below), others do not.

## How the app reads it

- **Built in.** Every build embeds the file (`include_str!`). Tests require it
  to be valid and to contain every id the code names (defaults, fallbacks,
  the optional post-call model).
- **Launch** (`model_catalog::service::init`, before the engines list their
  models): interrupted updates are finished or rolled back, then the cached
  copy `<app cache>/model-catalog/catalog.json` is used, else the built-in one.
- **Daily** (the updater's scheduler, `crate::updater::schedule`: 24 h after
  the last completed check, backoff 1/2/4/6 h, after onboarding, behind
  **Check for app and model updates automatically**, also where app updates
  are off) and on **Check for model updates** (Settings › About): the app
  fetches `https://raw.githubusercontent.com/vmedvedevpro/Protocol/main/model-catalog/catalog.json`
  (at most 1 MiB). A document that can be read and offers at least one model
  becomes the list in use and the cached copy. Anything else (GitHub
  unreachable, an error page, a schema for a newer app) leaves both as they
  are. Fallback order: `main` → cache → built in.
- **Engines** ask `model_catalog` for entries each time they list or download,
  so a new list applies without a restart. A model that is installed but
  missing from the list in use (removed, or hidden as invalid) keeps its
  built-in entry (`entries_with_installed`).
- **IPC.** `model_catalog_get_status`, `model_catalog_check_now`,
  `model_catalog_request_sizes`, `model_catalog_model_size`,
  `model_update_start`, `model_update_cancel`; each change is pushed as
  `model-catalog-changed` with the source, the last check and its error, the
  hidden entries, the updates found, running updates and failed ones, and
  `sizesVersion`. The Whisper, Parakeet and built-in managers list their
  models again when the list, a running update or the sizes change
  (`listKey` in `lib/model-catalog.ts`). The history is
  `<app cache>/model-catalog/state.json`, written atomically like every file
  of this module (`model_catalog::write_atomically`).

## Versions and hashes come from Hugging Face

`model_catalog::huggingface` resolves an entry:

1. the commit: the entry's `revision`, else `sha` from `GET /api/models/<repo>`;
2. `GET /api/models/<repo>/tree/<commit>[/<dir>]` (following `Link` pages)
   gives each file's `size` and, for LFS files, `lfs.oid`, the SHA-256 of its
   content;
3. a file kept in Git (Parakeet's `vocab.txt`) has only its blob id there: it is
   fetched from the commit, its blob id recomputed (SHA-1 over
   `blob <len>\0` and the bytes) and compared, and its SHA-256 taken from the
   bytes;
4. downloads use `resolve/<commit>/<path>`, so the bytes cannot change in the
   middle of a download, and stream through `model_integrity::Check` against
   that size and SHA-256 as before. Run-time pins are interned
   (`model_integrity::intern`) for the `&'static Pinned` APIs.

Each download writes an install record beside the model (`<file>.install.json`;
`install.json` in a Parakeet folder) with the repository, the commit and every
file's size, SHA-256 and blob id: unfinished before the first byte, complete
once every file matched. An unfinished Parakeet or summary download resumes
from its recorded commit without asking the API, so its kept bytes stay valid;
Whisper downloads start over. Startup sizes and the hash before load come from
the complete record.

### Model sizes

The catalog has no sizes; every size the app shows or uses comes from Hugging
Face or from what is installed (`model_catalog::sizes`, owner decision of
2026-10-27):

- **An installed model** shows the size of its own files: the install record,
  or the 0.3.0 pins for a 0.3.x install. Its statuses (Corrupted, Incomplete)
  compare the file with that exact size, and a file is complete only when its
  size and its SHA-256 match.
- **Any other model** shows the size Hugging Face lists for its files now. A
  model list asks for the sizes it lacks when it is shown
  (`model_catalog_request_sizes`, from the Whisper, Parakeet and summary
  managers, and for single models in onboarding and the optional downloads):
  one `api/models/<repo>` and one tree request per repository (and pinned
  `revision`), in the background, while the list shows without them. The
  listing is kept per repository and commit in
  `<app cache>/model-catalog/sizes.json`, so later lists show sizes at once.
  The daily or manual check lists those repositories again and forgets the
  ones no entry uses. This request is part of showing a list, not a check: the
  automatic-check switch does not gate it.
- **Unknown** (offline, rate-limited, never listed, or a repository that
  failed in the last 10 minutes): no size is shown, not a guess or 0.
  Downloads still work: a download resolves its files when it starts, and its
  progress reports that exact total.

These sizes are for display only; what a download is checked against is
always the listing resolved when it starts.

### Models installed by 0.3.x

0.3.x wrote no records. Its pins are kept, frozen, in
`model_catalog::installed::LEGACY`, so its models are recognised by id and file
name, checked at startup by size and before load by SHA-256 against those pins
(their `.verified` markers stay valid), and keep every setting, since the ids
did not change. When Hugging Face has moved since, the card offers an update.
A partial file 0.3.x left is resumed only if Hugging Face is still at the
commit 0.3.0 pinned; otherwise it is deleted before the download.

## Updates

**Check** (`updates::check`, after every catalog check): for each installed
model, the current commit's listing is compared with the installed files:
SHA-256 for LFS files, blob id for Git files (from the record, or computed from
the installed file for 0.3.x installs). A new commit that changes none of the
model's files is not an update. Nothing is downloaded.

A check is complete when GitHub and Hugging Face answered, even when the
answer was an error: a 404 or an unusable document for the list (shown under
**Check for model updates**), or an error about one model, such as a removed
or gated repository or a missing file (`checkFailures`, shown on that model's
card as "Couldn't check for updates: …" and counted in Settings › About). A
complete check is followed by the next one a day later. Only a check that could
not ask (no connection, a rate limit, a 5xx answer; `HubError::is_transient`,
`FetchError::transient`) is retried sooner, with the updater's 1/2/4/6 h
backoff. A model that was not checked (Hugging Face could not be asked, or the
model is being updated) keeps what the last check found. A check stores its
results against the status as it is when the check ends, so an update that
ended meanwhile is not offered again (`CatalogState::store_check`).

**Update** (`model_update_start`, the card's **Update**), in
`updates::run`:

1. resolve the current commit; download the files that changed into
   `models/.model-updates/<engine>-<id>/`, beside the installed model, and copy
   the unchanged ones from it; every file is checked against its pin;
2. wait until nothing in the busy registry runs except model downloads and
   onboarding (recordings, imports, retranscription, summaries, post-call
   work);
3. test-load the staged model: Whisper on the CPU (`WhisperContext`), Parakeet
   with `ParakeetModel::new`, a summary model in a llama-helper of its own that
   generates one token (`summary_engine::client::probe_model`; the summary
   helper is stopped first so only one holds memory);
4. take the engine lifecycle lock (re-checking that nothing started), unload
   the speech engines or stop the summary helper, and swap under a journal
   (`swap.json`): the installed files move to `previous/`, the new ones take
   their place, the install record is rewritten, markers are written, and the
   staging folder with the previous version is deleted.

A failed download, hash, test load or swap, or **Cancel** (until the swap),
leaves the installed model as it was and removes the staging folder; the card
shows why with **Try again**. A swap cut short by a crash is finished (the new
record is in place) or rolled back at the next launch, and an unfinished update
download is removed. The operation holds `BusyReason::ModelDownload`, so an app
update never restarts in its middle.

## Privacy

Automatic requests (with the switch on): once a day the catalog from
`raw.githubusercontent.com`, and for each installed model `api/models/<repo>`
and its tree listing on `huggingface.co`, plus the same two requests for each
repository whose sizes a list asked for before. Showing a model list (Settings,
onboarding, the optional downloads) asks for the sizes it lacks: the same two
requests per repository of its models, once, also with the switch off. All use
the user agent `Protocol/<version>`. Nothing identifies the installation;
downloads happen only on a click. `PRIVACY_POLICY.md` says the same.

## Tests

- Node: `node --test "scripts/model-catalog/test/*.test.mjs"` (shared cases,
  the repository's catalog, fatal documents, duplicates, the CLI).
- Native (`cargo test -p protocol --lib model_catalog`):
  `schema` (the shared cases, refused documents, hidden and duplicate entries,
  `min_app_version`), the built-in catalog and fallback to built-in entries of
  installed models, `remote` and `service` (cache, oversized or unreadable
  answers, the fallback order, the schedule), `sizes` (one listing per
  repository, kept and not asked again, a pinned revision, a failed repository
  not retried at once, the check reading known sizes again and forgetting
  unused ones), `huggingface` (current commit and
  pinned revision against a local hub, Git files and a blob mismatch, missing
  repositories and files, rate limits, offline), `installed` (0.3.0 pins, complete
  and unfinished records), `updates` (offered only when a file changed, a Git file
  of a 0.3.x install, a full update, a failed test load, a hash mismatch, a
  cancel, a failed and an interrupted swap, recovery). Engine tests:
  `parakeet_engine` (`a_download_resolves_the_current_commit_and_records_it`
  with the installed size, v2 listed only once installed and with no size
  before Hugging Face is asked, resume of a recorded download), the summary
  scan (exact byte sizes of a partial 0.3.x file and of an installed one), and
  the existing Whisper and summary download and load tests, now against 0.3.0
  pins.
- Frontend: `frontend/tests/model-catalog/` (the card's offer, progress, cancel
  and failure; the list key; the About block; Whisper names, tiers, order and
  re-listing; sizes asked for on mount, shown when they arrive, never guessed;
  `formatModelSize`) and `tests/updater/panel.test.tsx` (the switch stays
  where app updates are off).
- Ignored: `every_built_in_entry_resolves_on_hugging_face` (network).

## Limits

- No signature: whoever can merge to `main` decides which repositories new
  downloads come from, and whoever can push to such a repository decides their
  bytes. Hashes come from the same Hugging Face listing as the files, so they
  catch corruption and a changed file mid-download, not a malicious push. A
  `revision` narrows an entry to one commit.
- An update download does not resume; after a failure or a restart it starts
  over.
- A summary started during the swap of a summary model can hold the file open;
  the swap then fails, is rolled back and says to retry.
- The test load proves the model loads (Whisper on the CPU, one llama token),
  not that it transcribes or summarises well.
- The UI still hides Parakeet v2 entirely (`isVisibleParakeetModel`, upstream).
- A deleted model's update entry stays in the status until the next check; its
  card no longer shows it.
