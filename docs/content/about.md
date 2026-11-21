---
title: About ViteHub
description: What ViteHub builds, how the project works, and where its source and docs live.
---

ViteHub is an open-source project for Vite apps that need server features without locking into one framework or host. It provides Server Primitives for storage, databases, queues, workflows, schedules, sandboxes, email, authentication, and more. Call them from server code or use them in Agents through Capabilities, Workspaces, Sources, Triggers, and Channels.

## What the project is for

Use ViteHub when you want one API that you can inspect, in local development and on supported production hosts:

- Definitions stay in your repository.
- You can read the generated host files before you deploy.
- Runtime helpers keep provider bindings out of your app code.
- Coding agents can read installed types, generated files, CLI help, and public docs instead of a private dashboard.

ViteHub is a framework and a set of packages, not a managed agent service. Installing it creates no account on vitehub.dev and sends no app data to a shared ViteHub runtime. Each app chooses its own hosts, model and storage providers, credentials, security rules, and operations.

## Open development

Source code, issues, releases, and history live in the [ViteHub GitHub repository](https://github.com/vite-hub/vitehub). Packages are on npm as `vite-hub` and `@vite-hub/*` under the Apache 2.0 license. The docs at vitehub.dev cover the current API, supported hosts, and provider-specific limits.

For questions, bug reports, doc fixes, or private security reports, visit the [ViteHub contact page](/contact).
