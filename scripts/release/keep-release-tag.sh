#!/usr/bin/env bash
# Reads a release by its id and makes sure it still carries its tag (#231).
#
#   scripts/release/keep-release-tag.sh <release-id> <tag> <out-json>
#
# The v1.0.0-rc.2 draft ended up with tag_name untagged-38ca44aeba8f67a5b7a9
# instead of its tag: `gh release view <tag>` no longer found it, the
# summary's `gh release edit <tag>` failed, and publishing it from the web
# page could have created a tag of that name. The cause is not known; the logs
# show the right tag right after the draft was created and while join-macos
# uploaded to it, so draft and join-macos both call this after they write to
# the release.
#
# A draft whose tag_name differs is patched back to <tag> and read again; the
# call fails when it still differs. A published release is never retagged:
# publishing already created a git tag of the name it had, so moving it is
# for the owner to decide. <out-json> receives GET /repos/{repo}/releases/{id}
# as last read. Environment: GITHUB_REPOSITORY, and GH_TOKEN for gh.
set -euo pipefail

id=$1
tag=$2
out=$3
endpoint="repos/$GITHUB_REPOSITORY/releases/$id"

gh api "$endpoint" > "$out"
actual=$(jq -r .tag_name "$out")
if [[ "$actual" == "$tag" ]]; then
  exit 0
fi
if [[ "$(jq -r .draft "$out")" != true ]]; then
  echo "::error::Release $id is published with the tag $actual, not $tag; fix it by hand"
  exit 1
fi
echo "::warning::Draft $id has the tag $actual instead of $tag; setting it back"
gh api -X PATCH "$endpoint" -f tag_name="$tag" > /dev/null
gh api "$endpoint" > "$out"
actual=$(jq -r .tag_name "$out")
if [[ "$actual" != "$tag" ]]; then
  echo "::error::Draft $id still has the tag $actual after it was set to $tag"
  exit 1
fi
echo "Draft $id has the tag $tag again"
