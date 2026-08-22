---
title: About ViteHub
description: Learn what ViteHub builds, how the project works, and where its public source and documentation live.
---

# About ViteHub

ViteHub is an open-source project for Vite applications that need server behavior without tying application code to one framework or deployment provider. It supplies Server Primitives for storage, databases, queues, workflows, schedules, sandboxes, email, authentication, and other runtime needs. Developers can call those primitives directly from server code or compose them into Agent Definitions with explicit Capabilities, Workspaces, Sources, Triggers, and Channels.

## What the project is for

ViteHub is useful when a team wants one inspectable contract for local development and supported production hosts. Definitions stay in the repository. Generated Provider Output can be inspected before deployment. Runtime Helpers keep provider bindings out of application code. The same approach lets a coding agent read the installed types, generated files, command help, and public documentation instead of relying on a private dashboard.

ViteHub is a framework and package ecosystem, not a managed agent service. Installing ViteHub does not create an account on vitehub.dev or send application data to a shared ViteHub runtime. Each application chooses its own hosts, model providers, storage providers, credentials, security rules, and operational controls.

## Open development

The source code, issue tracker, releases, and contribution history live in the [ViteHub GitHub repository](https://github.com/vite-hub/vitehub). Packages are published under the `vite-hub` and `@vite-hub/*` names on npm. The project uses the Apache License 2.0. Public documentation at vitehub.dev covers the current contract, including supported hosts and the limits that remain provider-specific.

For questions, bug reports, documentation corrections, or private security reports, use the routes listed on the [ViteHub contact page](/contact).
