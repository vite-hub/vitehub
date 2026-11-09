---
title: ViteHub vs VoltAgent
description: Compare ViteHub and VoltAgent for TypeScript Agent configuration, tools, workflows, server services, and inspection.
navigation.title: VoltAgent
navigation.order: 3
navigation.group: Agent frameworks
icon: i-lucide-bot
---

Choose VoltAgent when its Agent runtime, supervisor and subagent APIs, and
VoltOps tools fit your app. Choose ViteHub when your Vite build should find
Agents and set up the server services around them.

Both have tools, memory, workflows, inspection, and server deploys. Neither
open-source runtime needs a hosted dashboard.

## Compare the units you configure

VoltAgent documents Agents, supervisor orchestration, tools, memory, retrieval,
guardrails, workflows, and evals. VoltOps adds operations tools, in the cloud
or self-hosted.

ViteHub finds Agent files and adds behavior with
[Capabilities](/docs/agents/capabilities). Workspaces and Sources set file
access. Separate server services give storage, queues, schedules, email, and
more to Agents and trusted app code.

A team assistant with several specialist Agents can fit VoltAgent's supervisor
model. A Vite app that needs an Agent plus Blob, KV, and scheduled work can
try ViteHub's shared config and server imports.

## Check the target host

VoltAgent documents Node and serverless deploys, including Cloudflare. Check
its host guide for runtime and console limits. Do not assume every Node integration
runs unchanged in a Worker.

ViteHub also has host limits. Check the
[support matrix](/docs/frameworks-hosts/support-matrix) and each service's
Hosts page. The Codex and Claude Code Drivers need their documented
Node process environment.

## Compare operation with a failed run

Build the same tool task in both. Check how you set access, store history,
inspect a tool error, and retry. Count the storage and deploy setup too.

Do not assume memory, conversations, or workflow runs move between the two
without a migration.

Sources checked on 29 October 2026:
[VoltAgent repository and feature overview](https://github.com/VoltAgent/voltagent),
[deployment overview](https://github.com/VoltAgent/voltagent/blob/main/website/docs/deployment.md),
and [Cloudflare deployment guide](https://github.com/VoltAgent/voltagent/blob/main/website/deployment-docs/cloudflare-workers.md).
Start with [First Agent](/docs/getting-started/first-agent) to test ViteHub.
