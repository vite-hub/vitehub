---
title: Message Parts
description: "Render every AI SDK UIMessage part type, with a slot for each type."
navigation.order: 22
navigation.group: Chat
icon: i-lucide-blocks
---

`MessageParts` renders the `parts` array of an AI SDK `UIMessage`. Text uses `Markdown`. Reasoning, tool calls, and sources render as lines in one [Trace](/docs/ui/trace) per run of consecutive parts. Files use [Attachment](/docs/ui/attachment) or image previews. Use it inside custom message layouts, or replace one part type with a slot.

::component-preview{name="MessagePartsExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/message-parts`:

```ts
import { MessageParts } from "@vite-hub/ui";
```

## Usage

```ts
import { MessageParts } from "@vite-hub/ui";
```

```vue
<MessageParts :parts="message.parts" :streaming="status === 'streaming'" />
```

## Composition

The root is a `div` with `data-slot="message-parts"`. Consecutive reasoning, tool, and source parts share one `Trace`, so the steps of a turn read as one list. A part from the `part` slot ends the current `Trace`.

```text
MessageParts (data-slot="message-parts")
├── Markdown, for each text part
├── Trace, for each run of reasoning, tool, and source parts
│   ├── TraceCollapsible, for reasoning
│   │   └── Markdown
│   ├── TraceCollapsible, for a tool call
│   │   └── CodeBlock, for the input, output, and error
│   └── TraceLine, for a source
├── Attachment or image preview, for each file part
└── step and fallback slots
```

## Features

- Renders every AI SDK `UIMessage` part type.
- Groups reasoning, tool calls, and sources into one Trace per run.
- Renders text as streaming-aware Markdown.
- Shows images as previews and other files as attachments.
- Gives every part type its own slot.

## Supported Parts

| Part                                 | Default rendering                                          |
| ------------------------------------ | ---------------------------------------------------------- |
| `text`                               | Streaming-aware Markdown through `Markdown`.               |
| `reasoning`                          | A Trace line, Thinking while it streams and Thought after, that expands into the reasoning text. |
| `tool-*`, `dynamic-tool`             | A Trace line with the tool title, and Running or Failed beside it, that expands into small Code Blocks for the input, output, and error. |
| `file`                               | Image preview for images. An Attachment that opens or downloads other files. |
| `source-url`, `source-document`      | A Trace line that links to the source, or the document title. |
| `step-start`                         | Nothing, unless you use the `step` slot.                   |
| `data-*` and other types             | Nothing, unless you use the `fallback` slot.               |

File and source links open only `http:` and `https:` URLs. A `data:` file URL is a download link only when the part has a `filename`.

## Tool States

A tool part is running in the `input-streaming`, `input-available`, and `approval-requested` states. It failed in the `output-error` and `output-denied` states. A finished tool shows only its title. The body shows the input, then the output, then the error text, when each one exists.

::component-preview{name="MessagePartsToolStatesExample"}
::

## Typed Data Parts

Render application data parts, for example `data-deploy`, through the `fallback` slot.

::component-preview{name="MessagePartsDataExample"}
::

## Files and Sources

Images open an expanded preview. Other files are download links. Source URLs open in a new tab.

::component-preview{name="MessagePartsFilesExample"}
::

## Accessibility

- Image previews are buttons. The expanded view closes with Escape and returns focus to the thumbnail.
- Links to external sources open in a new tab with `rel="noreferrer"`.

## API Reference

### MessageParts

Renders the parts of one message in order.

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

## Related

- [Markdown](/docs/ui/markdown) renders text parts.
- [Chat message](/docs/ui/chat-message) wraps the parts in a message layout.
