---
title: ViteHub vs LangGraph JS
description: Compare explicit LangGraph state graphs and checkpoints with ViteHub Agent Definitions, Capabilities, and provider-backed server services.
navigation.title: LangGraph JS
navigation.order: 5
navigation.group: Agent frameworks
icon: i-lucide-git-branch
---

Choose LangGraph JS when explicit state transitions, checkpoints, and
interruptions are the main design problem. Choose ViteHub when Agents and
server services should be part of your Vite build.

LangGraph is a low-level orchestration library. Its open-source runtime and
LangSmith Deployment are separate. The library needs no paid hosting.

## Compare execution structure

| Decision | LangGraph JS | ViteHub |
| --- | --- | --- |
| Main unit | A state graph with nodes and transitions. | An Agent Definition with a Driver and Capabilities. |
| State recovery | Checkpoints and persistence set up for the graph. | Depends on the Agent config and the providers you pick. |
| Human interruption | Graph interrupts and resume. | Approval and runtime policy in the Agent lifecycle. |
| Server integration | Embed the library or use a deploy service. | Vite finds Definitions and builds host output. |

For a review process with several decision paths and a human pause, try
LangGraph's graphs and checkpoints first. For an Agent that uses the same
Database, Blob, or Queue APIs as a Vite app, try ViteHub.

## Compare recovery requirements

A checkpoint and a queued job are different contracts. Calling both
"persistence" does not mean they recover the same way.

Write down where work must resume after a process restart. For LangGraph, set
up and test the checkpointer. For ViteHub, pick the state and Workflow
providers, then test restart and retry. An inline Agent run is not a durable
graph.

## Evaluate one interrupted task

Use a task that writes a draft, waits for a decision, and applies the approved
result. Check the stored state, the resumed input, and duplicate writes. Test
on the host you plan to deploy to.

Sources checked on 29 October 2026:
[LangGraph JavaScript overview](https://docs.langchain.com/oss/javascript/langgraph/overview)
and [LangSmith Deployment](https://docs.langchain.com/langsmith/deployments).
Read [ViteHub runtime policy](/docs/agents/runtime-policy)
and [Workflow hosts](/docs/workflows/hosts).
