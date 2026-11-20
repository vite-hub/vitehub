# Architecture decision records

An ADR keeps a decision that the code cannot show and that a future change would break without knowing it. Code comments are banned (see `.agents/skills/delete-comment`), so these decisions live here.

Name a file `NNNN-short-title.md` with the next free number. Use this shape:

```md
# NNNN. Title in plain words

Status: Accepted

## Context

The constraint or the failure that forced the decision.

## Decision

What the code does, and the symbols that do it.

## Consequences

What a change must keep, and what it costs.
```

Name files and symbols, not line numbers. When a decision changes, set the old record to `Status: Superseded by NNNN` and add a new one.
