---
title: Reuse Agent Definitions
description: Extend an Agent, publish a preset, and keep configuration visible to build-time discovery.
navigation.title: Agent presets and inheritance
navigation.order: 70
navigation.group: Advanced
navigation.kind: Guides
icon: i-lucide-copy
---

Use this guide after you can [define](/docs/agents/agent-definitions) and [run](/docs/agents/invocations) one Agent. Reuse a definition when several Agents share behavior but need different settings. To start with a published workflow, choose a [ready-made Agent preset](/docs/agents/presets).

## Extend an Agent

Use `extends` to make one Agent Definition the default for another:

```ts [server/agents/bot-dev/agent.ts]
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

The child gets a fresh runtime from the parent's configuration. `name` is not inherited; discovery names each Agent from its own file. Configure separate persistent storage when the Agents must keep separate data. An explicitly shared store or adapter remains shared.

Child configuration overrides parent defaults:

| Setting | Composition |
| --- | --- |
| Channels, Sources, Skills, and hooks | Merge by key. The child replaces each matching definition or callback as a whole. |
| Static Capabilities | Merge by `id`. The child replaces a matching Capability and appends new ones. An `extend(inherited)` hook can combine matching Capabilities instead. |
| Capability resolver | Replaces the inherited list or resolver. |
| Other arrays | Replace the parent array. |
| `driver.launch` | Replaces the whole command or resolver, including `onExit`. An omitted value inherits the parent launch. |
| Driver kind or store provider | Changing the kind or provider replaces that configuration. |

Some settings let the child extend inherited values:

```ts [server/agents/bot-dev/agent.ts]
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

- `driver.requirements` can be a function of the inherited list. Without a parent, it receives `[]`.
- A child `mcp()` merges `servers`, `integrity`, and `toolOverrides` by server name into the parent's `mcp()` Capability. The child's entry for a server wins as a whole, and options that the child leaves unset, such as `unavailableNotice`, are inherited. Set `inherit: false` to replace the parent's `mcp()` Capability.
- `workspace.materialize` is the default [`materialize` mode](/docs/workspace/configure) for every Source in `workspace.sources` that does not set its own. Sources that Capabilities contribute keep their own mode.

