---
title: Codemods reference
description: The @vite-hub/codemods command, its options and exit codes, the Node API, and how to add a codemod.
navigation.title: Reference
navigation.order: 5
icon: i-lucide-book-open
---

## Command

```bash [Terminal]
npx @vite-hub/codemods [dir] [--dry-run]
npx @vite-hub/codemods <codemod> [dir] [--dry-run]
```

The package installs the binary `vitehub-codemods`. It requires Node.js 22.18 or newer.

| Argument | Description |
| --- | --- |
| `<codemod>` | Run only this codemod. Without it, the command detects every codemod that applies and runs them all. |
| `dir` | The application directory. Defaults to the current directory. |
| `--dry-run` | Print the planned edits as diffs and the report, and write nothing. |
| `--help`, `-h` | List the codemods and the options. |

### Exit codes

| Code | When |
| --- | --- |
| `0` | Every codemod completed, also when it reported follow-ups. |
| `1` | A codemod could not migrate, no codemod applies and the app has no `nuxt.config`, the directory does not exist, or an argument is unknown. |

### How a migration runs

Without a codemod name, the command copies the app into a scratch directory named `.vitehub-migrate-<random>` inside the app, so packages and the lockfile resolve as they do from the app. It does not copy `.git`, `.nuxt`, `.output`, `.data`, `.vercel`, `.netlify`, `.wrangler`, or `node_modules`. The codemods run one after another on the copy. Then the command writes the combined edits to the app, unless `--dry-run` is set.

- A codemod that cannot migrate changes nothing, and the report says why. The others still run.
- If a codemod would edit a symbolic link or a file inside a linked directory, it stops without its edits. Replace the link with a local file or directory before you retry.
- Existing `.vitehub-migrate` directories stay.

## Node API

```ts [scripts/migrate.ts] fragment
import { formatMigrationReport, formatReport, runCodemod, runMigration } from "@vite-hub/codemods"

const run = await runCodemod("nuxt-safe-runtime-config", { cwd: "./app", dryRun: true })
console.log(formatReport(run))

const migration = await runMigration({ cwd: "./app", dryRun: true })
console.log(formatMigrationReport(migration))
```

| Export | Description |
| --- | --- |
| `runMigration({ cwd?, dryRun? })` | Detects and runs every codemod that applies. Resolves with `{ cwd, dryRun, steps, edits, warnings }`. Each step has its `codemod`, its `detection`, and a `result` or an `error`. |
| `runCodemod(name, { cwd?, dryRun? })` | Runs one codemod and resolves with `{ codemod, cwd, dryRun, result }`. Throws `CodemodError` when it cannot migrate. |
| `detectCodemods(cwd)` | The codemods that apply to the app, each with the reason. |
| `formatReport(run)`, `formatMigrationReport(migration)` | The text report that the CLI prints. |
| `formatDiff({ edits })` | The edits as unified diffs. |
| `codemods`, `findCodemod(name)` | Every codemod, and one by name. |
| `runCli(argv)` | Runs the CLI with the arguments after the binary name, and resolves with the exit code. |
| `CodemodError` | The error of a codemod that cannot migrate the app. |

A `result` has a one-line `summary`, the planned `edits` (`path`, `before`, `after`), the `followUps` (`message`, and `file` and `line` where they apply), `notes`, and `nextSteps`.

## Add a codemod

A codemod is a `Codemod` object:

| Field | Description |
| --- | --- |
| `name` | The name on the command line. |
| `description` | One line for the codemod list. |
| `usage` | The arguments after the name, for the help output. |
| `detect(context)` | Tells whether the app uses what the codemod migrates, with a reason. It must be fast and must not throw for an app that does not use it. |
| `run(context)` | Plans the edits and the follow-ups. It must not write files. The runner writes them, or prints them in a dry run. |

Add the codemod to `packages/codemods/src/registry.ts`. The order there is the order in which the migration runs the codemods. Shared `nuxt.config` and `package.json` helpers are in `packages/codemods/src/shared`.

`packages/codemods/test/real-world/projects.json` pins open source Nuxt apps that use the supported modules. The runner clones each app outside the repository, runs the migration, and checks which codemods ran and what the report says:

```bash [Terminal]
corepack pnpm exec vp run -t @vite-hub/codemods#build
node packages/codemods/test/real-world/run.mjs [--build] [id...]
```

With `--build`, it also moves each app that has a `build` entry to Nuxt 5 nightly with the local `vite-hub` checkout, builds it, starts the server, and checks the probes. Set `VITEHUB_REAL_WORLD_DIR` to choose where the apps go.
