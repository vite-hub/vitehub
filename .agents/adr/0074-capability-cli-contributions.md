# Capability CLI Contributions

ViteHub will let a Capability Definition declare a Capability-owned real CLI as a flat `cli` object. The Agent Package renders command metadata into generated Capability instruction guidance, exposes a controlled CLI-named tool to compatible model-backed Agent Drivers, and lets the Agent Dev Loop run the same command tree with `vitehub agent dev --cli <name> -- <command...>`.

## Considered Options

- Public `cli()`, `group()`, or `command()` builders were rejected because Capability Definitions already use flat object contributions and V1 does not need another authoring DSL.
- A public `capabilityCli({ capability, argv })` runner was rejected because developers should author the Capability CLI contribution, while ViteHub owns the internal execution bridge.
- Reusing `skills()` or `workspaceExec()` directly was rejected for this feature because they already cover mounted skills and controlled process execution; Capability CLI command syntax should be generated from command metadata instead of hand-written skill or instruction options.

## Consequences

Capability CLI Contributions are model-facing Capability Driver Contributions for model-backed Agent Drivers. Harness executable/session exposure is deferred until ViteHub has a broader harness design for generated commands, workspace sessions, durability, and authority.

Instruction documents stay policy-oriented. Developers include the relevant Capability instruction slot, such as `{{ capabilities.inventory-runtime }}` or the catch-all `{{ capabilities }}`, and command examples come from generated Capability CLI guidance.
