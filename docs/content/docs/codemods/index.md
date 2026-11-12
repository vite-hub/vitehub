---
title: Codemods
description: Move an app to ViteHub, or to a newer ViteHub API, with npx @vite-hub/codemods. Each codemod edits what it can change safely and reports the rest.
navigation.title: Overview
navigation.order: 1
icon: i-lucide-wand-sparkles
---

A codemod is a program that edits your source files for you. `@vite-hub/codemods` moves an app to ViteHub, or to a newer ViteHub API. Each codemod edits the files that it can change safely. It ends with a report: the files that it changed, and a numbered list of manual follow-ups with `file:line` where it applies.

```bash [Terminal]
npx @vite-hub/codemods --dry-run
```

The command finds every module in the app that a codemod supports and runs those codemods, one after another. `--dry-run` prints the edits as diffs and writes nothing. The package requires Node.js 22.18 or newer.

## Move from a Nuxt module

| Codemod | Moves |
| --- | --- |
| [`nuxt-safe-runtime-config`](/docs/codemods/nuxt-modules#nuxt-safe-runtime-config) | A Nuxt app from the `nuxt-safe-runtime-config` module to ViteHub [Env](/docs/env) |
| [`t3-env`](/docs/codemods/nuxt-modules#t3-env) | A Nuxt app from `@t3-oss/env-nuxt` `createEnv()` to ViteHub Env |
| [`resend`](/docs/codemods/nuxt-modules#resend) | `nuxt-resend` and Resend SDK `emails.send()` calls to ViteHub [Email](/docs/email) |
| [`nuxt-cron`](/docs/codemods/nuxt-modules#nuxt-cron) | `nuxt-cron` jobs to ViteHub [Schedule](/docs/schedule) Definitions |

## Upgrade ViteHub

| Codemod | Moves |
| --- | --- |
| [`define-forms`](/docs/codemods/upgrade-vitehub#define-forms) | The former define forms of Schedule, Sandbox Task, Content, and Database to the one form of each |
| [`vitehub-options`](/docs/codemods/upgrade-vitehub#vitehub-options) | The options that moved in `vitehub()`: `logs` into `observability`, Env declarations into `vitehub({ env })`, and `contentImportBase` removed |
| [`queue-workflow-verbs`](/docs/codemods/upgrade-vitehub#queue-workflow-verbs) | The old Queue and Workflow verbs to `sendQueue`, `useQueue`, `startWorkflow`, and `resumeWorkflow` |
| [`one-entry-imports`](/docs/codemods/upgrade-vitehub#one-entry-imports) | Imports of subpaths that moved into one entry per concept, and `vite-hub/task` to `nitro/task` |
| [`agent-surface`](/docs/codemods/upgrade-vitehub#agent-surface) | The old Agent names to `invoker`, `loadAgent()`, `agentWorkflow()`, `extends`, and the merged Agent entries |

The codemods do not upgrade Nuxt or install packages. ViteHub supports Nuxt 5 and Nitro 3 only.

::card-group
  :::card{title="Get started" icon="i-lucide-rocket" to="/docs/codemods/get-started"}
  Preview a migration, run it, and work through the report.
  :::

  :::card{title="Reference" icon="i-lucide-book-open" to="/docs/codemods/reference"}
  CLI options, exit codes, the Node API, and how to add a codemod.
  :::
::
