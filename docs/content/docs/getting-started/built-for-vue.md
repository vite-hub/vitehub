---
title: Built for the Vue ecosystem
description: Use ViteHub UI Vue components for chat, sessions, files, and Agent inspection, then connect them to your own data.
navigation: false
navigation.title: Built for the Vue ecosystem
navigation.order: 3.5
navigation.group: Start
icon: i-simple-icons-vuedotjs
---

I am Maxi, and I built ViteHub's Vue component package for Vue and Nuxt applications.

`@vite-hub/ui` holds the chat, trace, diff, and file parts behind interfaces
such as the ViteHub Console. The Console owns its Agent run views; see the
[Console documentation](/docs/development/console).

The server packages do not need Vue. A React app, a server route, or a CLI can
call the same Server Primitives and run the same Agents.

## Start with a complete block

The [Chat App](/docs/ui/blocks/chat-app) joins a session list and a chat view. The Console shows Agent runs and their recorded steps. Start with one of
these blocks, then replace its slots when your app needs different controls.

The components use Vue props, events, and slots. The Nuxt integration
registers them for you. Read [Installation](/docs/ui/installation) for setup
and required styles, or follow the [chat tutorial](/docs/ui/chat-tutorial) to
render your first component.

## Connect your own data

The components show the data you pass to them. The package does not create an
Agent, store sessions, or give access to a Workspace. Connect the UI to your
server routes and check authorization in those routes.

Each component's reference page lists its input and events. See
[Agents](/docs/agents) for execution and [Workspaces](/docs/workspace) for
file access.
