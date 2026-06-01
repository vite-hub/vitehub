# Narrow Capability Type Contracts for Agent Definition Inputs

ViteHub will let official Capabilities declare narrow type-only **Capability Type Contracts** for Agent Definition inputs they directly consume. `defineAgent()` can use those contracts to check inline configuration, starting with `access()` checking Workspace Source keys and schema-validated chat invocation context. Runtime authority still comes from explicit Capability resolvers and Standard Schema validation inside the Capability Lifecycle, not from inferred TypeScript types.

## Considered Options

- Requiring apps to extract shared constants and pass helper types was rejected because the obvious Agent Definition API should keep Workspace Sources and Capabilities inline.
- A broad builder, new prepare callback, or generic invocation-context schema API was deferred because the first proven need is smaller: official Capabilities need to carry type-only contracts that `defineAgent()` can check.
- Ambient app context keys were rejected as authority; typed invocation metadata must be validated at the Capability boundary before a resolver trusts it.
- Treating Capability Type Contracts as a public custom-Capability extension framework was deferred until user-defined Capabilities prove a stable contract story.

## Consequences

Capability Type Contracts are compile-time contracts over Agent Definition shape. They can reject mismatched Source keys and expose schema output types to Capability callbacks when the Capability directly consumes that input. They do not attach Capabilities dynamically, mutate Workspace Definitions, replace Agent Invocation Context Values for Capability-produced runtime values, or replace runtime validation.
