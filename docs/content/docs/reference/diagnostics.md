---
title: Diagnostics
description: Find ViteHub diagnostic codes, repair guidance, and verification steps.
navigation.order: 1
navigation.group: Diagnostics
icon: i-lucide-circle-alert
---

ViteHub diagnostics identify configuration, build, and runtime defects with stable codes. When an error includes a documentation link, it points to this reference so you can find the owning package and the next proof step.

## Agent diagnostics

Agent errors use `AGENT_C####`, `AGENT_B####`, and `AGENT_R####` codes. Agent routes and hooks expose a sanitized public error that is safe to serialize. Keep the original error in protected server diagnostics because provider payloads and causes can contain credentials or private response data.

Use the complete diagnostic code when classifying an error. The error's `fix` text gives the immediate repair action, while the source and provider details identify what to verify.

## Other package diagnostics

Each ViteHub package owns its diagnostic catalog. The package prefix identifies the owner, and the family letter identifies configuration, build, or general runtime defects. See [Errors and diagnostics](/docs/reference/errors-diagnostics) for the shared error contract, serialization rules, and operational error behavior.

## Verify a diagnostic

1. Read the complete `code` and `fix` fields.
2. Inspect the provider output, source locations, or trace events named by the diagnostic.
3. Re-run the nearest package or consumer test after applying the repair.
