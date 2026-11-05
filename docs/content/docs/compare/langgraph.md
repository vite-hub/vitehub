---
title: ViteHub vs LangGraph JS
description: Compare explicit LangGraph state graphs and checkpoints with ViteHub Agent Definitions, Capabilities, and provider-backed server services.
navigation.title: LangGraph JS
navigation.order: 5
navigation.group: Agent frameworks
icon: i-lucide-git-branch
---

Choose LangGraph JS when explicit state transitions, checkpoints, and
interruptions are the main design problem. Choose ViteHub when Agent
Definitions and server services should fit the Vite application build.

LangGraph is a low-level orchestration library. Its open-source runtime and
LangSmith Deployment are separate choices. You do not need paid hosting to
use the library.

## Compare execution structure

| Decision | LangGraph JS | ViteHub |
| --- | --- | --- |
| Main unit | A state graph with nodes and transitions. | An Agent Definition with a Driver and Capabilities. |
| State recovery | Checkpoints and persistence configured for graph execution. | State and durability depend on the Agent configuration and selected providers. |
| Human interruption | Graph interrupts and resumption. | Approval and runtime policy within the documented Agent lifecycle. |
| Server integration | Embed the library or choose a deployment service. | Discover Definitions and generate host output through Vite. |

For a review process with several explicit decision paths and a human pause,
evaluate LangGraph's graph and checkpoint model first. For an Agent that uses
the same Database, Blob, or Queue APIs as a Vite app, evaluate ViteHub's
Capabilities and shared services.

## Compare recovery requirements

A checkpoint and a queued job are different contracts. Listing both under
"persistence" does not establish the same recovery behavior.

Write down the point where execution must resume after a process restart.
For LangGraph, configure and test the checkpointer. For ViteHub, choose the
required state and Workflow providers, then test restart and retry behavior.
An inline Agent invocation is not automatically a durable graph.

## Evaluate one interrupted task

Use a task that writes a draft, waits for a decision, and applies the approved
result. Check the stored state, resumed input, and duplicate-write behavior.
Use the intended deployment host for the test.

Sources checked on 29 October 2026:
[LangGraph JavaScript overview](https://docs.langchain.com/oss/javascript/langgraph/overview)
and [LangSmith Deployment](https://docs.langchain.com/langsmith/deployments).
Read [ViteHub runtime policy](/docs/agents/runtime-policy)
and [Workflow hosts](/docs/workflows/hosts) for the separate ViteHub contracts.
