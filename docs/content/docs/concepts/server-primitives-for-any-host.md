---
title: Server primitives
description: Build server-backed features with databases, queues, storage, and more while keeping your application portable across hosts.
navigation.group: Start here
navigation.order: 2
icon: i-lucide-server
---

Server Primitives are APIs that application code calls to work with server-side artifacts such as environment values, databases, queues, workflows, files, and sandboxes.

## The common pattern

Most primitives follow the same setup:

1. **Enable the primitive.** Add it to the framework `vitehub({ ... })` configuration, or register the package integration manually, such as `hubEmail()`.
2. **Declare it when needed.** Put Definitions in the location documented by the primitive. Many use a `server/<primitive>/` directory, while others use files such as `server/email.ts`, `server.email.ts`, or a package-specific suffix such as `*.browser.ts`; some primitives do not use discovery.
3. **Call the stable import.** Use the primitive's Runtime Helper from server code. Do not import generated files or provider SDKs directly.
4. **Let ViteHub adapt it.** During development and build, ViteHub discovers declarations, generates types and registries when needed, and emits host-specific output for deployment.

## Choose a primitive for the job

| You need | Start with |
| --- | --- |
| Configure the app | [Env](/docs/server-primitives/env), [Auth](/docs/server-primitives/auth), or [Rate Limit](/docs/server-primitives/rate-limit) |
| Store data and files | [Database](/docs/server-primitives/database), [KV](/docs/server-primitives/kv), [Blob](/docs/server-primitives/blob), [Workspace](/docs/server-primitives/workspace), or [Source](/docs/server-primitives/source) |
| Send or receive messages | [Email](/docs/server-primitives/email) or [Channels](/docs/agents/channels) |
| Run work later | [Queue](/docs/server-primitives/queue), [Schedule](/docs/server-primitives/schedule), or [Workflow](/docs/server-primitives/workflows) |
| Run isolated automation | [Browser](/docs/server-primitives/browser), [Shell](/docs/server-primitives/shell), or [Sandbox](/docs/server-primitives/sandbox) |

## Inspect the boundary

Look for the package's Vite Integration, Runtime Helper, and generated Provider Output. The primitive page documents the package contract; the [runtime and host support matrix](/docs/frameworks-hosts/support-matrix) shows where that contract is currently proven.

Read [Definitions and discovery](/docs/concepts/definitions-and-discovery), [Runtime Helpers and stable imports](/docs/concepts/runtime-helpers-and-stable-imports), or [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) for the details, or open [First server primitive](/docs/getting-started/first-server-primitive) to build one.
