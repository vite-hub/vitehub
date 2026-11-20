---
title: Migrate an app with codemods
description: Preview the edits of every codemod that applies to your app, apply them, and work through the follow-ups in the report.
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

In this tutorial, you run the codemods on an app, read the report, and finish the manual follow-ups. At the end, the app uses the current ViteHub API.

> [!NOTE] Before you start
> You need Node.js 24.15 or newer. Commit your work first so `git diff` shows every edit the codemods make.

## Preview the edits

Run the command in your app folder with `--dry-run`:

```bash [Terminal]
npx @vite-hub/codemods --dry-run
```

The command finds every module in the app that a codemod supports. It prints the combined edits as diffs, then the report, and writes nothing. To migrate another folder, pass it as the first argument: `npx @vite-hub/codemods ./apps/web --dry-run`.

## Apply the edits

Run the same command without `--dry-run`:

```bash [Terminal]
npx @vite-hub/codemods
```

The codemods run one after another, so each one sees the edits of the ones before it. A codemod that cannot migrate the app changes nothing and says why. The others still run.

## Read the report

The report has one part for each codemod that ran:

- Why it ran, such as a module listed in `nuxt.config.ts`, and what it changed.
- The files it changed.
- A numbered list of manual follow-ups, with `file:line` where it applies.
- Notes that need no action in a specific file.
- Commands to run next, such as an install.

Do each follow-up, then run the commands from the report. The codemods do not install packages.

The report also warns if `package.json` requires a Nuxt version older than 5. The codemods do not upgrade Nuxt. Nuxt 5 also stops auto-importing Nitro helpers like `defineEventHandler` in server code. Set `experimental: { nitroAutoImports: true }` to keep them, or import them as the Nuxt 5 build error lists.

## Run one codemod

Pass a codemod name to run only that one:

```bash [Terminal]
npx @vite-hub/codemods define-forms --dry-run
```

Run `npx @vite-hub/codemods --help` to list the codemods.

## Check the result

The command exits with `0` when every codemod finishes, also when the report lists follow-ups. It exits with `1` if a codemod could not migrate. Then build and test the app:

```bash [Terminal]
pnpm build
pnpm test
```

A ViteHub diagnostic that names a former API, such as `DATABASE_LEGACY_CONFIG_FILE`, also names the codemod that fixes it.

::card-group
  :::card{title="Move from a Nuxt module" icon="i-lucide-package" to="/docs/codemods/nuxt-modules"}
  What each module codemod moves, and what it leaves for you.
  :::

  :::card{title="Upgrade ViteHub" icon="i-lucide-arrow-up-circle" to="/docs/codemods/upgrade-vitehub"}
  The renames and moves of each ViteHub API change.
  :::
::
