---
title: When to use Sandbox
description: Decide when Sandbox is the right primitive compared with Queue, Workflow, or inline execution.
navigation.title: When to use Sandbox
---

Use Sandbox when the important part is the isolated runtime, not delayed delivery or durable orchestration.

## Choose Sandbox when

Sandbox is usually the right tool when:

- the code should run in an isolated process, container, or managed runtime
- the caller can wait for the isolated result in the same request flow
- filesystem, process, or network controls matter more than retry queues
- you want one named sandbox definition while swapping between Cloudflare and Vercel providers

Examples:

- evaluate generated code in an isolated runtime
- run release-note formatting in a separate execution environment
- inspect repositories or files with sandboxed process access
- execute provider-managed code where Cloudflare and Vercel runtimes should share the same call site

## Sandbox vs Queue

Choose Sandbox when you need isolated execution and a result from that execution.

Choose Queue when you need background delivery and the current request should return immediately.

If the job sounds like "run this code safely somewhere else and give me the result," Sandbox is usually the better fit. If it sounds like "hand this work off and let another system process it later," Queue is the better primitive.

## Sandbox vs Workflow

Choose Sandbox when one isolated run is enough.

Choose Workflow when you need:

- multi-step orchestration
- durable progress between steps
- run lookup later by id
- retries, sleeps, or resumable state across a longer process

Sandbox is about where code runs. Workflow is about how a process progresses over time.

## Sandbox vs inline execution

Choose Sandbox when inline execution would be risky or too coupled to the current server runtime.

Stay inline when:

- the code is already safe to run in the current request
- there is no need for isolation
- introducing a second runtime adds more complexity than value

## When Sandbox is not the right primitive

Sandbox is usually the wrong choice when:

- the caller should not wait for the work at all
- the task needs durable orchestration across several steps
- the work is tiny and safe enough to run inline
- scheduling or retries are the main requirement

## Related pages

- [Quickstart](./quickstart)
- [Runtime API](./runtime-api)
- [Troubleshooting](./troubleshooting)
