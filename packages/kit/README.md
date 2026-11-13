# @vite-hub/kit

Headless parts for Vue and Nuxt: dialogs, menus, tabs, selects, date pickers, toasts, and more. The parts have behavior, focus, keyboard, and ARIA, and no styles. You style them through their `data-slot` attributes.

The behavior comes from [ui-sdk](https://ui-sdk.dev). Each entry of this package re-exports the matching entry of `@ui-sdk/vue` unchanged, with the same names, props, and types. The package installs only `@ui-sdk/vue` and `@ui-sdk/core`, so it does not bring the editor, terminal, or highlighter dependencies of `@vite-hub/ui`.

## Install

```sh
pnpm add @vite-hub/kit vue
```

## Import paths

Import each part from its own entry, so an app loads only the parts it uses. There is no root entry.

| Import | Contents |
| --- | --- |
| `@vite-hub/kit/<name>` | The parts and helpers of `@ui-sdk/vue/<name>`, for example `@vite-hub/kit/dialog`, `@vite-hub/kit/tabs`, and `@vite-hub/kit/date-picker`. Every entry of `@ui-sdk/vue` has one. |
| `@vite-hub/kit/nuxt` | The Nuxt module |
| `@vite-hub/kit/catalog` | The component catalog for the UI that Agents send. See [Catalog](#catalog) |
| `@vite-hub/kit/catalog/vue` | The Vue renderer of the catalog |

```vue
<script setup lang="ts">
import { Tabs, TabsList, TabsPanel, TabsTab } from "@vite-hub/kit/tabs";
</script>

<template>
  <Tabs default-value="code">
    <TabsList>
      <TabsTab value="code">Code</TabsTab>
      <TabsTab value="preview">Preview</TabsTab>
    </TabsList>
    <TabsPanel value="code">...</TabsPanel>
    <TabsPanel value="preview">...</TabsPanel>
  </Tabs>
</template>
```

For the props and parts of each component, read the [ui-sdk docs](https://ui-sdk.dev).

## Nuxt

The module auto-imports every part as a component and every helper, such as `createDialogController()` and `formatNumber()`. Set `prefix` when the app has its own components with the same names:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  // Registers <UiDialog>, <UiTabsTab>, and so on. Without a prefix, the names are <Dialog> and <TabsTab>.
  modules: [["@vite-hub/kit/nuxt", { prefix: "Ui" }]],
});
```

The `viteHubKit` key of `nuxt.config.ts` takes the same options.

The module installs the ui-sdk Nuxt module and points its imports at `@vite-hub/kit/<name>`. With pnpm, the app cannot resolve `@ui-sdk/vue` itself, so without this the generated types of the parts would be `any`.

## Catalog

An Agent can answer with UI: a form, an approval, or a table instead of text. It writes a JSON spec in the [json-render](https://json-render.dev) format, and the catalog is the contract for what it may use. Each entry has a name, props as a Standard Schema, a description for the model, events, a version, and the surfaces where it renders:

| Surface | Where the spec renders |
| --- | --- |
| `web` | A Vue or Nuxt page |
| `mcp` | An MCP App in Claude, ChatGPT, or VS Code |
| `chatCard` | A card in Slack, Teams, Discord, or Telegram. It has no inputs |
| `chatModal` | A chat modal, such as a Slack modal or a Teams dialog |

The built-in catalog has Stack, Text, Heading, KeyValue, Divider, Card, Button, Link, Image, Badge, Table, Form, Field, Input, Textarea, Select, RadioGroup, Checkbox, Switch, Tabs, and Dialog. Stack, Text, Heading, and KeyValue render on every surface. They are the portable subset, and they convert to [A2UI](https://a2ui.org) v1.0 and back without loss.

The catalog needs Zod and json-render. Install them only when you use it:

```sh
pnpm add zod @json-render/core @json-render/vue
```

On the server, put the catalog in the model prompt and check each spec that the model writes:

```ts
import { catalogPrompt, validateSpec } from "@vite-hub/kit/catalog";

const system = `You help the team ship releases.\n\n${catalogPrompt({ surface: "chatModal" })}`;

const result = validateSpec(spec, { surface: "chatModal" });
// Each diagnostic has a stable code, such as KIT_R0005 for an Input in a chat card. Send them back to the model.
if (!result.valid) return { error: result.diagnostics };
```

In the app, render the spec with json-render and the default components. Pass your own Vue component for any entry:

```vue
<script setup lang="ts">
import { JSONUIProvider, Renderer } from "@json-render/vue";
import { type CatalogSpec, viteHubCatalog } from "@vite-hub/kit/catalog";
import { catalogComponents, defineCatalogRegistry } from "@vite-hub/kit/catalog/vue";
import MyButton from "./MyButton.vue";

const props = defineProps<{ spec: CatalogSpec }>();
const emit = defineEmits<{ action: [name: string, params: Record<string, unknown>] }>();
// MyButton gets the props of the spec element, `onPress` for its press event, and `onUpdate:<prop>` for bound props.
const registry = defineCatalogRegistry(viteHubCatalog, { ...catalogComponents, Button: MyButton });
// One handler for each action that the spec binds. The Agent named it in `on`.
const handlers = { approve: (params: Record<string, unknown>) => emit("action", "approve", params) };
</script>

<template>
  <JSONUIProvider :registry="registry" :initial-state="props.spec.state" :handlers="handlers">
    <Renderer :spec="props.spec" :registry="registry" />
  </JSONUIProvider>
</template>
```

Add your own component with `defineCatalogEntry()`, and build a catalog with `defineCatalog([...viteHubCatalogEntries, myEntry])`. Pass that catalog in the `catalog` option of each function. `catalogJsonSchema()` gives the JSON Schema of a spec for structured output, `toJsonRenderCatalog()` gives a json-render catalog, and `toA2ui()` and `fromA2ui()` convert specs to and from A2UI messages.
