# Capability CLI Contributions

Superseded note: ADR 0075 retracts generated Capability instruction guidance. Capability CLI Contributions remain current as structured CLI-named tools.

ViteHub will let a Capability Definition declare a Capability-owned real CLI as a flat `cli` object. The Agent Package exposes a controlled CLI-named tool to compatible model-backed Agent Drivers, and lets the Agent Dev Loop run the same command tree with `vitehub agent dev --cli <name> -- <command...>`.

## Considered Options

- Public `cli()`, `group()`, or `command()` builders were rejected because Capability Definitions already use flat object contributions and V1 does not need another authoring DSL.
- A public `capabilityCli({ capability, argv })` runner was rejected because developers should author the Capability CLI contribution, while ViteHub owns the internal execution bridge.
- Reusing `skills()` or `workspaceExec()` directly was rejected for this feature because they already cover mounted skills and controlled process execution; Capability CLI command syntax should be generated from command metadata instead of hand-written skill or instruction options.

## Consequences

Capability CLI Contributions are structured tool contributions for model-backed Agent Drivers. Harness executable/session exposure is deferred until ViteHub has a broader harness design for generated commands, workspace sessions, durability, and authority.

Instruction documents stay policy-oriented. Developers write any free-form CLI-use guidance directly in Agent Driver Instructions and cover the Capability with `::capability`.

Custom Capability authors pass a flat `cli` object. First-party adapters may resolve generated command trees internally from their own metadata, but that resolver is not part of the public `defineCapability({ cli })` contract.
