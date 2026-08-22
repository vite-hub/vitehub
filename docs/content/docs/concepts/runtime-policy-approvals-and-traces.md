---
title: Runtime policy, approvals, and traces
description: Understand the records that explain whether runtime work ran, waited, or failed.
navigation.order: 22
icon: i-lucide-shield-alert
---

Runtime policy decides whether an operation can run. An Approval Request pauses it until a trusted actor responds. A Trace Event records what happened before, during, and after the operation.

Use these records to explain a runtime decision. They don't replace application logs, Agent Memory, or the final Agent output.

## Each record answers a different question

| Record | Question |
| --- | --- |
| Policy Decision | Was the operation allowed, denied, or sent for approval? |
| Approval Request | Which trusted response is needed before work continues? |
| Trace Event | Which runtime action or transition occurred? |
| Lease or wait state | Which work remains active while execution waits or continues in the background? |

Runtime Context passes these records between packages and the host.

## Put approval beside the action

A Capability can request approval for a tool or Server Primitive operation. The Invocation stream and runtime events include the request and result, so the host does not need to parse model text.

If the host cannot satisfy an approval requirement, the operation stays pending or fails according to the package contract.

## Inspect the decision

Inspect the invocation id, policy decision, approval request, trace event, and final result together. This shows whether work was rejected, waited, executed, or failed after execution began.

Read [Runtime events](/docs/reference/runtime-events) for event fields and [Capabilities](/docs/concepts/capabilities-api) for the model-facing contribution that can trigger policy.
