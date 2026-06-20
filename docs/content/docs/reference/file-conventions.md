---
title: File conventions
description: Reference the discovery paths that produce ViteHub Discovered Definitions and Discovery Identity.
navigation.order: 52
icon: i-lucide-folder-tree
---

File conventions produce Discovered Definitions.
Discovery Identity comes from the discovery location, not from arbitrary inline Definition Options.

## Definition files

| Definition | Current convention | Discovery Identity |
| --- | --- | --- |
| Agent Definition | `server/agents/<agent>.ts` or `server/agents/<agent>/config.ts` | Agent File Name or agent folder name. |
| Auth Definition | `server/auth.ts` or `server.auth.ts` | Single app Auth Definition. |
| Database Definition | `server/databases/config.ts` or `server/databases/<name>/config.ts` | `default` for `config.ts`; folder name for named databases. |
| Queue Definition | `server/queues/<name>.ts` or `src/<name>.queue.ts` | File name. |
| Workflow Definition | `server/workflows/<name>.ts`, `server/workflows/<name>/index.ts`, or `src/<name>.workflow.ts` | File or folder name. |
| Schedule Definition | `server/schedules/<name>.ts` or `src/<name>.schedule.ts` | File name. |
| Sandbox Definition | `src/<name>.sandbox.ts` | File name. |
| Workspace Definition | `server/workspaces/<name>.ts` or package-supported colocated Workspace Definition | File name or colocated owner name. |

## Export shape

First-class discovered definition files should default-export the package-owned Definition Boundary Helper.
This keeps Build-Extracted Definition Options limited to the direct discovered default export.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  await sendWelcomeEmail(job.payload.email)
})
```

Avoid aggregate named exports for discovered Definitions.
The generated Runtime Registry expects one discovered boundary per file convention.

## Colocated Workspace files

Agent folders can colocate Workspace content beside the Agent Definition.
When a folder contains `workspace/`, that folder becomes the Workspace Source Root for the colocated Workspace Definition.

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

## Generated files

Generated files live under `.vitehub/**` and host output directories.
They prove discovery and Provider Output, but the source Definition files remain the authoring surface.

## Related

- [Generated files](/docs/development/generated-files)
- [Definitions and discovery](/docs/concepts/definitions-and-discovery)
- [Import paths](/docs/reference/import-paths)
