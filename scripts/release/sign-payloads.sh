#!/usr/bin/env bash
# Signs updater payloads with the key in TAURI_SIGNING_PRIVATE_KEY and
# verifies the new signatures against the public key the apps trust. Used by
# assemble-release.sh (Windows and Linux) and join-macos.sh (macOS), so both
# halves of a release are signed and checked the same way.
#
#   scripts/release/sign-payloads.sh <pubkey-file> <payload>...
#
# Writes <payload>.sig next to each payload. Environment:
#   VERSION                             X.Y.Z or X.Y.Z-rc.N
#   SIGNED_VERSION                      true: sign with --app-version (tauri-cli 2.12+)
#   TAURI_SIGNING_PRIVATE_KEY           the signing key (content, not a path)
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password; empty for a throwaway key
set -euo pipefail

pubkey=$1
shift
repo=$(cd "$(dirname "$0")/../.." && pwd)

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
for payload in "$@"; do
  node "$repo/frontend/node_modules/@tauri-apps/cli/tauri.js" "${sign_args[@]}" "$payload"
done
node "$repo/scripts/release/verify-updater-signature.mjs" "${verify_args[@]}" "$@"
