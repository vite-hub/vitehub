---
title: UI
description: Build AI chat, Agent inspection, diff, and file-tree interfaces with Vue and Nuxt.
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-ph-squares-four-light
---

`@vite-hub/ui` is the interface layer for ViteHub applications. It combines AI SDK message contracts, Nuxt UI styling, reusable Vue behavior, and Pierre's code views without replacing any of those foundations.

::u-page-grid{class="not-prose mt-8 sm:grid-cols-2"}
  :::u-page-card
  ---
  title: Install the package
  description: Configure the Nuxt module or Vite plugin and load the default styles.
  icon: i-lucide-package
  to: /docs/ui/installation
  ---
  :::
  :::u-page-card
  ---
  title: Render a chat
  description: Connect an AI SDK or ViteHub chat directly to the component layer.
  icon: i-ph-chat-circle-text-light
  to: /docs/ui/chat
  ---
  :::
  :::u-page-card
  ---
  title: Customize message parts
  description: Render text, reasoning, tools, files, sources, and typed data parts.
  icon: i-lucide-blocks
  to: /docs/ui/message-parts
  ---
  :::
  :::u-page-card
  ---
  title: Inspect Agent work
  description: Browse sessions, render invocation activity, and inspect the captured configuration.
  icon: i-ph-activity-light
  to: /docs/ui/invocation
  ---
  :::
::

## Layers

| Layer        | Owns                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------- |
| AI SDK       | `UIMessage`, `ChatStatus`, streaming state, tool parts, and transport helpers.                 |
| Headless Vue | Scroll intent, live-edge following, prepend preservation, and message jumps.                   |
| Nuxt UI      | Theme tokens and established chat, prompt, reasoning, tool, button, and badge components.      |
| ViteHub UI   | Part dispatch, defaults, Markdown presentation, attachments, Agent inspection, and code views. |
| Pierre       | Diff rendering and path-first file trees.                                                      |

The package does not own chat transport. Use `useChat()` from `@ai-sdk/vue` or the ViteHub wrapper from `vite-hub/agent/vue`, then pass its reactive values to the UI.

## Components

- [Chat](/docs/ui/chat) and [Chat message](/docs/ui/chat-message)
- [Session](/docs/ui/session)
- [Message parts](/docs/ui/message-parts) and [Markdown](/docs/ui/markdown)
- [Chat prompt](/docs/ui/chat-prompt) and [attachments](/docs/ui/attachments)
- [Message scroller](/docs/ui/message-scroller)
- [Invocation list](/docs/ui/invocation-list), [invocation](/docs/ui/invocation), and [invocation inspector](/docs/ui/invocation-inspector)
- [Diff](/docs/ui/diff), [file tree](/docs/ui/file-tree), and [trace](/docs/ui/trace)
