---
title: Runtime policy, approvals, and traces
navigation.title: Policy and approvals
description: Choose when an Agent tool can run and inspect the decision afterward.
navigation.order: 23
navigation.group: Core
icon: i-lucide-shield-alert
---

Attaching a Capability gives an Agent an operation it can call. Check its
scope and requirements first, then choose whether that operation can run
without approval. A policy decision and a trace event answer different
questions. The decision says whether work may run. The event records what
happened.

## Choose a tool policy

Model-facing tool policy defaults to `allow`. Set `policy: 'deny'` to reject
an operation or `policy: 'require-approval'` when a trusted caller must approve
it before execution. Read [Capabilities](/docs/agents/capabilities) for how
the policy combines with modes, path scopes, and input validation.

A policy does not replace those restrictions. An approved tool call must
still meet its Capability's requirements. Use the narrowest scope needed
for the task, such as read access to a documentation directory.

## Know who owns the approval

Runtime approval interfaces describe requests and decisions. They do not
provide a durable approval queue or authenticate an approver. If you build
an entry point yourself, your application must authenticate the actor,
associate the response with the pending call, prevent replay, and resume or
reject the operation.

The built-in HTTP Chat route has a specific approval path. It stores pending
approvals in its configured Chat state, reconstructs the tool call on the
server, and consumes each response once under a session lock. Client chat
history and arbitrary Invocation context cannot grant approval. Read
[Chat capability](/docs/agents/capabilities/chat) and the
[Capability approval contract](/docs/agents/capabilities#use-an-eve-extension)
before exposing approval controls in your app.

## Inspect what happened

Use the Invocation ID to connect a decision, pending approval, tool call,
and final result. The [Console](/docs/development/console) can display this
information. [Invocation APIs](/docs/agents/invocations) and
[runtime events](/docs/reference/runtime-events) provide inspection from code.

An in-memory trace does not survive a restart. Use an Invocation journal or
an [OTLP receiver](/docs/agents/capabilities/otlp) when you need stored evidence.
Trace content is metadata-only by default. Opt in to content storage only
when the app needs it, and configure access, redaction, and retention for
that stored data.
