---
title: Tool List
description: "Render Agent tool contracts with labels, schemas, MCP origin, and call counts."
navigation.order: 35
navigation.group: Agent work
icon: i-lucide-wrench
---

`ToolList` shows a list of tool contracts (what each tool takes and returns). Use it to show which tools an Agent had and which it used. The inspectors and the Capability reference pages in these docs use it.

::example{name="ToolListExample" height=20}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui`:

```ts
import { ToolList } from "@vite-hub/ui";
```

## Usage

```ts
import { ToolList, type AgentToolInspection } from "@vite-hub/ui";
```

```vue
<template>
  <ToolList :tools="configuration.tools" :calls="{ search_meals: 3 }" @select="showFirstCall" />
</template>
```

## Features

- Shows the name, label, icon, and call count of each tool.
- A tool with a description or schemas expands to show them, with a table of input fields.
- MCP tools show their server and original tool name.

## Contracts Without Usage

Leave out `calls` to show only the contracts, such as for a build-time reference.

::example{name="ToolListContractsExample" height=16}
::

## Call Counts

- Without `calls`, rows show no usage.
- With `calls`, a used tool shows **n calls**. An unused tool shows a dash named **Not used**.
- The count is a button only when you listen to `select`. Selecting it does not toggle the row.

## Accessibility

- Tools with details use native `<details>` disclosures.
- The call count button has the name **n calls, show the first call**.

## API Reference

### ToolList

Renders tool contracts with optional call counts.

#### Props

| Prop    | Type                                 | Default  | Description                                  |
| ------- | ------------------------------------ | -------- | -------------------------------------------- |
| `tools` | `readonly AgentToolInspection[]`     | Required | The tool contracts. |
| `calls` | `Readonly<Record<string, number>>`   |          | Call counts by tool name.                    |

#### Events

| Event    | Payload        | Description                                       |
| -------- | -------------- | ------------------------------------------------- |
| `select` | `name: string` | The call count of a used tool was selected. |

#### Types

```ts
import type { AgentInspectionValue } from "vite-hub/ui"

interface AgentToolInspection {
  name: string;
  /** Short past-tense label from the tool's title, for example "Searched meals". */
  label?: string;
  /** Iconify icon name, for example "i-lucide-database". */
  icon?: string;
  description?: string;
  inputSchema?: AgentInspectionValue;
  outputSchema?: AgentInspectionValue;
  mcp?: { server: string; name: string };
  /** Capability that registered this tool, when known. */
  capabilityId?: string;
}
```

Icons use Nuxt UI's `UIcon`. To replace it, see [Nuxt UI components](/docs/ui/installation#nuxt-ui-components).

## Related

- [Console](/docs/console) groups the tools of a run by Capability.
- [Code block](/docs/ui/code-block) shows the input and output of a tool call.