A discovered child also uses the [Connection access rules](/docs/connections/configure#access-rules) of the Agents it extends. A rule that names the child wins over an inherited rule.

`extends` accepts one definition created by `defineAgent()` in the same package instance. It does not discover files in the parent's directory. Import shared instructions in TypeScript with `?raw` and pass them through `driver.instructions`. Share Skills through explicit Sources or a directory link.

A definition that is not discovered, such as one created in a Schedule, uses the colocated Skills of the discovered Agent it extends. It reads them when it runs, so module import order does not matter. Use `agentWithSkills()` to add Skills to such a definition without an Agent folder:

```ts [server/schedules/changelog.ts]
import { agentWithSkills, defineAgent } from 'vite-hub/agent'
import botDev from '../agents/bot-dev/agent'
import changelogSkill from './changelog-skill.md?raw'

const changelogAgent = agentWithSkills(
  defineAgent({ extends: botDev, name: 'changelog' }),
  { 'changelog-writing': changelogSkill },
)
```

Each key is a Skill name, and each value is its `SKILL.md` content. The result keeps the inherited Skills. A Skill with the same name replaces the inherited one.

## Named presets

Use [Agent presets](/docs/agents/presets) to choose a built-in workflow and follow its setup guide.

Export ordinary `defineAgent()` definitions from a preset package. Consumers import them and select a local name:

```ts
import { defineAgent } from "vite-hub/agent"
import { notetaker } from "@example/agents"

export default defineAgent({
  preset: "notetaker",
  presets: { notetaker },
  name: "meeting-notes",
  driver: { model: "gpt-5.6-sol" },
})
```

`preset` must name an own entry in `presets`. Selection uses the same composition as `extends`, including child overrides and a fresh runtime. Specify one parent with either `preset` or `extends`. The map belongs to this definition; it does not register global names or load packages. Neither the map nor its selected name becomes model instructions.

Preset packages must declare `@vite-hub/agent` as a peer dependency so their definitions share the application's package instance. Package authors must include instruction content and required assets explicitly; selecting a preset does not discover its package directory.

## Add typed options

A preset can expose typed options with the same `defineAgent()` function:

```ts
export const notetaker = defineAgent({
  options: { format: "concise" as "concise" | "detailed", labels: ["notes"] },
  configure: ({ format }) => defineAgent({
    driver: { kind: "codex", instructions: `Write ${format} notes.` },
  }),
})
```

Consumers select the definition and override only the options they need:

```ts
const notes = defineAgent({
  preset: "notetaker",
  presets: { notetaker },
  options: { format: "detailed", labels: [] },
  driver: { model: "gpt-5.4" },
})

notes.options.format // "concise" | "detailed"
```

## Name the configuration block

Configured presets can declare a `configKey` to expose a module-style configuration block. The block keeps the preset's option names visible at the call site:

```ts
const notes = defineAgent({
  configKey: 'notetaker',
  options: { format: 'concise' as 'concise' | 'detailed' },
  configure: ({ format }) => defineAgent({
    driver: { kind: 'codex', instructions: `Write ${format} notes.` },
  }),
})

const detailed = defineAgent({
  extends: notes,
  notetaker: { format: 'detailed' },
})
```

Use `extends: [notes, options]` when options belong beside the selected preset, for example `defineAgent({ extends: [notes, { format: 'detailed' }] })`. The named block and tuple can be combined; tuple values take precedence when both provide the same key. The legacy `extends` plus `options` form remains available, but a definition cannot mix it with a named block or tuple.

## Option defaults and overrides

`options` must be a plain record and uses nested defaults. Types reject built-in instance roots. The runtime rejects custom class roots because TypeScript cannot distinguish their structure from plain records with callbacks.

Child values replace parent values, including `false`, empty arrays, and callbacks. Arrays never concatenate. Nested values with required methods, including class instances, require complete replacements. Omitted or `undefined` values retain their defaults.

Annotate optional fields and literal unions in the defaults to describe accepted configuration. TypeScript checks options against the selected preset. Validate untyped input in `configure`.

`configure` runs synchronously when defining or extending the Agent. Return a normal Agent Definition and keep this callback free of network calls and other side effects.

The callback receives its own option copy. Copies of standard built-ins preserve their own property descriptors and nested values. Custom class instances and values such as `WeakMap`, `WeakSet`, and `Error` retain their identity across option copies. Detached buffers and their views retain identity. Resizable or growable buffers and their views also retain identity, preserving resize behavior and fixed-length or length-tracking views.

Ordinary Agent overrides apply after the callback and remain in effect through further extensions. An inherited Agent name is cleared on each extension. For discovered Agents, a Workspace reference object must use a statically known string `name`; `name: undefined` owns a Workspace. Opaque names require an explicit Workspace ownership marker on the configured definition. A configured Agent exposes its resolved `options` for host setup and inspection; these values do not become model instructions automatically.

## Keep definitions discoverable

ViteHub inspects Agent files at build time to find owned Workspaces. It does not run configuration callbacks to find them.

For folder Agents discovered from `agent.ts`, define `configure` in that file and return `defineAgent()` directly. You can also declare `workspace: {}` for owned storage or a named Workspace reference on the configured Agent. Discovery rejects an imported `configure` callback because it cannot determine the required Workspace setup.

Discovery cannot resolve these forms:

| Form | Examples |
| --- | --- |
| Opaque callback results | Imported callbacks, `builders["workspace"]()`, `build!()`, `(build as Factory)()`, or returned Agent members such as `agents.storage`. |
| Dynamic settings | Unresolved computed keys, quoted keys with unsupported escapes, compound `void` expressions, `options.workspaceName`, or spreads such as `...importedSettings`. |
| Indirect preset selection | Imported Agent parents or preset registries, registry spreads, and dynamic preset names. |
| Indirect Capability configuration | Imported options or values, destructured bindings, `options.caps`, `values.storage`, or `values.storage()`. |
| Constructed Capability lists | `false \|\| [storage]`, `Array.of(storage)`, or `[plain].concat(storage)`. |
| Opaque Channels | Imported Channel maps, package imports, local Channel factories, or `makeChannel()`. |
| Opaque Channel options | `github(options.github)`, `github({ pullRequest: options.pullRequest })`, or accessor options such as `get pullRequest()`. |

If these forms contribute an owned Workspace, add `workspace: {}` to the Agent Definition. Otherwise, define the settings, parents, Channels, and Capabilities locally with direct bindings so discovery can inspect them.

Discovery reads first-party Channel helper calls, such as `github({ pullRequest: false })`, without running them.

It also follows a Channel imported from a relative module, such as `import portal from '../portal.github.ts'`, and inspects that module's export with the same rules. It follows re-exports from relative modules, such as `export { default } from './inner.ts'` and `export * from './channels.ts'`, and rejects re-exports from packages.

`github()` owns a Workspace only when `pullRequest` is enabled and `pullRequest.workspace` is not `false`. `discord()`, `http()`, `slack()`, `teams()`, `telegram()`, and `webChat()` own a Workspace only through their `capabilities`. An Agent whose Channels own no Workspace stays a stateless Agent; do not add `workspace: {}` to it.

Discovery rejects Channel option bindings that are mutated or passed to opaque calls, including local callbacks and built-in mutators such as `Object.assign`. It does not execute those calls to inspect their effects. Use unmodified local options, or add `workspace: {}` when the Channel owns a Workspace.

Configured presets use the existing layer rules for capabilities, channels, and hooks. A child replaces a capability with the same ID or a channel or hook with the same key. Distinct hooks remain present; same-key hooks do not automatically compose. Option callbacks are values and are also replaced, never invoked by merging.

Publish the exported definition on npm and import it into `presets`. There is no second preset factory or global package loader.

## Next steps

Use [instruction templates](/docs/agents/instructions#extend-inherited-instructions) to reserve project guidance in a shared Agent. Read [Definition discovery](/docs/development/definition-discovery) for file naming and build inspection, or [Process hosts](/docs/agents/process-hosts) when a preset needs a persistent Node process.
