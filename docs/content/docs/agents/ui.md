---
title: Agent UI
description: "Let an Agent answer with UI, such as an approval card or a form: define the catalog, prompt the model, check each spec, and render it in Vue."
seo.title: "Agent UI: cards and forms that an Agent sends"
navigation.order: 23
navigation.group: Instructions and tools
icon: i-lucide-layout-template
navigation.kind: Guides
---

An Agent can answer with UI instead of text. It writes a [json-render](https://json-render.dev) spec: a JSON tree of components, such as a card with two buttons. `vite-hub/agent/ui` is the contract for that spec. It holds the catalog of components that the Agent may use, the prompt that teaches the model the catalog, and the check that the app runs before it shows a spec.

## When to send UI

Send UI when the person must act on the answer:

- Approve or reject a step, such as a deploy. Use a `Card` with two `Button`s.
- Compare rows of data. Use a `Table`.
- Give values that the Agent needs, such as an email and a role. Use a `Form`.

Send text for everything else. Text is shorter, and every Channel shows it.

A spec draws no inputs. To ask for values, a `Form` names a form of [`vite-hub/forms`](/docs/forms), and the schema of that form gives the fields. The same schema draws the web form, the MCP elicitation, and the Slack modal, and gives the same errors on each.

## Install

The catalog needs `zod` and json-render. The Vue components also need `@ui-sdk/vue`:

```bash pm [commands/install-agent-ui]
pnpm add zod @json-render/vue @ui-sdk/vue
```

## Define the catalog

Start from the built-in entries, and add the forms that a `Form` may name. Put the schema of each form in `shared/`, so the server and the page use the same one:

```ts [shared/schemas.ts]
import * as v from 'valibot'

export const InviteSchema = v.object({
  email: v.pipe(v.string(), v.email('Enter a valid email.')),
  role: v.picklist(['admin', 'member']),
})
```

```ts [server/forms/invite.ts]
import { defineForm } from 'vite-hub/forms'
import { InviteSchema } from '../../shared/schemas'

export default defineForm({ schema: InviteSchema })
```

```ts [shared/agent-ui.ts]
import { defineCatalog, viteHubCatalogEntries } from 'vite-hub/agent/ui'
import { InviteSchema } from './schemas'

export const catalog = defineCatalog(viteHubCatalogEntries, {
  forms: { invite: InviteSchema },
})
```

- `viteHubCatalogEntries` are the built-in components: Stack, Text, Heading, KeyValue, Divider, Card, Button, Link, Image, Badge, Table, Tabs, and Form.
- `forms` maps a name to a `defineForm()` result or to its schema. Give the schema when the page imports the catalog, so the page does not import server code.
- Without a catalog, `validateSpec()` and `catalogPrompt()` use `viteHubCatalog`: the built-in components and no forms.

## Put the prompt in the instructions

`catalogPrompt()` returns json-render's own prompt for the components of one surface, with the limits, the `event` action, and the fields of each form. Add it to the [instructions](/docs/agents/instructions) of the Agent:

```ts [server/agents/deploys.ts]
import { defineAgent } from 'vite-hub/agent'
import { catalogPrompt } from 'vite-hub/agent/ui'
import { catalog } from '../../shared/agent-ui'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: [
      'You help the team ship. Answer with UI when the person must choose or give values.',
      catalogPrompt({ surface: 'web', catalog }),
    ],
  },
})
```

The model answers with JSONL patches that build the spec. Set `mode: 'inline'` for a chat, where the model writes text first and then the patches. A Form in the spec looks like this:

```json [invite.json]
{
  "root": "invite-form",
  "elements": {
    "invite-form": {
      "type": "Form",
      "props": {
        "form": "invite",
        "value": { "$bindState": "/invite" },
        "submitLabel": "Send invite"
      },
      "on": {
        "submit": {
          "action": "event",
          "params": {
            "name": "invite.send",
            "context": { "values": { "$state": "/invite" } }
          }
        }
      }
    }
  },
  "state": { "invite": { "role": "member" } }
}
```

A Button and a Form tell the Agent what the person did with one action, `event`. It sends a `name` and a `context`.

## Check the spec on the server

Build and check the spec from the answer with `specFromText()`. When the spec is wrong, send the diagnostics back to the model and ask again:

```ts [server/utils/ask-for-ui.ts]
import { runAgent } from 'vite-hub/agent'
import { specFromText } from 'vite-hub/agent/ui'
import type { CatalogSpec } from 'vite-hub/agent/ui'
import { catalog } from '../../shared/agent-ui'
import deploys from '../agents/deploys'

export async function askForUI(prompt: string): Promise<CatalogSpec> {
  let next = prompt
  for (let attempt = 1; attempt <= 3; attempt++) {
    const [error, result] = await runAgent(deploys, { prompt: next })
    if (error) throw error
    const answer = result.text ?? ''
    const checked = specFromText(answer, { surface: 'web', catalog })
    if (checked.valid) return checked.spec
    next = [
      prompt,
      `Your last answer:\n${answer}`,
      `Fix these problems and send the whole spec again:\n${JSON.stringify(checked.diagnostics)}`,
    ].join('\n\n')
  }
  throw new Error('The Agent sent no valid spec in 3 tries.')
}
```

- `specFromText()` skips the lines that are not patches, so it also reads an `inline` answer. It refuses a patch that writes `__proto__`, `constructor`, or `prototype`, so a model cannot change the objects of your server.
- Each diagnostic is plain JSON with a `code`, a `message`, a `fix`, a `docs` link, and a `path`, the JSON Pointer to the wrong part of the spec. The model reads it as it is.
- A spec has at most 128 elements and 20 levels.

Each code has its own page under [Agent diagnostics](/docs/agents/diagnostics).

## Read what a Form sends

When the person sends the Form, the page gets the event `{ name: 'invite.send', context: { values } }`. Check the values on the server with `checkSpecForm()`. It takes the spec that you showed and the id of the Form element, and runs `checkForm()` of `vite-hub/forms` with the schema of the form:

```ts [server/utils/read-invite.ts]
import { checkSpecForm } from 'vite-hub/agent/ui'
import type { CatalogSpec } from 'vite-hub/agent/ui'
import { catalog } from '../../shared/agent-ui'

export async function readInvite(spec: CatalogSpec, values: unknown) {
  const [error, invite] = await checkSpecForm(spec, 'invite-form', values, { catalog })
  if (error) return { issues: error.issues }
  return { invite }
}
```

The issues are the same as those of the form route, the MCP elicitation, and the chat modal. `checkSpecForm()` throws `AGENT_UI_NOT_A_FORM` when the element is not a Form of the catalog.

## Render it in Vue

Render a checked spec with `Renderer` of `@json-render/vue` and the default components of `vite-hub/agent/ui/vue`. Button, Divider, and Tabs use `@ui-sdk/vue`, and a Form draws one native control for each field of its form. The components have behavior, focus, and ARIA, but no styles:

```vue [app/components/AgentUI.vue]
<script setup lang="ts">
import { JSONUIProvider, Renderer } from '@json-render/vue'
import type { CatalogSpec } from 'vite-hub/agent/ui'
import { catalogComponents, defineCatalogRegistry } from 'vite-hub/agent/ui/vue'
import { catalog } from '../../shared/agent-ui'

const props = defineProps<{
  spec: CatalogSpec
  send: (event: { name: string, context?: object }) => void
}>()
const registry = defineCatalogRegistry(catalog, catalogComponents)
</script>

<template>
  <JSONUIProvider :registry :initial-state="props.spec.state" :handlers="{ event: props.send }">
    <Renderer :spec="props.spec" :registry />
  </JSONUIProvider>
</template>
```

`send` gets each `event`. Post it to a route of the app, which reads it and runs the Agent again.

## Surfaces

A surface is the place where a spec renders. Pass the same surface to `catalogPrompt()` and `validateSpec()`, so the model learns only the components that the place can draw:

| Surface | Where the spec renders | Components |
| --- | --- | --- |
| `web` | A Vue or Nuxt page | All |
| `mcp` | An MCP App in a client such as Claude or VS Code | All |
| `chatCard` | A card in Slack, Teams, Discord, or Telegram | All but Badge, Tabs, and Form |
| `chatModal` | A chat modal, such as a Slack modal | Stack, Text, Heading, KeyValue, and Form |

- A chat card has no inputs. To ask for values in a chat, send a Form in a chat modal.
- A chat modal holds a form, not buttons or tables.
- Stack, Text, Heading, and KeyValue render on every surface. `portableEntries(catalog)` returns them.
- A Form also needs a form that the surface can draw. An MCP elicitation takes only choices of text, so `validateSpec()` refuses a form with a choice of numbers on `mcp`, and `catalogPrompt()` leaves that form out.

`validateSpec()` reports a component that the surface cannot draw as `AGENT_UI_COMPONENT_NOT_ON_SURFACE`. `vite-hub/agent/ui/vue` renders a spec in a Vue page. For a chat card or a chat modal, check the spec with that surface, and turn it into the card or the modal in your Channel code.

## Add a component

Add an entry when Agents must send a component that the catalog does not have. `defineCatalogEntry()` takes a props schema that implements Standard Schema and Standard JSON Schema, such as a Zod 4 object:

```diff [shared/agent-ui.ts]
-import { defineCatalog, viteHubCatalogEntries } from 'vite-hub/agent/ui'
+import { defineCatalog, defineCatalogEntry, viteHubCatalogEntries } from 'vite-hub/agent/ui'
+import { z } from 'zod'
 import { InviteSchema } from './schemas'

-export const catalog = defineCatalog(viteHubCatalogEntries, {
+const rating = defineCatalogEntry({
+  name: 'Rating',
+  description: 'From 1 to 5 stars.',
+  props: z.strictObject({ value: z.number().int().min(1).max(5) }),
+  events: {},
+  children: false,
+  version: 1,
+  surfaces: ['web', 'mcp'],
+})
+
+export const catalog = defineCatalog([...viteHubCatalogEntries, rating], {
   forms: { invite: InviteSchema },
 })
```

- `description` goes into the prompt as you write it. Keep it short.
- `events` names each event that `on` can bind, such as `{ press: 'The person pressed the button.' }`.
- Raise `version` when a change of the props or the events can break a saved spec.
- `defineCatalog()` throws `AGENT_UI_ENTRY_INVALID` for an invalid entry and `AGENT_UI_ENTRY_DUPLICATE` for two entries with the same name.

Then give the page a Vue component for the entry. It gets the props of the element as Vue props, and `onPress` for a `press` event:

```vue [app/components/StarRating.vue]
<script setup lang="ts">
defineProps<{ value: number }>()
</script>

<template>
  <span :aria-label="`${value} of 5 stars`">{{ '★'.repeat(value) }}</span>
</template>
```

```diff [app/components/AgentUI.vue]
 import { catalog } from '../../shared/agent-ui'
+import StarRating from './StarRating.vue'

-const registry = defineCatalogRegistry(catalog, catalogComponents)
+const registry = defineCatalogRegistry(catalog, { ...catalogComponents, Rating: StarRating })
```

## Next

- [Forms](/docs/forms/server-api#one-schema-on-every-surface): draw one schema as a web form, an MCP elicitation, and a chat modal.
- [Page](/docs/agents/capabilities/page): let the Agent work the page that the person has open, instead of sending new UI.
- [ViteHub UI](/docs/ui): build the rest of the page with ui-sdk parts.
