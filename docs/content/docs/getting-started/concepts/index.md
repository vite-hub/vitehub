---
title: How ViteHub works
description: Understand the few parts that connect application code, server features, and Agents.
navigation.title: How ViteHub works
navigation.order: 7
icon: i-lucide-map
---

ViteHub connects your server code to the resources provided by your host.
You choose the features in your configuration. Your application calls their
server APIs. The build prepares the routes, bindings, and files that your host
needs.

## Server features belong to your application

A Server Primitive is an API for one server feature, such as KV, Database,
Blob, or Queue. You can use it directly from a route. You do not need an Agent.

For example, a settings route can read a value with `kv.get()`. During local
development, KV can use a local store. On Cloudflare, the same route can use
a Workers KV binding. Your configuration selects the provider, while the
route keeps the same ViteHub import. Provider limits still apply. Each
package documents them under its host and error pages.

Start with [your first Server Primitive](/docs/getting-started/first-server-primitive)
to see this path work in a route.

## Definitions give state and work a name

Some features need a Definition file. A Queue Definition declares the handler
for background jobs. An Agent Definition declares what an Agent can do.
ViteHub discovers these files and gives them names based on their locations.

Your code calls the named feature. It does not import generated provider
files. Read [Definition discovery](/docs/development/definition-discovery)
when you add a new Definition or need to check its name.

## Agents use the same server features

An Agent is a named actor that runs instructions through a model, a coding
provider, or application code. An Invocation is one run of that Agent.

A Capability gives the Agent a selected operation. For example, a KV
Capability can let a support Agent read settings, while your application
continues to call KV directly. Add only the operations the Agent needs.
Your server decides who can invoke it and which resources it can access.

Follow [your first Agent](/docs/getting-started/first-agent), then read
[Capabilities](/docs/agents/capabilities) and
[Invocations](/docs/agents/invocations) as you add behavior.

## Choose the next page by your task

Each product has a tutorial for its first result, guides for specific tasks,
and API reference for options and return values. Keep the detailed topics
with the feature that owns them:

- [Workspaces and Sources](/docs/workspace/concepts) explain writable files and read-only mounts.
- [Invoker identity](/docs/agents/invokers) explains the trusted caller of an Agent run.
- [Runtime policy](/docs/agents/runtime-policy) explains approval decisions and recorded events.
- [Frameworks and hosts](/docs/frameworks-hosts) explains deployment configuration.

Browse [Guides](/guides) to choose a result to build, or use the
[documentation catalog](/docs) to find an API.
