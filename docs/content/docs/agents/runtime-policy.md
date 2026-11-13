---
title: Runtime policy, approvals, and traces
navigation.title: Runtime policy, approvals, and traces
description: Choose when an Agent tool can run, who approves it, and how to see what happened.
navigation.order: 72
navigation.group: Advanced
icon: i-lucide-shield-alert
navigation.kind: Concepts
---

A Capability gives an Agent an operation it can call. Check its scope and
requirements, then choose if the operation can run without approval. A policy
decision says if work may run. A trace event records what happened.

## Choose a tool policy

Tool policy defaults to `allow`. Set `policy: 'deny'` to reject an operation.
Set `policy: 'require-approval'` when a trusted caller must approve it first.
Read [Capabilities](/docs/agents/capabilities) to see how policy works with
modes, path scopes, and input validation.

A policy does not replace those limits. An approved tool call must still meet
its Capability's requirements. Give the smallest scope the task needs, such
as read access to a docs directory.

## Know who owns the approval

Runtime approval interfaces describe requests and decisions. They do not give
a durable approval queue, and they do not authenticate the approver. If you
build your own entry point, your app must:

- authenticate the actor
- link the response to the pending call
- prevent replay
- resume or reject the operation

The built-in HTTP Chat route does this for you. It stores pending approvals in
its Chat state, rebuilds the tool call on the server, and uses each response
once under a session lock. Client chat history and Invocation context cannot
grant approval. Read [Chat capability](/docs/agents/capabilities/chat) before
you show approval controls in your app.

## Inspect what happened

The Invocation ID links a decision, pending approval, tool call, and final
result. The [Console](/docs/development/console) shows them.
[Invocation APIs](/docs/agents/invocations) and
[runtime events](/docs/reference/runtime-events) show them from code.

> [!WARNING]
> An in-memory trace is lost on restart. Use an Invocation journal or an
> [OTLP receiver](/docs/agents/capabilities/otlp) to keep evidence. Traces
> store metadata only by default. Store content only when the app needs it,
> and set access, redaction, and retention for it.
