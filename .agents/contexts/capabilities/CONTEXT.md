# Capabilities

Capabilities are user-shareable abilities that ViteHub agents can attach.

## Language

**Capability**:
A shareable ViteHub bundle that adds a named agent ability.
_Avoid_: Plugin, integration, extension

**Official Capability**:
A Capability shipped by ViteHub.
_Avoid_: Built-in plugin, core feature

**Capability Factory**:
A function that returns a Capability.
_Avoid_: Config mutator, setup callback

**Capability Definition**:
The public object shape used by official and user-defined Capabilities.
_Avoid_: Internal plugin shape

**Capability Phase**:
A named lifecycle point where ViteHub collects and applies Capability contributions.
_Avoid_: Random hook, raw setup

**Capability Context**:
The typed mutable object passed to a Capability Phase.
_Avoid_: Return payload, raw config

**Instruction Block**:
A named system-instruction fragment contributed by a Capability.
_Avoid_: Prompt snippet, system prompt

**Instruction Slot**:
A placeholder in an Agent's instructions that controls where Instruction Blocks are inserted.
_Avoid_: Template variable, macro

**Storage Capability**:
A Capability that lets an Agent access a configured storage primitive.
_Avoid_: Agent storage tool, package-owned runtime helper

**Skills**:
An Official Capability that lets an Agent consume Skill files from its workspace.
_Avoid_: Skill plugin, skill system

**MCP**:
A Capability that lets an Agent use tools from configured Model Context Protocol servers.
_Avoid_: MCP client plugin, MCP tools

**Bash**:
A Capability that exposes controlled shell-style workspace operations to an Agent.
_Avoid_: Root shell, raw terminal

**Capability Requirement**:
A primitive, workspace mode, or workspace path that a Capability needs before it can be applied to an Agent.
_Avoid_: Capability dependency, plugin dependency

**Requirement Validation**:
The earliest practical check that an Agent satisfies its Capability Requirements.
_Avoid_: Runtime surprise, lazy capability check

## Relationships

- An **Official Capability** is a **Capability**.
- A **Capability Factory** creates one **Capability**.
- Official and user-defined Capabilities share the same **Capability Definition** shape.
- A **Capability** can run one or more **Capability Phases**.
- A **Capability Phase** receives a **Capability Context**.
- A **Capability** can contribute one or more **Instruction Blocks**.
- An Agent can place Instruction Blocks with **Instruction Slots**.
- A **Storage Capability** is an **Official Capability**.
- **Skills** is an **Official Capability**.
- **MCP** is an **Official Capability**.
- **Bash** is a Capability.
- A **Capability** can declare **Capability Requirements**.
- **Requirement Validation** should run as early as possible.

## Example Dialogue

> **Dev:** "Should DB access be a raw tool on the agent?"
> **Domain expert:** "No. If model-facing database access is public, expose it as a **Storage Capability** with **Capability Requirements** and policy."

## Flagged Ambiguities

- "plugin" was used to mean both framework plugins and user-shareable ViteHub abilities - resolved: use **Capability** for the agent ability concept.
- Tool-first surfaces were considered the primary model - resolved: use **Capability** for the product concept and tools only as one possible contribution.
- Storage package runtime helpers were considered equivalent to model-facing abilities - resolved: use **Storage Capability** only when a primitive is exposed to an Agent.
