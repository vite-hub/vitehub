---
title: Reuse Agent Definitions
description: Extend an Agent, publish a preset, and keep its settings readable for build-time discovery.
navigation.title: Agent presets and inheritance
navigation.order: 70
navigation.group: Advanced
navigation.kind: Guides
icon: i-lucide-copy
---

Reuse an Agent Definition (what `defineAgent()` returns) when several Agents share behavior but need different settings. First learn to [define](/docs/agents/agent-definitions) and [run](/docs/agents/invocations) one Agent. For a published workflow, choose a [ready-made Agent preset](/docs/agents/presets).

## Extend an Agent

`extends` starts a new Agent (the child) from an existing one (the parent), which gives the defaults:

```ts [server/agents/bot-dev/agent.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import bot from '../bot/agent'

export default defineAgent({
  extends: bot,
  driver: { model: 'gpt-5.6-sol' },
  workspace: {
    store: { provider: 'local', root: '.vitehub/workspaces/bot-dev' },
  },
})
```

The child gets a new runtime built from the parent's configuration, but not its `name`: discovery names each Agent from its own file. Give each Agent its own persistent storage to keep data separate; a deliberately shared store stays shared.

Child settings compose with parent defaults like this:

| Setting | Composition |
| --- | --- |
| Channels, Sources, and Skills | Merge by key. The child replaces each match as a whole. |
| Hooks | Merge by name. The parent's hook runs first, then the child's. Outcome hooks return both delivery effects. Observers of every level stay registered. |
| Static Capabilities (tools and behavior) | Merge by `id`. The child replaces matches and adds new ones. An `extend(inherited)` hook combines matches instead. |
| Capability resolver | Replaces the inherited list or resolver. |
| Other arrays | Replace the parent array. |
| `driver.launch` | Replaces the whole command or resolver, including `onExit`. Omitted inherits the parent launch. |
| Driver kind or store provider | A different kind or provider replaces that configuration. |

Some settings add to inherited values instead:

```ts [server/agents/bot-dev/agent.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { mcp } from 'vite-hub/agent/capabilities'
import bot from '../bot/agent'

export default defineAgent({
  extends: bot,
  // Receives the parent's list. An array replaces it.
  driver: { requirements: inherited => [...inherited, 'kubectl'] },
  // Adds a server to the parent's mcp() servers. `false` removes an inherited server.
  capabilities: [mcp({ servers: { portal: { connection: 'portal' } } })],
  // Sets the mode of every Source that does not set its own, including inherited Sources.
  workspace: { materialize: 'none' },
})
```

- `driver.requirements` can be a function that gets the inherited list (`[]` without a parent).
- A child `mcp()` merges `servers`, `integrity`, and `toolOverrides` into the parent's `mcp()` by server name. The child's entry for one server wins as a whole, and unset options such as `unavailableNotice` come from the parent. `inherit: false` replaces the parent's `mcp()`.
- `workspace.materialize` is the default [`materialize` mode](/docs/workspace/configure) for each Source (read-only content inside a Workspace) in `workspace.sources` without its own. Sources that Capabilities add keep their mode.

