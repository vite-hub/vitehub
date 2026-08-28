---
title: ViteHub documentation
description: Build server features and Agents in a Vite application, then inspect and deploy them on a supported host.
navigation: false
icon: i-lucide-book-open
---

ViteHub adds server features to Vite applications. Trusted application code calls
**Server Primitives** directly. **Agents** combine a Driver with selected
Capabilities, a Workspace, and application entry points.

You can use either lane on its own. An application can also use both without
giving an Agent access to every server feature.

::u-page-grid{class="not-prose mt-8"}
  :::u-page-card
  ---
  title: Build with server primitives
  description: Add auth, data, background work, execution, and delivery APIs.
  icon: i-lucide-server-cog
  to: /docs/server-primitives
  ---
  :::
  :::u-page-card
  ---
  title: Build an Agent
  description: Define how an Agent runs, what it can use, and how callers reach it.
  icon: i-lucide-bot
  to: /docs/agents
  ---
  :::
  :::u-page-card
  ---
  title: Run a local example
  description: Install ViteHub and finish one credential-free Server Primitive or Agent path.
  icon: i-lucide-rocket
  to: /docs/getting-started
  ---
  :::
  :::u-page-card
  ---
  title: Read the guide
  description: Learn how definitions, runtime imports, Workspaces, Capabilities, and host output fit together.
  icon: i-lucide-map
  to: /docs/concepts
  ---
  :::
::

## Choose a lane

| Start with | When it is the right lane |
| --- | --- |
| [Server Primitives](/docs/server-primitives) | Trusted server code needs Env, Auth, storage, queues, workflows, schedules, browser sessions, sandboxes, or another server API. |
| [Agents](/docs/agents) | A named server program needs a model, coding provider, or custom Driver plus controlled access to tools and files. |

The lane switcher at the top of the sidebar keeps those two paths separate. The
Guide, development, host guides, reference, and AI-readable pages appear in both lanes
when the same contract applies to both.

## Build a ViteHub application

1. [Install ViteHub](/docs/getting-started/installation) in a Vite or Nuxt
   project that uses Node.js 24.15 or newer.
2. Register `vitehub()` or the Nuxt module, then select the runtime preset and
   only the package integrations the application uses.
3. Add a Definition when a feature needs discovery, a stable name, a schema, or
   provider output. Features such as KV can also work from configuration alone.
4. Call the documented Runtime Helper from trusted server code.
5. If an Agent needs the operation, attach the matching
   [Capability](/docs/capabilities) with the narrowest useful scope and policy.
6. Inspect the result locally, run the relevant proof, and build for the selected
   host.

The two first-result guides run without an account or provider credential:

- [First Server Primitive](/docs/getting-started/first-server-primitive) stores
  and reads a KV value.
- [First Agent](/docs/getting-started/first-agent) runs a deterministic Agent
  Invocation through a custom Driver.

## Find the API by job

| You need to | Open |
| --- | --- |
| Add environment values, auth, data, background work, or isolated execution | [Server Primitives](/docs/server-primitives) |
| Choose an Agent Driver, instructions, Workspace, trigger, or Channel | [Agents](/docs/agents) |
| Give an Agent selected tools, context, input handling, or output behavior | [Capabilities](/docs/capabilities) |
| Build chat, Agent inspection, diff, trace, or file-tree interfaces | [UI](/docs/ui) |
| Understand Definitions, Runtime Context, imports, policy, and Provider Output | [Guide](/docs/concepts) |
| Use the CLI, Console, generated files, provisioning, or verification tools | [Development](/docs/development) |
| Configure Cloudflare, Vercel, Netlify, Deno, Nitro, or self-hosted Node | [Frameworks and hosts](/docs/frameworks-hosts) |
| Look up packages, imports, configuration, runtime events, or diagnostics | [Reference](/docs/reference) |

## Inspect what ViteHub built

The [ViteHub Console](/docs/development/console) presents application
configuration and runtime records without turning into a provider dashboard. It
can inspect Agent sessions and usage, configured KV and Blob data, and discovered
Workflow, Queue, Schedule, Database, Rate Limit, Workspace, and Sandbox
Definitions.

Definition catalogs are read-only and come from build-time discovery. They do not
start a Sandbox, synchronize a Workspace, connect to a database, or invent live
queue and schedule state. Data views use the package's explicit read contract and
can still make provider requests.

Use the [CLI](/docs/development/cli) for scriptable inspection, Agent Evals, and
provisioning. Use [generated files](/docs/development/generated-files) to debug
build output, not as application imports.

## Keep the boundaries visible

| Boundary | What it means in application code |
| --- | --- |
| Server Primitive and Capability | A server API does not become an Agent tool until the Agent Definition includes a Capability. |
| Definition and runtime state | Discovery proves what the build found. Runtime helpers and provider APIs report live state. |
| Workspace and Source | A Workspace is writable file-tree state. A Source retrieves read-only content that can be mounted into it. |
| ViteHub API and provider output | Application code uses ViteHub imports. Package integrations generate the host files and bindings they support. |
| Portable contract and host support | A shared API does not imply that every provider supports every operation or lifecycle. |

Check the [runtime and host support matrix](/docs/frameworks-hosts/support-matrix)
before choosing a deployment target. Each feature page states durability,
isolation, cost, security, and production limits beside the option they affect.

## Give these docs to a coding agent

The [AI-readable documentation](/docs/ai-resources) publishes a ViteHub skill,
`llms.txt`, raw Markdown pages, OpenAPI, and an MCP endpoint. Start with the skill
or one raw page. Use the full documentation export only for broad audits.
