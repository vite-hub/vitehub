---
title: Message Parts
description: "Render every AI SDK UIMessage part type, including tools, files, sources, and typed data, with a slot for each type."
navigation.order: 22
navigation.group: Chat
icon: i-lucide-blocks
---

`MessageParts` renders the `parts` array of an AI SDK `UIMessage`. Text uses `Markdown`. Consecutive reasoning, tool, and source parts render as lines in one trace. Images open a preview. Other files are links. Use it in custom layouts, or replace a part type with a slot.

The parts come from [comark-chat](https://comark-ui.onmax.me/chat), which renders the same message in Vue, React, and Svelte. ViteHub adds its `Markdown` (with math and typeset styles), its image preview, and its colors.

::example{name="MessagePartsExample" height=18}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui`:

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

The root is a `div` with `data-slot="message-parts"`. A part from the `part` slot ends the current trace list.

```text
MessageParts (data-slot="message-parts", class="vh-message-parts cht")
├── Markdown, for each text part
├── ul.cht-trace, for each run of reasoning, tool, and source parts
│   ├── li.cht-step, a details element for reasoning, with its Markdown
│   ├── li.cht-step, a details element for a tool call, with its input, output, and error
│   └── li.cht-step, a link for a source
├── Image preview or file link, for each file part
└── step and fallback slots
```

Each step has `data-kind` (`reasoning`, `tool`, or `source`) and `data-status` (`running`, `waiting`, `error`, or `done`). Colors come from the `--comark-*` tokens, which ViteHub sets from its own tokens on `.vh-message-parts`.

## Features

- Renders every AI SDK `UIMessage` part type.
- Groups reasoning, tool calls, and sources into one Trace per run.
- Gives every part type its own slot.

## Supported Parts

| Part                                 | Default rendering                                          |
| ------------------------------------ | ---------------------------------------------------------- |
| `text`                               | Streaming-aware Markdown through `Markdown`.               |
| `reasoning`                          | A trace line (Thinking, then Thought) that expands into the reasoning text. |
| `tool-*`, `dynamic-tool`             | A trace line with the tool title and state, that expands into the input, output, and error. |
| `file`                               | A preview for images. A link that opens or downloads other files. |
| `source-url`, `source-document`      | A trace line that links to the source, or shows the document title. |
| `step-start`                         | Nothing, unless you use the `step` slot.                   |
| `data-*` and other types             | Nothing, unless you use the `fallback` slot.               |

File and source links open only `http:` and `https:` URLs. A `data:` file URL is a download link only when the part has a `filename`.

## Tool States

| State | Label |
| --- | --- |
| `input-streaming`, `input-available`, `approval-responded` | Running |
| `approval-requested` | Needs approval |
| `output-error` | Failed |
| `output-denied` | Denied |
| finished | Only the title |

The body shows the input, output, and error text that exist.

::example{name="MessagePartsToolStatesExample" height=16}
::

## Typed Data Parts

Render your app's data parts, such as `data-deploy`, with the `fallback` slot.

::example{name="MessagePartsDataExample" height=8}
::

## Files and Sources

Images open a large preview. Other files are links, and a named `data:` file downloads. Source URLs open in a new tab.

::example{name="MessagePartsFilesExample" height=18}
::

## Accessibility

- Image previews are buttons. The large view closes with Escape and returns focus to the thumbnail.
- Reasoning and tool calls are native `details` elements that open with Enter and Space.
- External source links open in a new tab with `rel="noreferrer"`.

## API Reference

### MessageParts

Renders the parts of one message in order.

#### Props

| Prop        | Type                 | Default  | Description                                                  |
| ----------- | -------------------- | -------- | ------------------------------------------------------------ |
| `parts`     | `UIMessage['parts']` | Required | The parts to render, in order.                               |
| `streaming` | `boolean`            | `false`  | Renders all text and reasoning parts as streaming. A part with `state: 'streaming'` streams without it. |

#### Slots

Every slot receives `{ part, index }` and what comark-chat read from the part, such as `title`, `state`, and `values` for a tool. A slot that renders nothing keeps the default.

| Slot        | Description                                                              |
| ----------- | ------------------------------------------------------------------------ |
| `part`      | Runs first for every part. Its content replaces the default. |
| `markdown`  | Receives `{ value, streaming }`. Replaces the Markdown of text and reasoning parts. |
| `text`      | Replaces `text` parts. |
| `reasoning` | Replaces `reasoning` parts.                                              |
| `tool`      | Replaces `tool-*` and `dynamic-tool` parts.                              |
| `file`      | Replaces `file` parts.                                                   |
| `source`    | Replaces `source-url` and `source-document` parts.                       |
| `step`      | Renders `step-start` parts.                                              |
| `fallback`  | Renders every other part type, such as `data-*`. |

## Related

- [Markdown](/docs/ui/markdown) renders text parts.
- [Chat message](/docs/ui/chat-message) wraps the parts in a message layout.
