# Instruction Documents Compose Model Instructions

ViteHub treats an Agent instruction document as Markdown plus ViteHub Instruction Composition. The document is authored for humans and agents, then rendered by the Agent Package into model-facing instructions for model-backed Agent Drivers.

Instruction Composition supports local Markdown imports, safe conditional blocks, explicit `context.*` bindings, Capability instruction slots, and visible Source Instructions. It must not become a general prompt configuration language or an arbitrary JavaScript runtime. Runtime data enters composition only through explicit Agent Invocation Context Values exposed at `context.*`.

Capabilities may contribute model-facing instruction blocks and may write Agent Invocation Context Values that instruction documents read later. Duplicate Capability instruction block ids fail loudly because silent merge or last-write-wins behavior would make composed instructions hard to inspect.

`WorkspaceSource.instructions` remains the low-level Source Instruction field. The Agent Package may render those Source Instructions through Instruction Composition when it builds final model instructions, but Source Instructions still guide Source use only. Markdown never grants access; Access, Workspace Scope, Workspace Rules, and Capability requirements remain the runtime enforcement boundaries.

## Considered Options

- A prompt configuration subsystem was rejected because the durable abstraction is an instruction document, not provider-specific prompt config.
- A broad MDC or MDX runtime was rejected for V1 because ViteHub only needs imports, conditionals, and explicit bindings now.
- Arbitrary JavaScript conditions were rejected because instructions need diagnostics and inspectability without executing author-controlled code during rendering.
- A custom insert directive was rejected because scalar `{{ context.value }}` bindings and trusted Markdown `{{{ context.value }}}` bindings cover the V1 use case.
- Treating Source Instructions as access grants was rejected because access is trusted runtime enforcement, not Markdown policy.

## Consequences

Instruction documents stay readable Markdown. Advanced behavior must earn its place as a small composition rule rather than growing a new template framework.

Capabilities that need reusable composition should write named Agent Invocation Context Values or instruction blocks through `defineCapability`. They should not hide runtime data behind ambient globals or mutate Agent Definition instructions.

Generated Agent Package metadata may include composed instruction text for inspection, but the source of truth remains the authored instruction document plus visible Capability and Source contributions.
