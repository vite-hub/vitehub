---
title: Runtime policy, approvals, and traces
description: Understand the records that explain whether runtime work ran, waited, or failed.
navigation.group: Runtime execution
navigation.order: 22
icon: i-lucide-shield-alert
---

Runtime policy decides whether an operation can continue. An Approval Request pauses it until a trusted actor responds. A Trace Event records what happened while the runtime prepared, ran, or completed the operation.

These records explain one runtime decision. They do not replace application logs, Agent Memory, or the final Agent output.

## Each record answers a different question

| Record | Question |
| --- | --- |
| Policy Decision | Was the operation allowed, denied, or sent for approval? |
| Approval Request | Which trusted response is needed before work continues? |
| Trace Event | Which runtime action or transition occurred? |
| Lease or wait state | Which work remains active while execution waits or continues in the background? |

Runtime Context carries these records so packages can make decisions without hiding them in provider-specific code.

## Put approval beside the action

A Capability can request approval for a tool or primitive operation. The invocation stream and runtime events expose the request and its result, so a host can display or handle the decision without parsing model text.

If the host cannot satisfy an approval requirement, the operation stays pending or fails according to the package contract.

## Inspect the decision

Inspect the invocation id, policy decision, approval request, trace event, and final result together. This shows whether work was rejected, waited, executed, or failed after execution began.

Read [Runtime events](/docs/reference/runtime-events) for event fields and [Capabilities](/docs/concepts/capabilities-api) for the model-facing contribution that can trigger policy.
