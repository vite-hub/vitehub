# Agent docs eval

This eval measures whether `::agent-only` content helps a coding agent use ViteHub correctly on the first try.

Each task runs twice in a new Vite project:

- `agent`: the docs as agents get them from `/raw`, with agent-only blocks.
- `baseline`: the same docs without agent-only blocks. This is what a human sees.

The runner starts Claude Code headless in each project. It turns off Bash, web access, Skills, subagents, and MCP servers, and it loads no user settings. The agent can only read the local docs and write files. Static checks then grade the files that the agent wrote.

## Run

From `docs/`:

```sh
corepack pnpm run eval:agent-docs
corepack pnpm run eval:agent-docs -- --tasks kv-visit-counter --repeat 3 --model opus --keep
```

The runner prints one line per run, the failed checks, and a summary per variant. It writes `results.json` to a temporary directory. `--keep` also keeps each project for inspection. Every run costs model tokens.

## Add a task

Add an entry to [tasks.json](tasks.json). Each check names a file path pattern, a source pattern, and an optional `"expect": false` for code that must not appear. Base the checks on the current tutorial or Server API page, not on memory.

## Use the result

When a check fails in both variants, the docs do not give the agent what it needs. Find the cause in the kept project, then:

1. Fix the visible page when a human would also miss the fact.
2. Add an `::agent-only` block when only an agent needs it, such as an exact CLI command or a mistake that agents make.
3. Run the task again with `--repeat 3` or more and compare the two variants.

Remove an agent-only block when the two variants score the same over several runs. The checks are static. They do not install packages, typecheck, or run the app.
