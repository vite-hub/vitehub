---
title: ViteHub UI
description: "Console-ready Vue components for chat, sessions, Agent runs, and code views."
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-lucide-layout-grid
---

`@vite-hub/ui` is the Vue and Nuxt component layer for the ViteHub Console. Start with a complete Console block, then connect your own data.

The package owns presentation, layout, and interaction defaults. Your app owns transport, persistence, and authorization. Every example uses synthetic data, makes no network requests, and shows the source below the live preview.

## A Console with the defaults

Select a session to read its messages and reply. This example uses the package styles and built-in layouts.

::example{name="ChatAppBlock" flush reset height=36}
::

[Install the package](/docs/ui/installation), then copy the [Chat app](/docs/ui/blocks/chat-app), [Code review](/docs/ui/blocks/code-review), or [Collaborative editor](/docs/ui/blocks/collaborative-editor) into your application. Each block explains how to connect real data.

## Components

::page-list{exclude="Start"}
- **Console:** [Chat app](/docs/ui/blocks/chat-app), [Code review](/docs/ui/blocks/code-review), [Collaborative editor](/docs/ui/blocks/collaborative-editor)
- **Parts:** [Message](/docs/ui/message), [Bubble](/docs/ui/bubble), [Marker](/docs/ui/marker), [Attachment](/docs/ui/attachment), [Trace](/docs/ui/trace), [Code block](/docs/ui/code-block), [Copy button](/docs/ui/copy-button), [Status](/docs/ui/status)
- **Chat:** [Chat](/docs/ui/chat), [Chat message](/docs/ui/chat-message), [Message parts](/docs/ui/message-parts), [Markdown](/docs/ui/markdown), [Markdown Editor](/docs/ui/markdown-editor), [Prompt input](/docs/ui/prompt-input), [Filter search](/docs/ui/filter-search), [Chat session](/docs/ui/chat-session)
- **Collaboration:** [Comments](/docs/ui/comments), [Avatar stack](/docs/ui/avatar-stack), [Connection status](/docs/ui/connection-status), [Sync status](/docs/ui/sync-status), [Carets](/docs/ui/carets)
- **Agent work:** [Tool list](/docs/ui/tool-list), [Diff](/docs/ui/diff), [Code view](/docs/ui/code-view), [File tree](/docs/ui/file-tree), [Device frame](/docs/ui/device-frame), [Playground render](/docs/ui/playground-render)
- **Utilities:** [Attachments](/docs/ui/attachments), [Message scroller](/docs/ui/message-scroller)
::

## What each layer owns

| Concern | Owner |
| ------- | ----- |
| Message contracts and transport | AI SDK or your ViteHub Agent route |
| Scroll intent and message jumps | ViteHub headless Vue primitives |
| Tokens and basic controls | Nuxt UI |
| Chat, sessions, Agent inspection, Markdown, and attachments | ViteHub UI |
| Diffs and path-first file trees | Pierre |

The package does not send messages. Use `useChat()` from `@ai-sdk/vue` or the ViteHub wrapper from `vite-hub/agent/vue`, then pass its reactive values to the components.

## Entry points

| Import                    | Use it for                                                                     |
| ------------------------- | ------------------------------------------------------------------------------ |
| `@vite-hub/ui`            | Styled components, composables, display helpers, and Pierre diff helpers.      |
| `@vite-hub/ui/headless`   | Message scroller and Choices input primitives without styles or Nuxt UI.       |
| `@vite-hub/ui/markdown-editor` | `MarkdownEditor`. It has its own entry, so pages without it never load Tiptap. |
| `@vite-hub/ui/workspace` | The live app parts for docs tutorials and playgrounds. It has its own entry, so pages without it never load CodeMirror or xterm. |
| `@vite-hub/ui/vite`       | The Vite plugin for Vue applications. It configures Nuxt UI and Comark.        |
| `@vite-hub/ui/styles.css` | The package stylesheet. Load it after Tailwind CSS and Nuxt UI.                |
