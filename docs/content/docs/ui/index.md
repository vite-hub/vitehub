---
title: UI
description: "Vue components for AI chat, Agent Invocations, traces, diffs, and file trees."
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-ph-squares-four-light
---

`@vite-hub/ui` gives Vue and Nuxt applications the interface for AI features: chat, prompts, message parts, Agent sessions, Invocation inspection, traces, diffs, and file trees. The components render AI SDK message contracts with Nuxt UI styling. They do not own transport, persistence, or authorization.

Each component page has a live preview, the source of that preview, variants, and an API reference. Every example uses synthetic data and makes no network requests.

::u-page-grid{class="not-prose mt-8 sm:grid-cols-2"}
  :::u-page-card
  ---
  title: Install the package
  description: Add the Nuxt module or the Vite plugin, then load the styles.
  icon: i-lucide-package
  to: /docs/ui/installation
  ---
  :::
  :::u-page-card
  ---
  title: Copy a block
  description: Start from a complete chat app, Invocation dashboard, or code review view.
  icon: i-ph-layout-light
  to: /docs/ui/blocks/chat-app
  ---
  :::
::

## Components

::ui-component-gallery
- **Chat:** [Chat](/docs/ui/chat), [Chat message](/docs/ui/chat-message), [Message parts](/docs/ui/message-parts), [Markdown](/docs/ui/markdown), [Chat prompt](/docs/ui/chat-prompt), [Session](/docs/ui/session)
- **Agent work:** [Invocation list](/docs/ui/invocation-list), [Invocation](/docs/ui/invocation), [Invocation inspector](/docs/ui/invocation-inspector), [Capability inspector](/docs/ui/capability-inspector), [Tool list](/docs/ui/tool-list), [Trace](/docs/ui/trace), [Diff](/docs/ui/diff), [Code view](/docs/ui/code-view), [File tree](/docs/ui/file-tree)
- **Utilities:** [Attachments](/docs/ui/attachments), [Message scroller](/docs/ui/message-scroller)
- **Blocks:** [Chat app](/docs/ui/blocks/chat-app), [Invocation dashboard](/docs/ui/blocks/invocation-dashboard), [Code review](/docs/ui/blocks/code-review)
::

## Layers

| Layer        | Owns                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------- |
| AI SDK       | `UIMessage`, `ChatStatus`, streaming state, tool parts, and transport helpers.                 |
| Headless Vue | Scroll intent, live-edge following, prepend preservation, and message jumps.                   |
| Nuxt UI      | Theme tokens and the chat, prompt, reasoning, tool, button, and badge components.              |
| ViteHub UI   | Part dispatch, defaults, Markdown presentation, attachments, Agent inspection, and code views. |
| Pierre       | Diff rendering and path-first file trees.                                                      |

The package does not send messages. Use `useChat()` from `@ai-sdk/vue` or the ViteHub wrapper from `vite-hub/agent/vue`, then pass its reactive values to the components.

## Entry points

| Import                    | Use it for                                                                     |
| ------------------------- | ------------------------------------------------------------------------------ |
| `@vite-hub/ui`            | Styled components, composables, display helpers, and Pierre diff helpers.      |
| `@vite-hub/ui/headless`   | Message scroller primitives without styles or Nuxt UI.                         |
| `@vite-hub/ui/nuxt`       | The Nuxt module. It installs Nuxt UI, registers components, and loads the CSS. |
| `@vite-hub/ui/vite`       | The Vite plugin for Vue applications. It configures Nuxt UI and Comark.        |
| `@vite-hub/ui/styles.css` | The package stylesheet. Load it after Tailwind CSS and Nuxt UI.                |
