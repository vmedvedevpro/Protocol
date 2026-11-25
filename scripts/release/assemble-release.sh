#!/usr/bin/env bash
# Turns the Windows and Linux legs' artifacts into a release folder: checks
# each leg's SHA256SUMS.txt (transfer integrity), signs the two updater
# payloads, verifies the new signatures against the public key the apps trust,
# and writes latest.json, SHA256SUMS.txt and the release notes for those two
# platforms. The draft job runs it with the production key, the preview job of
# a dry run with a throwaway key. macOS joins the result later through
# join-macos.sh, so a release never waits for a macOS runner (#164).
#
#   scripts/release/assemble-release.sh <legs-dir> <dist-dir> <notes-source> <pubkey-file> <notes-out>
#
# <legs-dir> holds one folder per downloaded leg artifact, leg-windows and
# leg-linux only. <pubkey-file> holds the base64 public key
# (plugins.updater.pubkey or a throwaway key's .pub).
# Environment:
#   VERSION                             X.Y.Z or X.Y.Z-rc.N
#   SIGNED_VERSION                      true: sign with --app-version (tauri-cli 2.12+)
#   FIRST_RELEASE, ATTESTATIONS         true/false, wording of the notes
#   TAURI_SIGNING_PRIVATE_KEY           the signing key (content, not a path)
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password; empty for a throwaway key
set -euo pipefail

legs=$1
dist=$2
notes_source=$3
pubkey=$4
notes_out=$5
repo=$(cd "$(dirname "$0")/../.." && pwd)
release="$repo/scripts/release"
platforms=windows,linux
payloads=(protocol-windows-x64-setup.exe protocol-linux-x86_64.AppImage)

mkdir -p "$dist"
# Files left from an earlier run would pass the name check below and be signed
# and hashed as if a leg had built them.
if [[ -n "$(find "$dist" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "::error::$dist is not empty; assemble into a new folder"
  exit 1
fi
for leg in "$legs"/*/; do
  node "$release/write-sha256sums.mjs" --check "$leg"
  while IFS= read -r -d '' file; do
    name=${file##*/}
    if [[ -e "$dist/$name" ]]; then
      echo "::error::$name comes from more than one leg"
      exit 1
    fi
    mv "$file" "$dist/$name"
  done < <(find "$leg" -maxdepth 1 -type f ! -name SHA256SUMS.txt -print0)
done
node "$release/check-release-assets.mjs" --version "$VERSION" --dir "$dist" --platforms "$platforms" --stage legs

# Signed last, over the final bytes: the legs' own updater signatures (from a
# throwaway key, if any) were not uploaded.
bash "$release/sign-payloads.sh" "$pubkey" "${payloads[@]/#/$dist/}"

node "$release/make-latest-json.mjs" --version "$VERSION" --notes "$notes_source" --dir "$dist" --platforms "$platforms"
node "$release/write-sha256sums.mjs" "$dist"
notes_args=(--version "$VERSION" --notes "$notes_source" --sums "$dist/SHA256SUMS.txt")
[[ "${FIRST_RELEASE:-false}" == true ]] && notes_args+=(--first-release)
[[ "${ATTESTATIONS:-false}" == true ]] && notes_args+=(--attestations)
node "$release/render-notes.mjs" "${notes_args[@]}" > "$notes_out"
node "$release/check-release-assets.mjs" --version "$VERSION" --dir "$dist" --platforms "$platforms"
