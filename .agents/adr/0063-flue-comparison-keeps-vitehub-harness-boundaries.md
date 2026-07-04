# Flue Comparison Keeps ViteHub Harness Boundaries

Flue's collapsed root config shape was useful comparison material, but ViteHub should not copy root `tools`, `skills`, or `sandbox` fields into Agent Definitions.

ViteHub keeps harness-backed execution in the **Agent Driver** boundary: `defineAgent({ driver: { harness, credentials?, sandbox? }, workspace, capabilities })`. Default harness sandbox setup stays Agent Package runtime plumbing behind the **Agent Harness Driver Contract**; custom harness process or session providers use `driver.sandbox`. The **Agent Package** adapts the harness and owns **Harness Permission Policy**. The **Workspace Package** owns Harness Workspace Session preparation and sync back through Workspace rules. Capabilities remain the place where tools and Skills are enabled, including `.agents/skills/` through `skills()` when a developer opts into that Capability.

The consequence is a slightly more explicit public API than Flue's collapsed shape, but the ownership lines stay inspectable by agents: harness execution is an Agent Driver concern, file state is a Workspace concern, and optional product abilities are Capability concerns.

Deferred: automatic discovery of `.agents/skills/` may be added behind `skills()` if the Capability needs it. It should not become a root Agent Definition field.
