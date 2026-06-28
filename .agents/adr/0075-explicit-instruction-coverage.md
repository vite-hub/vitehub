# Explicit Instruction Coverage Replaces Ambient Primitive Prose

ViteHub will no longer treat Source, Capability, or Skill configuration as ambient system-instruction contribution. Sources, Capabilities, and Skills stay as runtime primitives, and structured tool descriptions and schemas stay as tool contracts, but free-form model-facing guidance belongs in Agent Driver Instructions or deterministic imported instruction Markdown with explicit bindings.

This revises the default prompt-composition direction from ADR 0072: Instruction Composition may still render bound Source, Capability, and Skill guidance, but configured primitives without explicit coverage should produce DevTools, build, or metadata diagnostics instead of silently appending prose. The trade-off is less automatic demo convenience in exchange for one authored owner of model behavior and warnings that make missing coverage obvious.
