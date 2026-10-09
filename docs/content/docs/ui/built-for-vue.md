---
title: UI for Vue and Nuxt
description: "Use Vue components for chat, sessions, files, and Agent inspection."
navigation.title: Why Vue?
navigation.order: 3.5
navigation.group: Start
icon: i-simple-icons-vuedotjs
---

`@vite-hub/ui` is ViteHub's Vue component package. It contains the chat,
session, invocation, trace, diff, and file components used by the ViteHub
Console. Use them in a Vue or Nuxt application when you need those interfaces.

The server packages work independently of Vue. A React application, a server
route, or a CLI can call the same Server Primitives and run the same Agents.
Choose your frontend separately from your server features.

## Start with a complete block

The [Chat App](/docs/ui/blocks/chat-app) combines a session list and chat view.
The [Invocation Dashboard](/docs/ui/blocks/invocation-dashboard) shows Agent
runs and their recorded steps. Start with one of these blocks, then replace
its slots when your app needs different controls.

The components use Vue props, events, and slots. Nuxt integration registers
them for your app. Read [Installation](/docs/ui/installation) for the setup
and required styles, or follow the [UI tutorial](/docs/ui/get-started) to
render your first component.

## Connect your own data

UI components display the data you pass to them. Installing the package does
not create an Agent, store sessions, or grant access to a Workspace. Connect
the UI to your server routes, then handle authorization in those routes.

Use the component's reference page to check its input and events. Use the
[Agent documentation](/docs/agents) for execution and
[Workspaces](/docs/workspace) for file access.
