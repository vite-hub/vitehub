# Capability Type Contracts for Agent Definition Inputs

ViteHub will let official Capabilities declare a type-only **Capability Type Contract** against Agent Definition inputs they consume, starting with `access()` checking Workspace Source keys and schema-validated chat invocation context. This avoids downstream helper constants and `as any` workarounds while preserving the runtime rule that authority comes from explicit Capability resolvers and Standard Schema validation, not from inferred TypeScript types.

## Considered Options

- Requiring apps to extract shared constants and pass helper types was rejected because the obvious Agent Definition API should keep Workspace Sources and Capabilities inline.
- A broad builder or new prepare callback was deferred because the first proven need is smaller: official Capabilities need to carry type contracts that `defineAgent()` can check.
- Ambient app context keys were rejected as authority; typed invocation metadata must be validated at the Capability boundary before a resolver trusts it.

## Consequences

Capability Type Contracts are compile-time contracts over Agent Definition shape. They can reject mismatched Source keys and expose schema output types to Capability callbacks, but they do not attach Capabilities dynamically, mutate Workspace Definitions, or replace runtime validation.
