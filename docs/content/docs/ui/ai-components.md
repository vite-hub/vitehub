---
title: AI components
description: "Console-ready Vue components for chat, sessions, Agent runs, and code views, from the @vite-hub/ui package."
navigation.order: 6
navigation.group: AI components
icon: i-lucide-layout-grid
---

`@vite-hub/ui` gives you the Vue and Nuxt components of the ViteHub Console. They are built on Nuxt UI. Start with a full Console block, then connect your data.

The package draws the UI. Your app sends and stores data and checks access. Every example uses fake data, makes no network requests, and shows its source below.

## A Console with the defaults

Select a session to read and reply. This example uses the default styles and layouts.

::example{name="ChatAppBlock" flush reset height=36}
::

[Install the package](/docs/ui/installation) and copy the [Chat app](/docs/ui/blocks/chat-app), [Code review](/docs/ui/blocks/code-review), or [Collaborative editor](/docs/ui/blocks/collaborative-editor) into your app. Each block shows how to connect real data.

## Components

::page-list{exclude="Start, AI components"}
- **Console:** [Chat app](/docs/ui/blocks/chat-app), [Code review](/docs/ui/blocks/code-review), [Collaborative editor](/docs/ui/blocks/collaborative-editor)
- **Parts:** [Message](/docs/ui/message), [Bubble](/docs/ui/bubble), [Marker](/docs/ui/marker), [Attachment](/docs/ui/attachment), [Trace](/docs/ui/trace), [Code block](/docs/ui/code-block), [Copy button](/docs/ui/copy-button), [Status](/docs/ui/status)
- **Chat:** [Chat](/docs/ui/chat), [Chat message](/docs/ui/chat-message), [Message parts](/docs/ui/message-parts), [Markdown](/docs/ui/markdown), [Markdown Editor](/docs/ui/markdown-editor), [Prompt input](/docs/ui/prompt-input), [Filter search](/docs/ui/filter-search), [Chat session](/docs/ui/chat-session), [Agent session](/docs/ui/agent-session)
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
| Chat, sessions, Agent views, Markdown, attachments | ViteHub UI |
| Diffs and path-first file trees | Pierre |

The package does not send messages. Use `useChat()` from `@ai-sdk/vue` or from `vite-hub/agent/vue`, then pass its values to the components.

## Entry points

| Import                    | Use it for                                                                     |
| ------------------------- | ------------------------------------------------------------------------------ |
| `@vite-hub/ui`            | Styled components, composables, and display and Pierre diff helpers. |
| `@vite-hub/ui/headless`   | Message scroller and Choices input parts, without styles or Nuxt UI. |
| `@vite-hub/ui/markdown-editor` | `MarkdownEditor`. It has its own entry, so pages without it never load Tiptap. |
| `@vite-hub/ui/workspace` | The live app parts and `PlaygroundContainer` for tutorials and playgrounds. It has its own entry, so pages without it never load CodeMirror or xterm. |
| `@vite-hub/ui/playground` | Share links and zips for a playground, with no UI. They run in Node too. |
| `@vite-hub/ui/theme` and `@vite-hub/ui/theme.css` | `vitehubTheme`, the Nuxt UI app config, and the design tokens. Import the theme from `nuxt.config`. |
| `@vite-hub/ui/vite`       | Vite plugin for Vue apps. Configures Nuxt UI and Comark. |
| `@vite-hub/ui/styles.css` | Stylesheet. Load it after Tailwind CSS and Nuxt UI. |
