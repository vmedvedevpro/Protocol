#!/usr/bin/env bash
# Prepares the macOS half of a release that assemble-release.sh drafted from
# the Windows and Linux legs (#164): checks the macOS leg's SHA256SUMS.txt
# (transfer integrity), signs the updater bundle, verifies the signature
# against the public key the apps trust, and merges macOS into the release's
# latest.json, SHA256SUMS.txt and body. The macos job of a tag run runs it with
# the production key against the release itself, the preview-macos job of a
# dry run with a throwaway key against the dry run's release-dry-run artifact.
#
#   scripts/release/join-macos.sh <leg-dir> <release-dir> <dist-dir> <pubkey-file> <notes-source> <body-file> <notes-out>
#
# <leg-dir> is the downloaded leg-macos artifact. <release-dir> holds the
# release's current latest.json and SHA256SUMS.txt, <body-file> its body. On
# success <dist-dir> holds exactly the files to upload: the .dmg, the
# .app.tar.gz and its .sig, the merged latest.json and SHA256SUMS.txt.
# <notes-out> is written only when the body is still the generated one.
# Environment: VERSION, SIGNED_VERSION, FIRST_RELEASE, ATTESTATIONS and the
# TAURI_SIGNING_PRIVATE_KEY pair, as for assemble-release.sh.
set -euo pipefail

leg=$1
release_dir=$2
dist=$3
pubkey=$4
notes_source=$5
body=$6
notes_out=$7
release="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$dist"
if [[ -n "$(find "$dist" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "::error::$dist is not empty; join into a new folder"
  exit 1
fi
node "$release/write-sha256sums.mjs" --check "$leg"
while IFS= read -r -d '' file; do
  mv "$file" "$dist/${file##*/}"
done < <(find "$leg" -maxdepth 1 -type f ! -name SHA256SUMS.txt -print0)
node "$release/check-release-assets.mjs" --version "$VERSION" --dir "$dist" --platforms macos --stage legs

# Signed over the final bytes, like the other payloads: the leg's own
# signature came from a throwaway key and was not uploaded.
bash "$release/sign-payloads.sh" "$pubkey" "$dist/protocol-macos-arm64.app.tar.gz"

merge_args=(--version "$VERSION" --release "$release_dir" --dir "$dist" --notes "$notes_source" --body "$body" --notes-out "$notes_out")
[[ "${FIRST_RELEASE:-false}" == true ]] && merge_args+=(--first-release)
[[ "${ATTESTATIONS:-false}" == true ]] && merge_args+=(--attestations)
node "$release/merge-macos.mjs" "${merge_args[@]}"
node "$release/check-release-assets.mjs" --version "$VERSION" --dir "$dist" --platforms macos --stage joined
