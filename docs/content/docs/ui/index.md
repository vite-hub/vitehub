---
title: ViteHub UI
description: "Build UI that people and Agents use: ui-sdk parts with the kit, UI specs that an Agent sends, and the live page that an Agent works."
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-lucide-layout-grid
---

An Agent meets UI in three ways. It builds UI as code, sends UI as a spec, or works the live page that a person has open. ViteHub UI gives each way one owner.

| Way | What you use |
| --- | --- |
| [Build UI as code](#build-ui-as-code) | ui-sdk parts from `@ui-sdk/vue`, plus `@vite-hub/kit` for the parts and styles that ui-sdk does not have |
| [Send UI as a spec](#send-ui-as-a-spec) | The Agent UI catalog in `vite-hub/agent/ui`, paired with forms from `@vite-hub/forms` |
| [Work the live page](#work-the-live-page) | The `page()` Capability, with `connectPage()` from `vite-hub/agent/page` |

## Build UI as code

Import each part from its `@ui-sdk/vue` entry. Every part handles behavior, focus, keyboard navigation, and ARIA, and has no styles. `@vite-hub/kit` adds the parts that ui-sdk does not have, today `TagsInput`, and a style family for every part.

```vue [app/components/RenameDialog.vue]
<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@ui-sdk/vue/dialog"
import { Field, FieldLabel } from "@ui-sdk/vue/field"
import { Input } from "@ui-sdk/vue/input"
</script>

<template>
  <Dialog>
    <DialogTrigger>Rename</DialogTrigger>
    <DialogContent>
      <DialogTitle>Rename the project</DialogTitle>
      <Field>
        <FieldLabel>Project name</FieldLabel>
        <Input default-value="Apollo" />
      </Field>
    </DialogContent>
  </Dialog>
</template>
```

Read [Get started](/docs/ui/get-started) to install the parts and styles.

## Send UI as a spec

An Agent can reply with UI instead of text, such as an approval card. It writes a [json-render](https://json-render.dev) spec, and `vite-hub/agent/ui` checks it against the catalog of parts that it may send:

```json [approval.json]
{
  "root": "card",
  "elements": {
    "card": {
      "type": "Card",
      "props": { "title": "Deploy acme/web" },
      "children": ["approve"]
    },
    "approve": {
      "type": "Button",
      "props": { "label": "Approve", "variant": "primary" },
      "on": {
        "press": { "action": "event", "params": { "name": "deploy.approve" } }
      }
    }
  }
}
```

A spec has no inputs of its own. To ask for values, a `Form` names a form from `@vite-hub/forms`, so one schema makes the web form, the MCP elicitation, and the Slack modal. [Agent UI](/docs/agents/ui) shows how to define the catalog, check a spec, and render it. See also [one schema on every surface](/docs/forms/server-api#one-schema-on-every-surface) and [Forms in Vue](/docs/forms/vue).

## Work the live page

The `page()` Capability lets a server Agent read and change the page that a person has open, through ui-sdk's agent bridge. You set which parts it may not touch and which steps need approval:

```ts [server/agents/settings.ts]
import { defineAgent } from "vite-hub/agent"
import { page } from "vite-hub/agent/capabilities"
import { webChat } from "vite-hub/agent/channels"

export default defineAgent({
  capabilities: [page({ requireApproval: [{ label: "Save changes" }] })],
  channels: { web: webChat() },
  driver: { model: "openai/gpt-5" },
})
```

Read [Page](/docs/agents/capabilities/page) for client setup, undo, and the security model.

## Next

- [Get started](/docs/ui/get-started) installs the parts and styles, renders a field, and connects the page.
- [Where does it belong?](/docs/ui/where-does-it-belong) maps each UI layer to its owner and tests.
- [From Reka UI](/docs/ui/from-reka-ui) and [From Nuxt UI](/docs/ui/from-nuxt-ui) migrate an app to ui-sdk parts.
- [AI components](/docs/ui/ai-components) covers chat, sessions, Agent runs, and code views on Nuxt UI.
- [Playground](/playground?template=ui) lets you edit a Vue app with ui-sdk parts in the browser.
- [Import paths](/docs/reference/import-paths) lists every entry of `vite-hub/agent/ui`, `vite-hub/agent/page`, and `vite-hub/forms`.