A discovered child also uses the [Connection access rules](/docs/connections/configure#access-rules) of the Agents it extends; a rule that names the child wins.

`extends` accepts one definition that `defineAgent()` created in the same package instance, and discovers no files in the parent's directory. Share instructions by importing them with `?raw` into `driver.instructions`, and Skills with explicit Sources or a directory link.

An undiscovered definition, such as one created in a Schedule, reads the colocated Skills of the discovered Agent it extends at run time, so import order does not matter. `agentWithSkills()` adds Skills without an Agent folder:

```ts [server/schedules/changelog.ts]
import { agentWithSkills, defineAgent } from 'vite-hub/agent'
import botDev from '../agents/bot-dev/agent'
import changelogSkill from './changelog-skill.md?raw'

const changelogAgent = agentWithSkills(
  defineAgent({ extends: botDev, name: 'changelog' }),
  { 'changelog-writing': changelogSkill },
)
```

Keys are Skill names and values are `SKILL.md` content. Inherited Skills stay, except ones with the same name.

## Presets from a package

Use [Agent presets](/docs/agents/presets) to choose a built-in workflow and follow its setup guide.

Export ordinary `defineAgent()` definitions from a preset package. Consumers import one and pass it as `extends`:

```ts fragment
import { defineAgent } from "vite-hub/agent"
import { notetaker } from "@example/agents"

export default defineAgent({
  extends: notetaker,
  name: "meeting-notes",
  driver: { model: "gpt-5.6-sol" },
})
```

A preset is an ordinary parent: `extends` applies child overrides and creates a fresh runtime. Importing a preset does not register a global name or load other packages, and the preset name never becomes model instructions.

A preset package must declare `@vite-hub/agent` as a peer dependency, so its definitions share the application's package instance. Include instruction content and required assets explicitly, because selecting a preset does not discover its package directory.

## Add typed options

A preset can expose typed options with the same `defineAgent()` function:

```ts
import { codexDriver, defineAgent } from 'vite-hub/agent'

export const notetaker = defineAgent({
  options: { format: "concise" as "concise" | "detailed", labels: ["notes"] },
  configure: ({ format }) => defineAgent({
    driver: codexDriver({ instructions: `Write ${format} notes.` }),
  }),
})
```

Apps override only the options they need:

```ts fragment
const notes = defineAgent({
  extends: notetaker,
  options: { format: "detailed", labels: [] },
  driver: { model: "gpt-5.4" },
})

notes.options.format // "concise" | "detailed"
```

## Name the configuration block

A configured preset (one with `options` and `configure`) can declare a `configKey`, so apps set its options in a named block that shows which preset they belong to:

```ts
import { codexDriver, defineAgent } from 'vite-hub/agent'

const notes = defineAgent({
  configKey: 'notetaker',
  options: { format: 'concise' as 'concise' | 'detailed' },
  configure: ({ format }) => defineAgent({
    driver: codexDriver({ instructions: `Write ${format} notes.` }),
  }),
})

const detailed = defineAgent({
  extends: notes,
  notetaker: { format: 'detailed' },
})
```

To put options next to the preset, use `extends: [notes, options]`, such as `defineAgent({ extends: [notes, { format: 'detailed' }] })`. The block and tuple combine, and the tuple wins on the same key. The legacy `extends` plus `options` form still works but cannot mix with either.

## Option defaults and overrides

`options` must be a plain record of defaults, which can be nested. As the `options` object itself, the types reject a built-in instance such as a `Map`, and the runtime rejects a custom class instance, which TypeScript cannot tell apart from a plain record with callbacks.

Child values, including `false`, empty arrays, and callbacks, replace parent values. Arrays never join. A nested value with required methods, such as a class instance, needs a complete replacement. Omitted or `undefined` values keep their defaults.

Annotate optional fields and literal unions in the defaults to describe the accepted configuration; TypeScript checks options against the selected preset. Validate untyped input in `configure`.

`configure` runs synchronously when you define or extend the Agent and returns a normal Agent Definition. Make no network calls or other side effects in it. It gets its own copy of the options:

- Standard built-in copies keep their property descriptors and nested values.
- Custom class instances, `WeakMap`, `WeakSet`, `Error`, detached buffers and their views keep their identity.
- Resizable or growable buffers and their views keep their identity, resize behavior, and fixed-length or length-tracking views.

Ordinary Agent overrides apply after the callback and stay through more extensions. Each extension clears an inherited Agent name.

A configured Agent exposes its resolved `options` for host setup and inspection; they do not become model instructions.

## Declare the Workspace

At build time, discovery reads Agent files without running them, to find the Workspaces (folders of files that server code reads and changes) that they own.

A folder Agent, such as `server/agents/review/agent.ts`, owns a Workspace only when the `defineAgent()` options that its file exports have a `workspace` key:

- `workspace: {}` or Workspace options own a Workspace.
- `workspace: 'shared'` and `workspace: { name: 'shared' }` use a shared Workspace.
- No `workspace` key, or `workspace: undefined`, declares no Workspace. The Agent stays stateless.

Write the key in the exported `defineAgent()` call or in a `const` that the call uses. Discovery does not set up a Workspace for a key that it cannot read, such as one in options that a function returns.

When a Capability, Channel, preset, parent, or `configure` callback adds a Workspace, such as `github({ pullRequest: true })`, also add `workspace: {}`. Without it, the Agent fails with `AGENT_R1037` when it loads.

Configured presets merge Capabilities, Channels, and hooks like `extends`: a child replaces a Capability with the same ID or a Channel with the same key, and a same-name hook runs after the preset's, so an extension's `agent:finish` cannot remove preset behavior. Option callbacks are values that get replaced and are never called by merging.

Publish the exported definition on npm and pass it as `extends`. There is no second preset factory or global package loader.

## Next steps

- [Instruction templates](/docs/agents/instructions#extend-inherited-instructions) keep space for project guidance in a shared Agent.
- [Definition discovery](/docs/development/definition-discovery) covers file naming and build inspection.
- [Process hosts](/docs/agents/process-hosts) covers presets that need a persistent Node process.
