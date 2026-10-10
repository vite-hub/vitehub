---
title: Tool List
description: "Render Agent tool contracts with labels, schemas, MCP origin, and call counts."
navigation.order: 35
navigation.group: Agent work
icon: i-ph-wrench-light
---

`AgentToolList` renders a list of tool contracts. Each tool shows its name, label, icon, and call count. A tool with a description or schemas expands to show them, with a table of input fields. Use it to show which tools an Agent had and which it used. The inspectors use it, and the Capability reference pages in these docs use it too.

::component-preview{name="ToolListExample"}
::

## Usage

```vue
<AgentToolList :tools="configuration.tools" :calls="{ search_meals: 3 }" @select="showFirstCall" />
```

## Examples

### Contracts without usage

Leave out `calls` to show the contracts only, for example for a build-time reference. MCP tools show their server and original tool name.

::component-preview{name="ToolListContractsExample"}
::

## Call counts

- Without `calls`, rows show no usage.
- With `calls`, a used tool shows **n calls**. An unused tool shows a dash with the accessible name **Not used**.
- The count is a button only when you listen to `select`. Selecting it does not toggle the row.

## API reference

### AgentToolList

#### Props

| Prop    | Type                                 | Default  | Description                                  |
| ------- | ------------------------------------ | -------- | -------------------------------------------- |
| `tools` | `readonly AgentToolInspection[]`     | Required | The tool contracts to render.                |
| `calls` | `Readonly<Record<string, number>>`   |          | Call counts by tool name.                    |

#### Events

| Event    | Payload        | Description                                       |
| -------- | -------------- | ------------------------------------------------- |
| `select` | `name: string` | The viewer selected the call count of a used tool. |

#### Types

```ts
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

Icons render through the `UIcon` component that `createViteHubUI()` registers. Without it, rows show no icon.

## Accessibility

- Tools with details use native `<details>` disclosures.
- The call count button has the name **n calls, show the first call**.

## Related

- [Capability inspector](/docs/ui/capability-inspector) groups tools by Capability.
- [Invocation inspector](/docs/ui/invocation-inspector) lists every tool of a run.
