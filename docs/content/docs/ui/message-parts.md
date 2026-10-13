---
title: Message Parts
description: "Render every AI SDK UIMessage part type, with a slot for each type."
navigation.order: 22
navigation.group: Chat
icon: i-lucide-blocks
---

`AgentMessageParts` renders the `parts` array of an AI SDK `UIMessage`. Text uses `AgentMarkdown`. Reasoning and tools use Nuxt UI. Files and sources use links or image previews. Use it inside custom message layouts, or replace one part type with a slot.

::component-preview{name="MessagePartsExample"}
::

## Usage

```vue
<AgentMessageParts :parts="message.parts" :streaming="status === 'streaming'" />
```

## Supported parts

| Part                                 | Default rendering                                          |
| ------------------------------------ | ---------------------------------------------------------- |
| `text`                               | Streaming-aware Markdown through `AgentMarkdown`.          |
| `reasoning`                          | `UChatReasoning`.                                          |
| `tool-*`, `dynamic-tool`             | `UChatTool` with the output, the error text, or the input. Loading while the input streams or waits. |
| `file`                               | Image preview for images. Download link for other files.   |
| `source-url`, `source-document`      | Source link or document title.                             |
| `step-start`                         | Nothing, unless you use the `step` slot.                   |
| `data-*` and other types             | Nothing, unless you use the `fallback` slot.               |

File and source links open only `http:` and `https:` URLs. A `data:` file URL is a download link only when the part has a `filename`.

## Examples

### Tool states

A tool part is loading in the `input-streaming` and `input-available` states. The body shows the output when it exists, then the error text, then the input.

::component-preview{name="MessagePartsToolStatesExample"}
::

### Typed data parts

Render application data parts, for example `data-deploy`, through the `fallback` slot.

::component-preview{name="MessagePartsDataExample"}
::

### Files and sources

Images open an expanded preview. Other files are download links. Source URLs open in a new tab.

::component-preview{name="MessagePartsFilesExample"}
::

## API reference

### AgentMessageParts

#### Props

| Prop        | Type                 | Default  | Description                                                  |
| ----------- | -------------------- | -------- | ------------------------------------------------------------ |
| `parts`     | `UIMessage['parts']` | Required | The parts to render, in order.                               |
| `streaming` | `boolean`            | `false`  | Renders every text and reasoning part in the streaming state. A part with `state: 'streaming'` streams without this prop. |

#### Slots

Every slot receives `{ part, index }`.

| Slot        | Description                                                              |
| ----------- | ------------------------------------------------------------------------ |
| `part`      | Runs first for every part. Return content to replace the default output. |
| `text`      | Replaces `text` parts.                                                   |
| `reasoning` | Replaces `reasoning` parts.                                              |
| `tool`      | Replaces `tool-*` and `dynamic-tool` parts.                              |
| `file`      | Replaces `file` parts.                                                   |
| `source`    | Replaces `source-url` and `source-document` parts.                       |
| `step`      | Renders `step-start` parts.                                              |
| `fallback`  | Renders every other part type, for example `data-*`.                     |

## Accessibility

- Image previews are buttons. The expanded view closes with Escape and returns focus to the thumbnail.
- Links to external sources open in a new tab with `rel="noreferrer"`.

## Related

- [Markdown](/docs/ui/markdown) renders text parts.
- [Chat message](/docs/ui/chat-message) wraps the parts in a message layout.
