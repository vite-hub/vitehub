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
| Agent | `server/agents/<name>.ts` or `server/agents/<name>/config.ts` | `<path>.agent.ts` outside `server/` | Relative file or directory path. A leading `src/` is removed from suffix identities. |
| Auth | `server/auth.ts` | `server.auth.ts` | `default`. Only one Auth Definition is allowed. |
| Database | `server/databases/config.ts` for one default database, or `server/databases/<name>/config.ts` for named databases | `src/database.ts` for the default database, or `<path>.database.ts` for a named database | `default` or the normalized relative path. Default and named modes cannot be mixed. |
| Queue | `server/queues/<path>.ts` | `<path>.queue.ts` | Normalized relative path. A leading `src/` is removed from suffix identities. |
| Workflow | `server/workflows/<path>.ts` or a folder containing `index.ts` or numbered step files | `<path>.workflow.ts` | Normalized relative file or folder path. Agent Definitions using `runtime: workflow(...)` also contribute their selected workflow identity. |
| Schedule | `server/schedules/<path>.ts` | `<path>.schedule.ts` | Normalized relative path. A leading `src/` is removed from suffix identities. |
| Sandbox | `server/sandboxes/<path>.ts` | `<path>.sandbox.ts` outside `server/sandboxes/` | Normalized relative path, without a trailing `.sandbox` segment. |
| Workspace | `server/workspaces/<path>.ts`, `server/workspaces/<name>/config.ts`, or `server/agents/<name>/config.ts` when the Agent declares a Workspace | `<path>.workspace.ts` | Normalized relative path or the colocated Agent name. |

The table uses `.ts` for brevity. Directory and suffix patterns accept JavaScript and TypeScript module variants where the owning package permits them. `src/database.ts` is the exact default Database suffix-mode file.

## Export shape

First-class discovered definition files default-export the package-owned Definition Boundary Helper. This keeps Build-Extracted Definition Options limited to the direct discovered default export.

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
      config.ts
      workspace/
        README.md
        guides/
          setup.md
```

## Colocated Agent Skills

An Agent folder can own Skills in an adjacent `skills/` directory. ViteHub recursively embeds every file during discovery, materializes the directory into the Harness Workspace, and also installs it into supported isolated harness profiles such as Codex. Existing files at both destinations remain in place, and files below a `scripts/` directory become executable.

```txt [File tree]
server/
  agents/
    review/
      config.ts
      skills/
        code-review/
          SKILL.md
          scripts/
            review.sh
```

This convention needs no `skills()` Capability declaration. Use [`skills()`](/docs/capabilities/skills) when the Skill comes from a Workspace or external Source instead of the Agent folder.

## Generated files

Generated files live under `.vitehub/**` and host output directories.
They prove discovery and Provider Output, but the source Definition files remain the authoring surface.

## Related

- [Generated files](/docs/development/generated-files)
- [Definitions and discovery](/docs/concepts/definitions-and-discovery)
- [Import paths](/docs/reference/import-paths)
