#!/usr/bin/env bash
# Turns the build legs' artifacts into a complete release folder: checks each
# leg's SHA256SUMS.txt (transfer integrity), signs the three updater payloads,
# verifies the new signatures against the public key the apps trust, and writes
# latest.json, SHA256SUMS.txt and the release notes. The draft job runs it with
# the production key, the preview job of a dry run with a throwaway key.
#
#   scripts/release/assemble-release.sh <legs-dir> <dist-dir> <notes-source> <pubkey-file> <notes-out>
#
# <legs-dir> holds one folder per downloaded leg artifact. <pubkey-file> holds
# the base64 public key (plugins.updater.pubkey or a throwaway key's .pub).
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
payloads=(protocol-windows-x64-setup.exe protocol-macos-arm64.app.tar.gz protocol-linux-x86_64.AppImage)

mkdir -p "$dist"
for leg in "$legs"/*/; do
  node "$release/write-sha256sums.mjs" --check "$leg"
  find "$leg" -maxdepth 1 -type f ! -name SHA256SUMS.txt -exec mv -n {} "$dist/" \;
done
node "$release/check-release-assets.mjs" --version "$VERSION" --dir "$dist" --stage legs

# Signed last, over the final bytes: the legs' own updater signatures (from a
# throwaway key, if any) were not uploaded.
sign_args=(signer sign)
verify_args=(--pubkey "$pubkey")
if [[ "${SIGNED_VERSION:-false}" == true ]]; then
  sign_args+=(--app-version "$VERSION")
  verify_args+=(--version "$VERSION")
else
  echo "::warning::Signing without --app-version: apps with requireSignedVersion will reject these signatures"
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
  sign_args+=(--password "")
fi
# The tauri-cli of frontend/pnpm-lock.yaml (pnpm install must have run).
for payload in "${payloads[@]}"; do
  node "$repo/frontend/node_modules/@tauri-apps/cli/tauri.js" "${sign_args[@]}" "$dist/$payload"
done
node "$release/verify-updater-signature.mjs" "${verify_args[@]}" "${payloads[@]/#/$dist/}"

node "$release/make-latest-json.mjs" --version "$VERSION" --notes "$notes_source" --dir "$dist"
node "$release/write-sha256sums.mjs" "$dist"
notes_args=(--version "$VERSION" --notes "$notes_source" --sums "$dist/SHA256SUMS.txt")
[[ "${FIRST_RELEASE:-false}" == true ]] && notes_args+=(--first-release)
[[ "${ATTESTATIONS:-false}" == true ]] && notes_args+=(--attestations)
node "$release/render-notes.mjs" "${notes_args[@]}" > "$notes_out"
node "$release/check-release-assets.mjs" --version "$VERSION" --dir "$dist"
