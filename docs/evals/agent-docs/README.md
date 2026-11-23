# Agent docs eval

This eval measures whether `::agent-only` content helps a coding agent use ViteHub correctly on the first try.

Each task runs twice in a new Vite project:

- `agent`: the docs as agents get them from `/raw`, with agent-only blocks.
- `baseline`: the same docs without agent-only blocks. This is what a human sees.

The runner starts Claude Code headless in each project. It turns off Bash, web access, Skills, subagents, and MCP servers, and it loads no user settings. The agent can only read the local docs and write files. Static checks then grade the files that the agent wrote.

These two variants measure the raw docs only. To measure the `vitehub` skill as well, add the `skill` variant with `--variants agent,skill`. It uses the `agent` docs, copies `docs/skills/vitehub` to `.claude/skills/vitehub` in the project, and keeps the Skill tool on. Run the `existing-app-*` tasks with it: they check whether the agent finds the built-in from the skill's lookup table.

## Run

From `docs/`:

```sh
corepack pnpm run eval:agent-docs
corepack pnpm run eval:agent-docs -- --tasks kv-visit-counter --repeat 3 --model opus --keep
corepack pnpm run eval:agent-docs -- --tasks existing-app-proxy-sign-in,existing-app-sqlite-backup,existing-app-generate-migration --variants agent,skill
```

The runner prints one line per run, the failed checks, and a summary per variant. It writes `results.json` to a temporary directory. `--keep` also keeps each project for inspection. Every run costs model tokens.

## Add a task

Add an entry to [tasks.json](tasks.json). Each check names a file path pattern, a source pattern, and an optional `"expect": false` for code that must not appear. For a JSON file, `"json": ["scripts", "db:generate"]` tests the pattern against that one string value instead of the whole file. Match where the code takes effect, such as inside the plugin list, so code that is written but never used fails. Base the checks on the current tutorial or Server API page, not on memory.

To set a task in an existing app, add `files`: each key is a path in the project and each value is its source. They replace the default `package.json` and `vite.config.ts` when they name them. Write the prompt as the app's developer would: name the problem, not the ViteHub feature, so the run shows whether the agent finds the built-in.

## Use the result

When a check fails in both variants, the docs do not give the agent what it needs. Find the cause in the kept project, then:

1. Fix the visible page when a human would also miss the fact.
2. Add an `::agent-only` block when only an agent needs it, such as an exact CLI command or a mistake that agents make.
3. Run the task again with `--repeat 3` or more and compare the two variants.

Remove an agent-only block when the two variants score the same over several runs. The checks are static. They do not install packages, typecheck, or run the app.
