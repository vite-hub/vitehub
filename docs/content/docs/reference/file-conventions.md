---
title: File conventions
description: Reference the discovery paths that produce ViteHub Discovered Definitions and Discovery Identity.
navigation.order: 52
icon: i-lucide-folder-tree
---

File conventions produce Discovered Definitions. Discovery Identity comes from the discovery location, not from arbitrary inline Definition Options.

## Definition files

| Definition | Directory convention | Suffix convention | Discovery Identity |
| --- | --- | --- | --- |
| Agent | `server/agents/<name>.ts`, `server/agents/<name>/agent.ts`, or `server/agents/<name>/index.ts` | `<path>.agent.ts` outside `server/` | Relative file or directory path. A leading `src/` is removed from suffix identities. |
| Auth | `server/auth.ts` | `server.auth.ts` | `default`. Only one Auth Definition is allowed. |
| Browser | `server/browsers/<path>.ts` | `<path>.browser.ts` | Normalized relative path. A leading `src/` is removed from suffix identities. |
| Channel | `server/channels/<path>.ts` | `<path>.channel.ts` | Normalized relative path. A leading `src/` is removed from suffix identities. |
| Database | `server/databases/config.ts` for one default database, or `server/databases/<name>/config.ts` for named databases | `src/database.ts` for the default database, or `<path>.database.ts` for a named database | `default` or the normalized relative path. Default and named modes cannot be mixed. |
| Queue | `server/queues/<path>.ts` | `<path>.queue.ts` | Normalized relative path. A leading `src/` is removed from suffix identities. |
| Workflow | `server/workflows/<path>.ts` or a folder containing `index.ts` or numbered step files | `<path>.workflow.ts` | Normalized relative file or folder path. Agent Definitions contribute their Agent identity by default, `workflow(...)` can override it, and `runtime: false` opts out. |
| Schedule | `server/schedules/<path>.ts` | `<path>.schedule.ts` | Normalized relative path. A leading `src/` is removed from suffix identities. |
| Sandbox | `server/sandboxes/<path>/{package.json,index.ts}` | `<path>.sandbox.ts` outside `server/sandboxes/` | Normalized folder or suffix path, without a trailing `.sandbox` segment. |
| Workspace | `server/workspaces/<path>.ts`, `server/workspaces/<name>/config.ts`, or `server/agents/<name>/agent.ts` when the Agent declares a Workspace | `<path>.workspace.ts` | Normalized relative path or the colocated Agent name. |

The table uses `.ts` for brevity. Directory and suffix patterns accept JavaScript and TypeScript module variants where the owning package permits them. `src/database.ts` is the exact default Database suffix-mode file.

Rate Limit deliberately has no file convention. Call `requireRateLimit(event, id, options)` inside ordinary H3 handlers; its explicit ID is the provider identity.

## Export shape

Most discovered Definition files default-export the package-owned Definition Boundary Helper. This keeps Build-Extracted Definition Options limited to the direct discovered default export.

Canonical Sandbox package projects are the exception: `server/sandboxes/<path>/index.ts` default-exports an async `(payload, context) => result` function. The adjacent `package.json` must set `"type": "module"`. Local TypeScript uses explicit relative ESM imports, while bare dependencies must expose runtime-ready JavaScript; CommonJS source and package-local import aliases are not compiled. The folder supplies the Definition identity, and optional static wall-clock policy comes from `vitehub.sandbox.timeout`. Free-form `<path>.sandbox.ts` files still default-export `defineSandbox(...)`.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  await sendWelcomeEmail(job.payload.email)
})
```

Avoid aggregate named exports for discovered Definitions. The generated Runtime Registry expects one discovered boundary per file convention.

## Colocated Workspace files

Agent folders can colocate Workspace content beside the Agent Definition. When a folder contains `workspace/`, that folder becomes the Workspace Source Root for the colocated Workspace Definition.

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

An Agent folder can own Skills in an adjacent `skills/` directory. ViteHub recursively embeds every file during discovery and materializes the directory into the Provider Workspace. Existing files remain in place, and files below a `scripts/` directory become executable.

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

This convention needs no `skills()` Capability declaration. Use [`skills()`](/docs/capabilities/skills) when the Skill comes from a Workspace or external Source instead of the Agent folder.

## Colocated Agent Home

An Agent folder with a Box can own static Home files in an adjacent `home/` directory. ViteHub recursively embeds dotfiles and binary files into the existing `box.home.files` plan.

```txt [File tree]
server/
  agents/
    babysitter/
      agent.ts
      home/
        .gitconfig
        .codex/
          config.toml
```

Colocated Home files are build inputs even when Git ignores them. Use `box.home.state` for credentials or other files that must refresh or persist between Box sessions. Explicit `box.home.files` remains available for dynamic contents, and cannot claim the same target as a colocated file.

## Markdown templates

Ordinary Markdown files under `server/templates` form the application template catalog. ViteHub removes the directory prefix and `.md` extension to produce each typed template name, so `server/templates/pull-request.md` becomes `pull-request` and `server/templates/review/pull-request.md` becomes `review/pull-request`.

Use a `.template.md` suffix only when a private template belongs beside its caller and should be imported directly. ViteHub excludes `.template.md` files from the named catalog. See [Markdown templates](/docs/reference/markdown-templates) for rendering and generated-type examples.

## Generated files

Generated files live under `.vitehub/**` and host output directories.
They prove discovery and Provider Output, but the source Definition files remain the authoring surface.

## Related

- [Generated files](/docs/development/generated-files)
- [Definitions and discovery](/docs/concepts/definitions-and-discovery)
- [Import paths](/docs/reference/import-paths)
