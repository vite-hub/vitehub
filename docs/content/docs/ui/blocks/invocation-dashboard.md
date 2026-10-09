---
title: Invocation Dashboard
description: "A three-pane view with the session list, the selected Invocation thread, and its inspector."
navigation.order: 11
navigation.group: Console
icon: i-ph-squares-four-light
---

This block combines [`AgentInvocationList`](/docs/ui/invocation-list), [`AgentInvocation`](/docs/ui/invocation), and [`AgentInvocationInspector`](/docs/ui/invocation-inspector). Select a session in the list. In the inspector, select a tool's call count or a timeline entry to jump to that activity in the thread. The completed run includes a command and its result. The working run shows progress, and the failed run shows its error. All records are synthetic.

::component-preview{name="InvocationDashboardBlock" flush reset}
::

The panes follow the block width through container queries. Below 42rem the list sits above the thread. The inspector appears from 56rem, and the header button hides or shows it.

## Wire the panes

- Map full records to list rows with `agentInvocationTitle()` and `agentInvocationContext()`. The Console uses the same helpers.
- Pass the inspector's `selectActivity` ID to the thread's `selectedActivityId`. Clear it when the selection changes.
- Key the thread by the Invocation ID, so its expanded state resets for each session.

## Load real data

Load Invocation summaries and records from your own authorized routes. The `vite-hub` Console reads the same `AgentInvocationView` shape. Paginate the list with `hasMore`, `loading`, and `endReached`, as shown on the [Invocation list](/docs/ui/invocation-list#pagination) page.

## Components used

- [Invocation list](/docs/ui/invocation-list)
- [Invocation](/docs/ui/invocation)
- [Invocation inspector](/docs/ui/invocation-inspector)
