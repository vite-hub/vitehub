---
title: DevTools
description: Inspect agents, capabilities, invocations, workspace access, and traces during development.
navigation.order: 30
icon: i-lucide-panels-top-left
---

DevTools are the local inspection surface for ViteHub development. Use them to see what the Agent discovered, which Capabilities applied, and how one invocation moved through the runtime.

## What to inspect

DevTools should make these questions cheap:

- Which Agent Definitions were discovered?
- Which Capabilities attached?
- Which requirements passed or failed?
- Which tools were exposed to the model?
- Which Workspace files were read or written?
- Which approvals happened?
- Which usage and telemetry records were produced?

## Playground behavior

Use a Mock Agent Adapter when the goal is deterministic local behavior without model service cost.

Use a real model service when the behavior being tested depends on model output.

## Debugging capability work

When a Capability is confusing, inspect it in this order:

1. Requirement validation.
2. Instruction contribution.
3. Tool exposure.
4. Policy and approval decisions.
5. Invocation context values.
6. Finish hook output.

That mirrors the Capability Lifecycle and keeps debugging anchored to the public abstraction.
