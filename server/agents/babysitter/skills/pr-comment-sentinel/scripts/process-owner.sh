#!/usr/bin/env bash

pid_owns_path() {
  local pid="$1"
  local expected="$2"
  local command
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null)" || return 1
  case "$command" in
    *"$expected"*) return 0 ;;
    *) return 1 ;;
  esac
}

process_for_path() {
  local expected="$1"
  local pid
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    [ "$pid" = "$$" ] && continue
    if pid_owns_path "$pid" "$expected"; then
      printf '%s\n' "$pid"
      return 0
    fi
  done < <(pgrep -f "$expected" 2>/dev/null || true)
  return 1
}
