---
title: Boxes
description: Understand when application code uses a Box and why it does not attach to an Agent Definition.
navigation: false
---

Boxes prepare isolated or trusted process environments with explicit Home, checkout, environment, requirements, and state. Use `@vite-hub/box` directly when application code owns that process lifecycle.

Boxes do not attach to Agent Definitions. The built-in Codex and Claude Code Agent Drivers run through the local provider runtime with a temporary Workspace, so `defineAgent({ box })` is intentionally unsupported.

Use [`sandbox()`](/docs/capabilities/sandbox) to give a model-backed Agent an allowlisted executable tool, or a custom `driver.run` when application code must compose Box execution with an Agent Invocation.
