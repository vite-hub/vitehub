# Architecture decision records

An ADR keeps a decision that the code cannot show and that a future change would break without knowing it. Code comments are banned (see [repo.md](repo.md)), so these decisions live here.

Each area has one decision log: `adr/<package>.md` for `packages/<package>`, and `adr/repo.md` for decisions that cover the repository or several packages. Read the log of a package before you change it. Add an entry in this shape:

```md
## The decision in one sentence

`symbol` in `packages/<package>/src/file.ts`.

**Context:** The constraint or the failure that forced the decision.

**Decision:** What the code does.

**Consequences:** What a change must keep, and what breaks if it does not.
```

Name files and symbols, not line numbers. When a decision changes, edit or delete its entry in the same pull request. A log that describes old code is worse than no log.
