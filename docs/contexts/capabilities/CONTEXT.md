# Capabilities

Capabilities are the user-shareable abilities that ViteHub applications can add.

## Language

**Capability**:
A shareable ViteHub bundle that adds a named product ability to an application.
_Avoid_: Plugin, integration, extension

**Official Capability**:
A Capability shipped by ViteHub.
_Avoid_: Built-in plugin, core feature

**Voice Input**:
An Official Capability that lets users send spoken input to an agent.
_Avoid_: Audio support, voice plugin

**Skills**:
An Official Capability that lets an agent consume Skill files from its workspace.
_Avoid_: Skill plugin, skill system

**Image Generation**:
A Capability that lets an agent create images for the user.
_Avoid_: Image tool, image plugin

**MCP**:
A Capability that lets an agent use tools from configured Model Context Protocol servers.
_Avoid_: MCP client plugin, MCP tools

**Chat**:
An Official Capability that lets external conversation events invoke an agent.
_Avoid_: Chat definition, chat plugin, bot definition

**MCP Server**:
A named Model Context Protocol server configured inside the MCP Capability.
_Avoid_: MCP instance, MCP capability

**Skills Path**:
The workspace-relative directory used by the Skills Capability.
_Avoid_: Skills storage, skills workspace

**V1 Capability Set**:
The first Official Capabilities used to prove the Capability API.
_Avoid_: Core plugins, built-ins

**Capability Factory**:
A function that returns a declarative Capability object.
_Avoid_: Config mutator, setup callback

**Capability Definition**:
The public object shape used by Official and user-defined Capabilities.
_Avoid_: Internal plugin shape

**defineCapability**:
The helper used to create a Capability Definition.
_Avoid_: Private capability API

**Capability Surface**:
A named part of ViteHub that a Capability can extend.
_Avoid_: Hook

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

**Capability Hook**:
A typed extension point called around a Capability Phase.
_Avoid_: Capability Surface, tool

**Agent Capability Hook**:
A Capability Hook registered directly on an Agent definition.
_Avoid_: Global hook, app hook

**Capability Artifact**:
A file or structured output produced by a Capability.
_Avoid_: Storage object, tool output

**Artifact Path**:
A workspace-relative location where a Capability writes its artifacts.
_Avoid_: Storage config, bucket path

**Default Artifact Path**:
The workspace-relative Artifact Path used by an Official Capability when the user does not provide one.
_Avoid_: Storage default, generated folder

**Agent-Scoped Capability**:
A Capability attached to one Agent definition.
_Avoid_: Global capability, module capability

**Single-Instance Capability**:
A Capability that can appear at most once in one Agent definition.
_Avoid_: Capability instance, duplicate capability

## Relationships

- A **Capability** can be added to an application.
- An **Official Capability** is a **Capability**.
- **Voice Input** is the first planned **Official Capability**.
- **Skills** is an **Official Capability**.
- **MCP** is an **Official Capability**.
- **Chat** is an **Official Capability**.
- **MCP** can configure one or more **MCP Servers**.
- **Skills** reads Skill files from a **Skills Path**.
- The **V1 Capability Set** contains **Skills**, **Voice Input**, and **MCP**.
- **Image Generation** can produce **Capability Artifacts** at an **Artifact Path**.
- An **Official Capability** that produces files should provide a **Default Artifact Path**.
- A **Capability Factory** creates one **Capability**.
- **defineCapability** creates a **Capability Definition**.
- Official and user-defined Capabilities share the same **Capability Definition** shape.
- A **Capability** can extend one or more **Capability Surfaces**.
- A **Capability Phase** applies Capability contributions.
- A **Capability Phase** receives a **Capability Context**.
- A **Capability** can contribute one or more **Instruction Blocks**.
- An Agent can place **Instruction Blocks** with **Instruction Slots**.
- A **Capability Hook** lets Capabilities observe or extend a **Capability Phase**.
- An **Agent Capability Hook** is scoped to one Agent definition.
- A **Capability** is an **Agent-Scoped Capability**.
- A **Capability** is a **Single-Instance Capability** by default.

## Example Dialogue

> **Dev:** "Should image generation configure storage?"
> **Domain expert:** "No. Storage belongs to the agent's workspace. **Image Generation** only needs an **Artifact Path** inside that workspace."

## Flagged Ambiguities

- "plugin" was used to mean both framework plugins and user-shareable ViteHub feature bundles - resolved: use **Capability** for the ViteHub domain concept.
- "audio input" and "voice input" both appeared as names for spoken user messages - resolved: use **Voice Input** for the capability.
- "capability" was considered as a raw function that mutates configuration - resolved: use a **Capability Factory** that returns a declarative Capability object.
- "workspace tools" and "agent tools" were considered as primary Capability Surfaces - unresolved: this may expose the wrong abstraction for capabilities that produce artifacts.
- "artifact storage" was considered as Capability configuration - resolved: storage is configured by the agent's workspace; a Capability only declares workspace-relative **Artifact Paths**.
- File-producing Official Capabilities may require artifact placement - resolved: provide a **Default Artifact Path** with an override.
- Capabilities were considered at the module/build level - resolved: capabilities attach to `defineAgent`, not `hubAgent`.
- Custom Capabilities were considered as future-only - resolved: expose **defineCapability** now because the library is already experimental.
- Individual Skill files were considered as Capabilities - resolved: **Skills** is a Capability; individual skill files are workspace content consumed by that Capability.
- **Image Generation** was considered for v1 - resolved: defer it, but keep it as a future artifact-producing Capability example.
- Hooks were considered as the primary Capability model - resolved: use **Capability Phases** as the primary model and **Capability Hooks** around those phases for extension.
- Capability Hooks were considered capability-only - resolved: Capabilities and Agent definitions can both register **Capability Hooks**.
- Multiple instances of the same Capability were considered - resolved: Capabilities are single-instance by default; use nested configuration for multiple providers or servers.
- Multiple MCP Capability instances were considered - resolved: use one **MCP** Capability with multiple **MCP Servers**.
- The default Skills location was unresolved - resolved: the default **Skills Path** is `skills`.
- Capability Phases were considered as functions returning raw contribution objects - resolved: phases mutate a typed **Capability Context**.
- Capability instructions needed placement control - resolved: Capabilities contribute named **Instruction Blocks**, Agent instructions can place them with **Instruction Slots**, and unplaced blocks append at the end.
- Chat was considered as a separate definition type - resolved: **Chat** is an Agent-Scoped Capability.
