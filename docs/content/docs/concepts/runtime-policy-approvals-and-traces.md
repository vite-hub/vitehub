---
title: "Runtime policy, approvals, and traces"
description: Understand how ViteHub records runtime decisions and keeps approval behavior inspectable.
navigation.group: Runtime execution
navigation.order: 22
icon: i-lucide-shield-alert
---

Runtime policy decides whether an operation may continue. An Approval Request pauses an operation until a trusted actor responds. A Trace Event records what happened while the runtime prepared, executed, or completed the operation.

These records describe one runtime decision. They do not replace application logs, Agent Memory, or the final Agent output.

## The records answer different questions

| Record | Question |
| --- | --- |
| Policy Decision | Was this operation allowed, denied, or left for approval? |
| Approval Request | Which trusted response is required before work can continue? |
| Trace Event | What runtime action or transition occurred? |
| Lease or wait state | Which work remains active across a wait or background boundary? |

The Runtime Package carries these records through Runtime Context so packages can make decisions without hiding them inside provider-specific code.

## Approvals belong beside the action

Capabilities can request approval for a tool or primitive operation. The invocation stream and runtime events expose the request and its result, so a host can display or handle the decision without parsing model text.

An approval requirement does not make every invocation interactive. If the host cannot satisfy the required approval boundary, the operation must remain pending or fail according to the package contract.

## Inspect the decision

Inspect the invocation id, policy decision, approval request, trace event, and final result together. The sequence tells you whether a tool was rejected, waited, executed, or failed after execution began.

Read [Runtime events](/docs/reference/runtime-events) for event fields and [Capabilities](/docs/concepts/capabilities-api) for the model-facing contribution that can trigger policy.
