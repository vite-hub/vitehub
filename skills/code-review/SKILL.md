---
name: code-review
description: Review a branch, pull request, or work-in-progress diff against a fixed point along independent Engineering and Spec axes. Use for code-review requests, pull requests, or "review since X" comparisons.
---

Review the diff between `HEAD` and a fixed point along two independent axes:

- **Engineering** — correctness, security, repository standards, maintainability, and simplicity.
- **Spec** — missing, extra, or incorrectly implemented requirements.

Run both reviews in parallel read-only sub-agents, then validate their findings before reporting them separately.

## Process

### 1. Bound the diff

Use the caller's fixed point. When none is supplied, resolve the repository's default branch and use its merge-base with `HEAD`.

Verify the ref and capture these commands once:

```sh
git diff <fixed-point>...HEAD
git log <fixed-point>..HEAD --oneline
```

Stop when the ref is invalid or the diff is empty.

### 2. Resolve the spec

Use the first available source:

1. A pull request body, issue, PRD, or path supplied by the caller.
2. An issue linked from pull request or commit metadata.
3. A matching file under `docs/`, `specs/`, or `.scratch/`.

When no spec exists, skip the Spec reviewer and report that boundary. Never invent requirements.

### 3. Collect engineering evidence

Find repository instructions and coding standards such as `AGENTS.md`, `CONTRIBUTING.md`, or `CODING_STANDARDS.md`. Read [references/simplicity.md](references/simplicity.md) and give it to the Engineering reviewer. When the diff crosses configuration forms, generated/runtime/consumer representations, providers, frameworks, output modes, or resource lifecycles, also read and provide [references/contract-coverage.md](references/contract-coverage.md). Treat automated formatting and lint rules as tooling concerns rather than review findings.

### 4. Review in parallel

Send one parallel dispatch containing both prompts. Give each reviewer the diff command and commit list.

**Engineering reviewer** — also provide the repository standards, the spec as a scope boundary, and the simplicity lens:

> Inspect only the diff. Report every actionable P0–P3 correctness, security, data-loss, concurrency, compatibility, standards, maintainability, contract-coverage, or justified simplicity finding. For each finding, cite the tightest file and line, explain the concrete failure mechanism and consequence, and give the smallest safe fix. Repository rules, correctness, and explicit requirements override heuristics. Omit praise, tooling-enforced style, and concerns without a concrete failure path. Stay under 500 words.

**Spec reviewer** — also provide the spec:

> Compare the diff with the spec. Report missing or partial requirements, unrequested behavior, and implementations that appear present but behave incorrectly. Cite both the requirement and the tightest diff location; explain the user-visible consequence and smallest correction. Stay under 400 words.

Use `P0` for catastrophic release, security, or data-loss failures; `P1` for merge-blocking defects; `P2` for material behavior or maintenance risks; and `P3` for worthwhile non-blocking corrections.

### 5. Validate and report

Re-read every cited hunk and source. Remove unsupported, duplicate, or out-of-scope findings; do not invent replacements for rejected findings.

Report validated findings by severity under `## Engineering` and `## Spec`. Keep the axes separate so strength on one cannot mask failure on the other. If an axis has no findings, say so. End with finding counts by severity and axis, without an overall score or merge verdict.
