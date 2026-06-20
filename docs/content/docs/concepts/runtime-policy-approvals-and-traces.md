---
title: Runtime policy, approvals, and traces
description: Understand the Runtime Package concepts that make agent and primitive behavior inspectable.
navigation.order: 11
icon: i-lucide-shield-alert
---

Runtime policy, approvals, and traces belong to the shared Runtime Package language. A Policy Decision can allow, deny, request approval, or retry a runtime operation. An Approval Request asks a human or external authority before the operation continues. A Trace Event records structured runtime behavior across package boundaries.

## Why it exists

Agents can call tools, inspect Workspaces, request storage writes, execute sandbox commands, or use provider-backed drivers. Those actions need explicit runtime decisions, not hidden provider behavior or unstructured log lines.

ViteHub treats policy and tracing as inspectable runtime behavior. The model should not receive secret policy internals, but developers and agents inspecting a run should see the decisions that changed execution.

## Where policy appears

| Surface | Current behavior |
| --- | --- |
| Storage Capabilities | Write tools require approval by default unless the developer opts into autonomous storage writes. |
| Workspace | Workspace Rules enforce path-scoped write policy before writes reach the store. |
| Workspace Scope | Access can narrow visible files for one Agent Invocation without exposing hidden paths to the model. |
| Harness-backed Agent Drivers | V1 bypasses adapter-level approval prompts when supported and relies on ViteHub-owned Workspace and runtime boundaries. |
| Runtime Package | Runtime Capabilities, Policy Decisions, Approval Requests, Trace Events, and Leases stay package-to-package concepts. |

## Approvals in messages and streams

Agent messages and stream events can carry approval requests and approval decisions. Those parts make approval-gated behavior visible without turning approvals into ordinary text.

```txt [Stream events]
approval-request
approval-decision
tool-call
tool-result
usage
finish
```

Use these events as run evidence. They are more useful than a generic "tool failed" message because they show whether policy, approval, execution, or provider behavior changed the run.

## Traces are not console logs

A Trace Event is structured runtime observability. It can describe policy, approval, capability, lifecycle, error, or run activity. Console logs can still help during local development, but traces are the cross-package surface ViteHub can inspect consistently.

## Next steps

- Read [Agent Invocations](/docs/agents/invocations) for run lifecycle.
- Read [Capabilities API](/docs/concepts/capabilities-api) for model-facing ability boundaries.
- Read [Workspace and Sources](/docs/concepts/workspace-and-sources) for Workspace Rules and Scope.
