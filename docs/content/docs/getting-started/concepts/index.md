---
title: How ViteHub works
description: Understand the few parts that connect application code, server features, and Agents.
navigation.title: How ViteHub works
navigation.order: 7
navigation.group: Next steps
icon: i-lucide-map
---

ViteHub connects your server code to your host's resources. You choose features in your configuration and call their server APIs. The build prepares the routes, bindings, and files your host needs.

## Server features belong to your application

A Server Primitive is an API for one server feature, like KV, Database, Blob, or Queue. Call it directly from a route without needing an Agent.

For example, a settings route reads a value with `kv.get()`. Locally, KV can use a local store. On Cloudflare, the same route can use a Workers KV binding. Your configuration selects the provider, and the import stays the same. Provider limits still apply, and each package lists them on its host and error pages.

Try this in [your first Server Primitive](/docs/getting-started/first-server-primitive).

## Definitions give state and work a name

Some features need a Definition file. A Queue Definition declares a background job handler. An Agent Definition declares what an Agent can do. ViteHub finds these files and names them by path.

Your code calls the named feature rather than generated provider files. Read [Definition discovery](/docs/development/definition-discovery) when you add a Definition or check its name.

## Agents use the same server features

An Agent is a named actor that runs instructions through a model, a coding provider, or your code. An Invocation is one run of that Agent.

A Capability gives an Agent one selected operation. A KV Capability can let a support Agent read settings while your app still calls KV directly. Add only the operations the Agent needs. Your server decides who can invoke it and which resources it can access.

Follow [your first Agent](/docs/getting-started/first-agent), then read [Capabilities](/docs/agents/capabilities) and [Invocations](/docs/agents/invocations) as you add behavior.

## Choose the next page by your task

Each product has a tutorial, task guides, and an API reference. Deeper topics live with the feature that owns them:

- [Workspaces and Sources](/docs/workspace/concepts) cover writable files and read-only mounts.
- [Invoker identity](/docs/agents/invokers) covers the trusted caller of an Agent run.
- [Runtime policy](/docs/agents/runtime-policy) covers approval decisions and recorded events.
- [Frameworks and hosts](/docs/frameworks-hosts) covers deployment configuration.

Browse [Learn](/learn) to pick a result to build, or use the [documentation catalog](/docs) to find an API.
