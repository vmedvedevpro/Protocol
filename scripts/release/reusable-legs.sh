#!/usr/bin/env bash
# Prints `<leg>=<run id>` for each release leg (windows, macos, linux): the
# newest push run of release.yml on main whose build of that leg succeeded
# from the same inputs as $GITHUB_SHA and whose leg-<leg> artifact is not
# expired, or `<leg>=` when there is none. release.yml then downloads that
# artifact instead of building the leg again (#244), so a tag on a green main
# commit builds only what that commit's dry run did not.
#
# The same inputs: no change between the two commits outside the
# documentation, CHANGELOG.md, release.yml and this script, and the same call
# of the leg (its `uses` and `with`) in release.yml. A leg takes nothing
# else: the version comes from the tree, no build embeds the commit, and
# signing and the draft come after the legs.
#
#   GITHUB_REPOSITORY=owner/repo GITHUB_SHA=<commit> [GITHUB_RUN_ID=<id>] \
#     GH_TOKEN=<token with actions: read> bash scripts/release/reusable-legs.sh
set -euo pipefail

workflow=.github/workflows/release.yml
self=scripts/release/reusable-legs.sh

# The job build-<leg> of release.yml at commit $2, without its needs and if
# (which name this script's job) and without comments and blank lines.
leg_call() {
  git show "$2:$workflow" | awk -v job="  build-$1:" '
    $0 == job { on = 1; next }
    on && /^  [^ ]/ { exit }
    on && !/^    (needs|if):/ && !/^ *(#|$)/'
}

# Whether commit $2 builds leg $1 from the same inputs as $GITHUB_SHA.
same_inputs() {
  git cat-file -e "$2^{commit}" 2>/dev/null || return 1
  git diff --quiet "$2" "$GITHUB_SHA" -- . \
    ':(exclude,glob)docs/**' ':(exclude,glob).github/**/*.md' ':(exclude,glob)site/**' \
    ':(exclude)AGENTS.md' ':(exclude)ARCHITECTURE.md' ':(exclude)CHANGELOG.md' \
    ":(exclude)$workflow" ":(exclude)$self" || return 1
  [[ "$(leg_call "$1" "$2")" == "$(leg_call "$1" "$GITHUB_SHA")" ]]
}

# Reusing is only a shortcut: when GitHub does not answer, the leg is built,
# with a warning (on stderr, which the runner reads too; stdout is the output).
if ! runs=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/release.yml/runs?branch=main&event=push&per_page=50" \
  --jq '.workflow_runs[] | "\(.id) \(.head_sha)"'); then
  echo "::warning::Could not list the runs of release.yml; every leg is built" >&2
  runs=
fi

for leg in windows macos linux; do
  found=
  while read -r id sha; do
    [[ -n "$id" && "$id" != "${GITHUB_RUN_ID:-}" ]] || continue
    same_inputs "$leg" "$sha" || continue
    # A leg that run took from another run is skipped there, with no
    # artifact of its own; an older run then has it.
    if ! built=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs?per_page=100" \
      --jq ".jobs[] | select(.name == \"build-$leg / $leg\") | .conclusion"); then
      echo "::warning::Could not read the jobs of run $id; not taking $leg from it" >&2
      continue
    fi
    [[ "$built" == success ]] || continue
    if ! artifact=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id/artifacts?name=leg-$leg" \
      --jq '.artifacts[] | select(.expired | not) | .id'); then
      echo "::warning::Could not read the artifacts of run $id; not taking $leg from it" >&2
      continue
    fi
    [[ -n "$artifact" ]] || continue
    found=$id
    break
  done <<< "$runs"
  echo "$leg=$found"
done
