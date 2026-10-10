---
title: ViteHub UI
description: "Console-ready Vue components for chat, sessions, Agent runs, and code views."
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-ph-squares-four-light
---

`@vite-hub/ui` is the Vue and Nuxt component layer for the ViteHub Console. Start with a complete Console block, then connect your own data.

The package owns presentation, layout, and interaction defaults. Your app owns transport, persistence, and authorization. Every example uses synthetic data, makes no network requests, and shows the source below the live preview.

## A Console with the defaults

Select an Invocation to read its messages, tool calls, and result. The inspector shows its configuration and activity. This example uses the package styles and built-in layouts.

::component-preview{name="InvocationDashboardBlock" flush reset}
::

Start with [the UI tutorial](/docs/ui/get-started), then read [Installation](/docs/ui/installation) for Nuxt and Vue with Vite. Copy the [Invocation dashboard](/docs/ui/blocks/invocation-dashboard), [Chat app](/docs/ui/blocks/chat-app), or [Code review](/docs/ui/blocks/code-review) into your application. Each block explains how to connect real data.

## Components

::ui-component-gallery
- **Console:** [Chat app](/docs/ui/blocks/chat-app), [Invocation dashboard](/docs/ui/blocks/invocation-dashboard), [Code review](/docs/ui/blocks/code-review)
- **Chat:** [Chat](/docs/ui/chat), [Chat message](/docs/ui/chat-message), [Message parts](/docs/ui/message-parts), [Markdown](/docs/ui/markdown), [Chat prompt](/docs/ui/chat-prompt), [Session](/docs/ui/session)
- **Agent work:** [Invocation list](/docs/ui/invocation-list), [Invocation](/docs/ui/invocation), [Invocation inspector](/docs/ui/invocation-inspector), [Timeline](/docs/ui/timeline), [Capability inspector](/docs/ui/capability-inspector), [Tool list](/docs/ui/tool-list), [Trace](/docs/ui/trace), [Diff](/docs/ui/diff), [Code view](/docs/ui/code-view), [File tree](/docs/ui/file-tree)
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
| `@vite-hub/ui/agent-*`    | One styled component entry point, such as `@vite-hub/ui/agent-chat`.            |
| `@vite-hub/ui/headless`   | Message scroller primitives without styles or Nuxt UI.                         |
| `@vite-hub/ui/nuxt`       | The Nuxt module. It installs Nuxt UI, registers components, and loads the CSS. |
| `@vite-hub/ui/vite`       | The Vite plugin for Vue applications. It configures Nuxt UI and Comark.        |
| `@vite-hub/ui/styles.css` | The package stylesheet. Load it after Tailwind CSS and Nuxt UI.                |
