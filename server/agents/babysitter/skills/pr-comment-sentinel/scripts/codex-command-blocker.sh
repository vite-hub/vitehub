#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: $0 owner/repo pr-number [expected-head-sha]" >&2
  echo "Exit 0: no active command or Codex answered; 2: pending/head drift; 3: Codex unavailable." >&2
  exit 0
fi

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || exit 64

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
args=(--merge disabled --comments disabled)
[ "$#" -lt 3 ] || args+=(--expected-head "$3")
snapshot="$("$script_dir/pr-readiness.sh" "${args[@]}" "$1" "$2")"
lane="$(jq -r '.codexLane.state' <<< "$snapshot")"

case "$lane" in
  missing|reviewed)
    exit 0
    ;;
  unavailable)
    jq -r '"unavailable: PR #\(.number) Codex review quota is exhausted for head \(.head); exact-head fallback review is allowed"' <<< "$snapshot"
    exit 3
    ;;
  pending)
    jq -r '"blocked: PR #\(.number) is waiting on @codex command \(.codexLane.command.id) from \(.codexLane.command.at) for head \(.head)"' <<< "$snapshot"
    exit 2
    ;;
  *)
    echo "blocked: unknown Codex lane state $lane" >&2
    exit 2
    ;;
esac
