# V1 Harness Permissions Bypass Adapter Approvals

V1 harness-backed Agent Drivers use one active permission layer: ViteHub-owned Workspace and runtime boundaries. The **Harness Permission Policy** for V1 bypasses adapter-level approval prompts by configuring each supported harness adapter to its most permissive no-approval mode. For the current AI SDK Codex adapter, ViteHub should set `permissionMode: "allow-all"` behind the ViteHub harness adapter boundary.

This does not mean "no policy." The policy lives in ViteHub's selected Workspace Scope, Harness Workspace Session, workspace write rules, sandbox/session setup, credentials, usage telemetry, and deployment diagnostics. It means V1 should not combine those boundaries with a second interactive provider approval layer. If a harness adapter cannot bypass its own approval layer, it should be rejected or marked unsupported for V1 rather than creating two active permission systems.

V1 does not expose a public `permissions` option. Bypass is implicit for every supported harness-backed Agent Driver because it is the only supported Harness Permission Policy.

## Considered Options

- Passing through adapter-level approval prompts was rejected for V1 because it creates two overlapping policy layers and makes behavior hard to reason about.
- Exposing public `permissions: "bypass"` was rejected for V1 because a single-value option would imply an extensible policy matrix before one exists.
- Designing a full approval and permission matrix was deferred because V1 is primarily for the project's own use and the branch count is too high before the harness boundary is proven.
- Letting each harness adapter own policy independently was rejected because ViteHub would lose inspectability over workspace writes, shell behavior, network access, and usage-risk diagnostics.
- Removing all policy language was rejected because bypassing approvals still needs explicit ViteHub-owned Workspace and runtime boundaries.

## Consequences

V1 should make harness behavior fast and predictable for local Quiver and ViteHub use. Harness adapters are configured to avoid approval prompts, while ViteHub owns the coarse boundary that determines what the harness can see and where it can run. Future versions can add approval policies, per-tool prompting, or host-executed approval flows, but that should be a separate design rather than an accidental second layer in V1.

Adding another permission mode later should introduce the public option only when more than one supported policy exists.
