#!/usr/bin/env bash
set -euo pipefail

release_tag="$1"
refs="$(gh api "repos/${GITHUB_REPOSITORY}/git/matching-refs/tags/${release_tag}" --jq '.[].ref')"
if grep -Fxq -- "refs/tags/${release_tag}" <<< "$refs"; then
  gh api "repos/${GITHUB_REPOSITORY}/commits/tags/${release_tag}" --jq .sha
fi
