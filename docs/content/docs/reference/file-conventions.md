---
title: File conventions
description: The file paths where ViteHub finds your Definitions, and the name each file gets.
navigation.order: 52
navigation.group: Setup
icon: i-lucide-folder-tree
---

ViteHub finds each Definition (a file that declares one feature, such as a queue) by its path. The path, not an option in the file, sets its name, the Discovery Identity.

A file in the directory convention also turns its feature on, so the app needs no key for it in the ViteHub options. A suffix file does not. See [Definition discovery](/docs/development/definition-discovery#a-definition-file-turns-its-feature-on).

## Definition files

| Definition | Directory convention | Suffix convention | Discovery Identity |
| --- | --- | --- | --- |
| Agent | `server/agents/<name>.ts`, `server/agents/<name>/agent.ts`, or `server/agents/<name>/index.ts` | `<path>.agent.ts` outside `server/` | Relative file or directory path. |
| Auth | `server/auth.ts` | `server.auth.ts` | `default`. Only one Auth Definition is allowed. The app's Definition replaces a Nuxt layer's. |
| Browser | `server/browsers/<path>.ts` | `<path>.browser.ts` | Relative path. |
| Channel | `server/channels/<path>.ts` | `<path>.channel.ts` | Relative path. |
| Comments | `server/comments.ts` | None | `comments`. A named `comments` export picks the live-site API. A default export picks [Comment operations](/docs/comments/operations/get-started). Both use `defineComments()`. |
| Connection | `server/connections/<path>.ts` | None | Normalized relative path. |
| Content | `server/content.ts` | None | `content`. The file default-exports `defineContent()`. Only one Content Definition is allowed. |
| Database | `server/databases/<name>.ts`, or `server/databases/<name>/index.ts` when the Database has other files. `default` is the default database | `src/database.ts` for the default database, or `<path>.database.ts` for a named database | The normalized relative path. `src/database.ts` cannot be mixed with named databases. Nuxt layer Definitions with the same name merge their tables. |
| Queue | `server/queues/<path>.ts` | `<path>.queue.ts` | Normalized relative path. A leading `src/` is removed from suffix identities. |
| Realtime | `server/realtime/<path>.ts` | None | Normalized relative path. |
| Workflow | `server/workflows/<path>.ts`, or a folder with `index.ts` or numbered step files | `<path>.workflow.ts` | Relative file or folder path. Agent Definitions use their Agent name by default. `agentWorkflow(...)` overrides it, and `runtime: false` opts out. |
| Schedule | `server/schedules/<path>.ts` | `<path>.schedule.ts` | Relative path. |
| Source | `server/sources/<path>.ts` | None | Relative path, so `server/sources/docs.ts` is `useSource('docs')`. The file default-exports a Source, such as `glob()` or `github()`. Source is always on, so the file needs no key. |
| Task | `server/tasks/<path>.ts` | None | Nitro task name: the relative path with `/` changed to `:`, so `server/tasks/db/seed.ts` is `db:seed`. An `index` file uses its folder name. Only `vitehub()` on a Vite + Nitro host registers these files. |
| Sandbox Task | `server/sandbox-tasks/<path>/{package.json,index.ts}` | `<path>.sandbox-task.ts` outside `server/sandbox-tasks/` | Folder or suffix path, without the trailing `.sandbox-task`. |
| Workspace | `server/workspaces/<path>.ts`, `server/workspaces/<name>/config.ts`, or `server/agents/<name>/agent.ts` when the Agent declares a Workspace | `<path>.workspace.ts` | Relative path, or the name of the Agent in the same folder. |

- ViteHub normalizes every path. Suffix names drop a leading `src/`.
- In Nuxt, `server/` means the server directory of the app and of each layer it extends. Read [Nuxt layers](/docs/frameworks-hosts/nuxt#nuxt-layers).
- The table shows `.ts`. Other JavaScript and TypeScript module extensions work where the package allows them. The default Database suffix file is exactly `src/database.ts`.
- Test and declaration files are never Definitions, so `server/schedules/digest.test.ts`, `digest.spec.ts`, and `digest.d.ts` can sit next to `digest.ts`.
- Rate Limit has no file convention on purpose. Call `requireRateLimit(event, id, options)` in a normal H3 handler. Its ID is the provider identity.

## Export shape

Most Definition files default-export the package's `define*()` helper. The build reads options only from that default export.

Sandbox Task folders are the exception. `server/sandbox-tasks/<path>/index.ts` default-exports an async `(payload, context) => result` function:

- The `package.json` next to it must set `"type": "module"`.
- Local TypeScript uses relative ESM imports. Bare dependencies must ship ready-to-run JavaScript. CommonJS source and package-local import aliases are not compiled.
- The folder sets the name. `vitehub.sandboxTask.timeout` sets an optional static time limit.

A `<path>.sandbox-task.ts` file still default-exports `defineSandboxTask(...)`.

```ts [server/queues/welcome-email.ts] fragment
import { defineQueue } from 'vite-hub/queue'

export default defineQueue<{ email: string }>({
  handler: async ({ payload }) => {
    await sendWelcomeEmail(payload.email)
  },
})
```

## Define forms

A define function takes one object with `handler` and the options. The file default-exports the result:

| Definition | Form |
| --- | --- |
| Queue | `defineQueue({ handler, concurrency })` |
| Schedule | `defineSchedule({ cron, handler, manual, timeZone })` |
| Sandbox Task | `defineSandboxTask({ handler, timeout, env, project })` |
| Workflow | `defineWorkflow({ handler, native, rootStep })` |
| Content | `export default defineContent({ ... })` |
| Database | `export default defineDatabase({ schema })` in `server/databases/<name>.ts` |

The removed forms fail with a diagnostic that names the new form: `defineQueue(handler)` fails with `QUEUE_INVALID_DEFINITION`, `defineSchedule(cron, handler)` with `SCHEDULE_C0007`, `defineSandboxTask({ run })` with `SANDBOX_TASK_C0014`, `defineWorkflow(name, handler)` with `WORKFLOW_C0015`, a named `content` export with `SOURCE_B0009`, and `server/databases/config.ts` with `DATABASE_LEGACY_CONFIG_FILE`. Use the [`define-forms` codemod](/docs/codemods/upgrade-vitehub#define-forms) to migrate them.

Avoid aggregate named exports for discovered Definitions. The generated Runtime Registry expects one discovered boundary per file convention.

## Colocated Workspace files

Put Workspace files next to the Agent. A `workspace/` folder in the Agent folder becomes the root of that Agent's Workspace files.

```txt [File tree]
server/
  agents/
    docs/
      agent.ts
      workspace/
        README.md
        guides/
          setup.md
```

## Colocated Agent Skills

Put Agent Skills in a `skills/` folder next to the Agent. ViteHub embeds every file. A model Driver reads the folder at `.agents/skills/` in the Agent Workspace. A Provider Driver reads it from a private folder outside its working directory, or from the Sandbox Home. Files under `scripts/` become executable.

```txt [File tree]
server/
  agents/
    review/
      agent.ts
      skills/
        code-review/
          SKILL.md
          scripts/
            review.sh
```

You do not need the `skills()` Capability for this. Use [`skills()`](/docs/agents/capabilities/skills) when the Skill comes from a Workspace or an external Source.

## Markdown templates

Markdown templates and fragments are plain `.md` files. Pass a file path or file URL to `renderMarkdownFile()`. For example, `server/agents/review/agent.ts` can render `new URL('./reply.md', import.meta.url)`.

A `templates/` folder can group files, but ViteHub does not discover or import it. `@./fragment.md` stays literal text, so join extra Markdown yourself before you render. See [Markdown templates](/docs/markdown-template) for examples.

## Email templates

Each Markdown (`.md`) or Vue (`.vue`) file in `server/emails` becomes a typed email renderer. ViteHub drops the folder prefix and the extension, so `server/emails/welcome.md` becomes `#vitehub/emails/welcome` and `server/emails/monthly/recap.vue` becomes `#vitehub/emails/monthly/recap`. The renderer returns `{ subject?, html, text }`. `subject:` frontmatter sets the subject of a Markdown template, and `<EmailSubject>` sets the subject of a Vue template. Files and folders whose names start with `_` are partials, not templates.

Names need non-empty path segments, and no `.` or `..` segments, query strings, fragments, backslashes, or trailing `.md`. Names must be unique across all server directories.

## Cloudflare Worker exports

On Cloudflare, the named exports of `server/cloudflare.ts` become exports of the Worker entry, so a Durable Object, Workflow, or `WorkerEntrypoint` class in your app can run. Bindings and migrations stay in your project Wrangler config. Other hosts ignore the file. Read [Your own Worker classes](/docs/frameworks-hosts/cloudflare#your-own-worker-classes).

## Generated files

Generated files in `.vitehub/**` and host output folders show what discovery and Provider Output made. Edit your Definition files, not these.

## Related

- [Generated files](/docs/development/generated-files)
- [Definitions and discovery](/docs/development/definition-discovery)
- [Import paths](/docs/reference/import-paths)
