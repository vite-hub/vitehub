---
name: vitehub
description: Build and debug ViteHub apps from the live docs and installed contract. Use for server primitives and Runtime Helpers; Agent Definitions, Drivers, Capabilities, Workspaces, and Sources; or Vite Integrations, Provider Output, and host deployment.
---

# ViteHub

Use one proof loop: orient, choose one lane, inspect the installed contract, act, recover, and prove.

## 1. Orient

- Inspect the package manifest, lockfile, Vite config, and server entry before proposing code.
- Identify the installed ViteHub packages and versions, framework, host target, and requested outcome.
- Open `https://vitehub.dev/llms.txt`, then read the single smallest raw Markdown page that covers the task. Add a second page only when the first one explicitly requires it.

Orientation is complete when you can state the current setup, target outcome, and chosen docs URL.

## 2. Choose One Lane

- **Server primitives** serve direct application and server behavior through Vite Integrations, Definitions when discovery is needed, and Runtime Helpers.
- **Agents** serve model-backed, harness-backed, or custom-run-backed behavior through Agent Definitions. Agents may compose server primitives; server primitives remain useful without an Agent.

Choose one primary lane. Treat framework and host work as a boundary around that lane, not as a third product model.

Lane selection is complete when every requested behavior belongs to the chosen lane and any host boundary is named.

## 3. Inspect The Installed Contract

- Read each installed package's `package.json`, exports, and relevant types before writing imports or options.
- For a fresh application, follow the installation page, install `vite-hub`, then inspect its root and feature-subpath exports. Use direct owner packages only for a focused library or advanced composition.
- When live docs, installed types, and exports disagree, implement the installed contract and report the mismatch with both versions or sources. Do not invent a missing API.

Contract inspection is complete when every planned import, option, and runtime entry exists in the installed version.

## 4. Act

### Server primitive lane

1. Install `vite-hub` for an application, or the primitive owner package for a focused library integration.
2. Register `vitehub()` in the existing Vite config. Use an owner package's `hubX()` integration only when direct package control is intentional.
3. Add a named Definition only when the primitive relies on discovery.
4. Call the primitive from application or server code through its Runtime Helper.
5. Keep primitive authority in application code unless the task explicitly grants it to an Agent through a Capability.

### Agent lane

1. Add one Agent Definition and select one model-backed, harness-backed, or custom Agent Driver.
2. Satisfy the selected driver's credentials, executable, or callback prerequisites.
3. Attach only the Workspace, Sources, and Capabilities required by the task.
4. Put model-facing guidance for configured Sources, Capabilities, and Skills in Agent Driver Instructions or deterministic imported instruction Markdown.
5. Invoke the Agent through the documented Runtime Helper and keep granted authority visible in the Definition and inspection output.

### Host boundary

When the task includes deployment, read the target host page, build for that target, and inspect generated Provider Output. State unsupported or partially supported behavior as an explicit limitation.

Acting is complete when the smallest coherent implementation exists in the chosen lane.

## 5. Recover

- For missing imports or type errors, return to installed exports and types.
- For discovery or runtime failures, inspect generated `.vitehub` state and the diagnostics page selected from `llms.txt`.
- For docs drift, keep the installed contract in code and report the exact disagreement.
- For unavailable host behavior, preserve the supported ViteHub boundary and state what remains host-owned.

Recovery is complete when the failure has a source-backed cause, a verified correction, or a precise unsupported boundary.

## 6. Prove

- **Server primitive:** its Vite Integration is registered, its Runtime Helper executes, and the observed output matches the expected output.
- **Agent:** its Agent Invocation returns or streams the expected result, the Agent Driver prerequisites are satisfied, and granted authority is inspectable.
- **Host boundary:** the build emits the documented Provider Output and every target limitation is explicit.

Run the narrow package test or typecheck nearest the change, then the relevant application build or invocation proof. Report the commands and observed result, the raw docs URL, installed ViteHub versions, and any contract mismatch or host limitation.
