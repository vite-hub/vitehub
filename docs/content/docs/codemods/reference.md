---
title: Codemods reference
description: The @vite-hub/codemods command, its options and exit codes, the Node API, and how to add a codemod.
navigation.title: Reference
navigation.order: 5
icon: i-lucide-book-open
---

## Command

```bash [Terminal]
npx @vite-hub/codemods [dir] [--dry-run] [--nuxt-nightly]
npx @vite-hub/codemods <codemod> [dir] [--dry-run] [--nuxt-nightly]
```

The package installs the binary `vitehub-codemods`. It requires Node.js 22.12 or newer. When the shell runs a Node.js version before 24.15, the report adds a note, because `vite-hub` requires Node.js 24.15 or newer.

| Argument | Description |
| --- | --- |
| `<codemod>` | Run only this codemod. Without it, the command detects every codemod that applies and runs them all. |
| `dir` | The application directory. Defaults to the current directory. |
| `--dry-run` | Print the planned edits as diffs and the report, and write nothing. |
| `--nuxt-nightly` | When `package.json` allows a Nuxt version before 4.7, set `nuxt` to `npm:nuxt-nightly@5x` and migrate. Without it, a codemod that adds `vite-hub/nuxt` stops on a Nuxt version before 4.7. |
| `--help`, `-h` | List the codemods and the options. |

### Exit codes

| Code | When |
| --- | --- |
| `0` | Every codemod completed, also when it reported follow-ups, or no codemod applies. |
| `1` | A codemod could not migrate, a codemod that adds `vite-hub/nuxt` found a Nuxt version before 4.7 without `--nuxt-nightly` (`CODEMODS_NUXT_UNSUPPORTED`), the directory has neither `package.json` nor `nuxt.config`, `nuxt.config` does not parse, the directory does not exist, or an argument is unknown. |

### How a migration runs

When a codemod adds `vite-hub/nuxt`, the command reads the `nuxt` range in `package.json`, or the version that a pnpm `catalog:` sets in `pnpm-workspace.yaml`, because `vite-hub/nuxt` needs Nitro 3:

| Nuxt range | What the command does |
| --- | --- |
| Allows only Nuxt 5, such as `npm:nuxt-nightly@5x` or `^5.0.0` | Nothing more. |
| Allows Nuxt 4.7 and no earlier version, such as `^4.7.0` or `>=4.7.0 <6` | Makes sure that `package.json` lists `nitro` at `^3.0.261103-rc`, the range that Nuxt 4.7 builds the server with. It adds `nitro` to `dependencies` when no section lists it. It replaces a `nitro` range outside `^3.0.261103-rc`, such as `2.2.28` or `3.0.261102-rc`, also one that a pnpm `catalog:` sets. The report notes each change. |
| Allows a version before 4.7, such as `^4.2.0` or `>=4.6.0` | Stops before it writes anything, also with `--dry-run` (`CODEMODS_NUXT_UNSUPPORTED`). With `--nuxt-nightly`, it sets `nuxt` to `npm:nuxt-nightly@5x` in `package.json` first, and the report notes the change. |

The command never changes the Nuxt version without `--nuxt-nightly`. The upgrade codemods that `vitehub migrate` runs do not add `vite-hub/nuxt`, so they do not check the Nuxt version.

If a codemod would edit a symbolic link or a file inside a linked directory, it stops without its edits. This applies with or without a codemod name, and also with `--dry-run`. Replace the link with a local file or directory before you retry.

Without a codemod name, the command copies the app into a scratch directory named `.vitehub-migrate-<random>` inside the app, so packages and the lockfile resolve as they do from the app. It does not copy `.git`, `.nuxt`, `.output`, `.data`, `.vercel`, `.netlify`, `.wrangler`, or `node_modules`. The codemods run one after another on the copy. Then the command writes the combined edits to the app, unless `--dry-run` is set.

- A codemod that cannot migrate changes nothing, and the report says why. The others still run.
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
| `runMigration({ cwd?, dryRun?, codemods?, nuxtNightly? })` | Detects and runs every codemod of `codemods` (default: all) that applies. Resolves with `{ cwd, dryRun, steps, edits, notes, supported }`. Throws `CODEMODS_NUXT_UNSUPPORTED` before it writes anything when a codemod that adds `vite-hub/nuxt` finds a Nuxt version before 4.7 and `nuxtNightly` is not set. Each step has its `codemod`, its `detection`, and a `result` or an `error`. |
| `runCodemod(name, { cwd?, dryRun?, nuxtNightly? })` | Runs one codemod and resolves with `{ codemod, cwd, dryRun, result }`. Throws `CODEMODS_BLOCKED`, `CODEMODS_NUXT_UNSUPPORTED`, or `CODEMODS_UNKNOWN` for an unknown name, when it cannot migrate. |
| `detectCodemods(cwd, candidates?)` | The codemods that apply to the app, each with the reason. |
| `formatReport(run)`, `formatMigrationReport(migration, nextSteps?)` | The text report that the CLI prints. `nextSteps` adds steps after those of the codemods. |
| `formatDiff({ edits })` | The edits as unified diffs. |
| `codemods`, `upgradeCodemods`, `findCodemod(name)` | Every codemod, the ones that `vitehub migrate` runs, and one by name. |
| `runCli(argv)` | Runs the CLI with the arguments after the binary name, and resolves with the exit code. |
| `isCodemodError(error)` | Whether the error is a codemod that cannot migrate the app. |

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
| `requiresNitro3` | Set it to `true` when the codemod adds `vite-hub/nuxt`. The runner then adds `nitro` on Nuxt 4.7, and stops on a Nuxt version before 4.7, or sets Nuxt 5 nightly with `nuxtNightly`. |

Add the codemod to `packages/codemods/src/registry.ts`. The order there is the order in which the migration runs the codemods. Shared `nuxt.config` and `package.json` helpers are in `packages/codemods/src/shared`.

`packages/codemods/test/real-world/projects.json` pins open source Nuxt apps that use the supported modules. The runner clones each app outside the repository, runs the migration, and checks which codemods ran and what the report says:

```bash [Terminal]
corepack pnpm exec vp run -t @vite-hub/codemods#build
node packages/codemods/test/real-world/run.mjs [--build] [id...]
```

With `--build`, it also moves each app that has a `build` entry to Nuxt 5 nightly with the local `vite-hub` checkout, builds it, starts the server, and checks the probes. Set `VITEHUB_REAL_WORLD_DIR` to choose where the apps go.
