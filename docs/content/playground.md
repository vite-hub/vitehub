---
title: Playground
description: Edit and run a ViteHub app in your browser. Start from an example, then share a link or download the files.
layout: playground
connect: [anthropic, github, netlify, openai, vercel]
examples:
  - { id: kv, label: KV, group: Server Primitives, description: Store and read a value., dir: ../fixtures/tutorials/server-primitives, open: server/api/settings.post.ts, preview: /api/health }
  - { id: blob, label: Blob, group: Server Primitives, description: Write a file and read it back., dir: ../fixtures/tutorials/playground-blob, open: server/api/note.get.ts, preview: /api/note }
  - { id: queue, label: Queue, group: Server Primitives, description: Run a job in the background., dir: ../fixtures/tutorials/playground-queue, open: server/queues/welcome-email.ts, preview: /api/welcome }
  - { id: cache, label: Cache, group: Server Primitives, description: Cache a route for 10 seconds., dir: ../fixtures/tutorials/playground-cache, open: server/api/time.get.ts, preview: /api/time }
  - { id: rate-limit, label: Rate Limit, group: Server Primitives, description: Allow three requests a minute., dir: ../fixtures/tutorials/playground-rate-limit, open: server/api/upload.get.ts, preview: /api/upload }
  - { id: agent, label: Agent, group: Agents, description: An Agent that a route invokes., dir: ../fixtures/tutorials/first-agent, open: server/agents/greeting.ts, preview: /api/health }
  - { id: channels, label: Channels, group: Agents, description: Chat with an Agent in a simulated Slack., dir: ../fixtures/tutorials/playground-channels, open: server/agents/support.ts, preview: /_vitehub/agents/support/webhooks/slack }
  - { id: ui, label: ViteHub UI, group: UI, description: "A Vue app with a dialog, tabs, a menu, and toasts.", dir: ../fixtures/tutorials/playground-ui, open: src/App.vue, preview: / }
---

## How it works

- The app runs in a WebContainer, a Node.js runtime inside the browser tab. The first start downloads the dependencies of the app.
- A share link keeps your files in the part of the URL after `#`, which the browser does not send to a server.
- Download saves the files of the app as a zip, so you can run it on your machine.
- Connect adds a token for GitHub, a deploy host, or a model provider. The token stays in this tab, and the app gets it as an environment variable.
