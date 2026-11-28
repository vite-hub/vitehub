---
description: "Keep the default Agent Invocation journal in D1 or remote libSQL instead of Cloudflare Worker memory."
seo.title: "VITE_HUB_AGENT_JOURNAL_IN_WORKER_MEMORY in ViteHub"
---

The Cloudflare build did not select a D1 binding or a remote libSQL URL for the default Agent Invocation journal. The journal loses its records when the Worker isolate stops.

[Configure a D1 binding](/docs/frameworks-hosts/cloudflare#configure-the-host) on the `default` or only Database Definition. Turning on `database: true` alone does not configure a D1 binding. With several named Databases, the default journal uses only the `default` Database.

To use libSQL instead, set `agent.invocations.databaseUrl` to a remote libSQL URL. See [Invocation storage](/docs/agents/invocation-storage#use-the-default-journal).
