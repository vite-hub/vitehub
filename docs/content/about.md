---
title: About ViteHub
description: What ViteHub builds, how the project works, and where its source and docs live.
---

ViteHub is an open-source project for Vite apps that need server features without being tied to one framework or host. It gives you Server Primitives for storage, databases, queues, workflows, schedules, sandboxes, email, authentication, and more. Call them from server code, or use them in Agents through Capabilities, Workspaces, Sources, Triggers, and Channels.

## What the project is for

Use ViteHub when you want one API that you can inspect, in local development and on supported production hosts:

- Definitions stay in your repository.
- You can inspect the generated host files before you deploy.
- Runtime helpers keep provider bindings out of your code.
- A coding agent can read the installed types, generated files, command help, and public docs instead of a private dashboard.

ViteHub is a framework and a set of packages, not a managed agent service. Installing it creates no account on vitehub.dev and sends no app data to a shared ViteHub runtime. Each app chooses its own hosts, model and storage providers, credentials, security rules, and operations.

## Open development

The source code, issues, releases, and history live in the [ViteHub GitHub repository](https://github.com/vite-hub/vitehub). Packages are on npm as `vite-hub` and `@vite-hub/*`. The license is Apache 2.0. The docs at vitehub.dev cover the current API, supported hosts, and provider-specific limits.

For questions, bug reports, doc fixes, or private security reports, see the [ViteHub contact page](/contact).
