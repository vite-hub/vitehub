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
A future Capability candidate that lets users send spoken input to an agent.
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

**MCP Server**:
A named Model Context Protocol server configured inside the MCP Capability.
_Avoid_: MCP instance, MCP capability

**Skills Path**:
The workspace-relative directory used by the Skills Capability.
_Avoid_: Skills storage, skills workspace

**V1 Capability Set**:
The first Official Capabilities exposed through Agent definitions: Skills, MCP, Bash, Sandbox, KV, Blob, and DB.
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

**Inline Capability**:
A plain Capability Definition object declared directly inside an Agent's Capabilities list.
_Avoid_: Anonymous plugin, raw tool object

**Capabilities List**:
The ordered list of Capabilities attached to an Agent.
_Avoid_: Capability map, capability registry

**Capability ID**:
The stable identifier for one Capability inside an Agent's Capabilities List.
_Avoid_: Capability name, display name

**Capability Requirement**:
A primitive, workspace mode, or workspace path that a Capability needs before it can be applied to an Agent.
_Avoid_: Capability dependency, plugin dependency

**Requirement Validation**:
The earliest possible check that an Agent satisfies its Capability Requirements.
_Avoid_: Runtime surprise, lazy capability check

**Primitive**:
A ViteHub package-level runtime handle for storage, files, execution, delivery, or state.
_Avoid_: Capability, plugin

**Primitive Capability**:
An Agent Capability that exposes a Primitive to the model through tools, instructions, and policy.
_Avoid_: Primitive, raw handle

**Bash**:
A Primitive Capability that exposes preset shell-style workspace tools to an Agent.
_Avoid_: Root shell, raw terminal

**Workspace Mode**:
The read or write mode an Agent receives for a Workspace.
_Avoid_: Workspace access, workspace permission

**Workspace Rule**:
A path-scoped Workspace policy that controls reads, writes, write size, media type, and write validation.
_Avoid_: Capability rule, tool permission

**Workspace Rules**:
The ordered pattern map of Workspace Rules on one Workspace.
_Avoid_: Route rules, global rules

**Workspace Write Validation**:
The Workspace-owned lifecycle that checks a write operation before it reaches the Workspace Store.
_Avoid_: Capability validation, Skill validation

**Workspace Plugin**:
A reusable Workspace extension that contributes Workspace Rules and Workspace hooks.
_Avoid_: Capability, source, loader

**Bash Mode**:
The read or write mode a Bash Capability exposes to an Agent.
_Avoid_: Bash preset, command preset

**Sandbox**:
A Primitive Capability that exposes isolated program execution to an Agent.
_Avoid_: Code runner, bash

**Sandbox Command**:
An executable name allowed by the Sandbox Capability.
_Avoid_: Shell command string, script command

**KV**:
A Primitive Capability that exposes key-value storage tools to an Agent.
_Avoid_: KV plugin, storage capability

**Blob**:
A Primitive Capability that exposes file-shaped object storage tools to an Agent.
_Avoid_: Blob plugin, upload capability

**DB**:
A Primitive Capability that exposes conservative database schema and query tools to an Agent.
_Avoid_: Database plugin, SQL capability

**Agent Skills Spec**:
The external Agent Skills format that defines Skill file layout and behavior.
_Avoid_: ViteHub skills format, custom skill format

**Skill Definition**:
The `SKILL.md` file required by the Agent Skills Spec.
_Avoid_: Skill metadata, skill manifest

**Skill Reference**:
A file under `references/` that a Skill may ask the Agent to load progressively when needed.
_Avoid_: Auto-loaded context, bundled prompt

**Bundled Skill File**:
A non-spec file shipped beside a Skill and treated as ordinary workspace content unless the Agent Skills Spec gives it meaning.
_Avoid_: Hidden skill metadata, implicit agent config

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

**Workspace**:
An agent-visible file tree that Capabilities can read from or write to when the Agent grants that access.
_Avoid_: Workspace capability, storage plugin

**Primary Workspace**:
The default Workspace an Agent uses when a Capability does not request a more specific Workspace.
_Avoid_: Single workspace, workspace default

**Named Workspace**:
A Workspace addressed by name when an Agent exposes more than one file tree.
_Avoid_: Workspace instance, workspace provider

**Root Tools**:
Raw model tools attached directly to an Agent outside the Capability system.
_Avoid_: Agent tools, top-level tools

## Relationships

- A **Capability** can be added to an application.
- An **Official Capability** is a **Capability**.
- **Skills** is an **Official Capability**.
- **MCP** is an **Official Capability**.
- **MCP** can configure one or more **MCP Servers**.
- **Skills** reads Skill files from a **Skills Path**.
- The **V1 Capability Set** contains **Skills**, **MCP**, **Bash**, **Sandbox**, **KV**, **Blob**, and **DB**.
- **Image Generation** can produce **Capability Artifacts** at an **Artifact Path**.
- An **Official Capability** that produces files should provide a **Default Artifact Path**.
- A **Capability Factory** creates one **Capability**.
- **defineCapability** creates a **Capability Definition**.
- An **Inline Capability** is normalized as a **Capability Definition**.
- An Agent receives a **Capabilities List**.
- A **Capability ID** is unique within one Agent's **Capabilities List**.
- A **Capability** can declare **Capability Requirements**.
- **Requirement Validation** should run as early as possible.
- A **Capability Requirement** can name required workspace paths.
- A **Primitive Capability** is a **Capability**.
- A **Primitive Capability** requires its corresponding **Primitive**.
- **Bash** is a **Primitive Capability**.
- **Bash** has one **Bash Mode**.
- **Bash Mode** must not exceed the **Workspace Mode**.
- **Bash** requires an explicit **Workspace**.
- A **Workspace** owns **Workspace Rules**.
- A **Workspace Rule** is path-scoped.
- **Workspace Write Validation** belongs to the **Workspace**, not to one **Capability**.
- A **Workspace Plugin** can contribute **Workspace Rules**.
- A **Workspace Plugin** is not a **Capability**.
- **Sandbox** is a **Primitive Capability**.
- **Sandbox** uses **Sandbox Commands**.
- **Sandbox** can run against a read-mode **Workspace**.
- **Sandbox** requires an explicit **Workspace**.
- **KV** is a **Primitive Capability**.
- **Blob** is a **Primitive Capability**.
- **DB** is a **Primitive Capability**.
- **KV**, **Blob**, and **DB** use read and write modes.
- **Skills** follows the **Agent Skills Spec**.
- **Skills** requires a **Skill Definition**.
- **Skills** can load **Skill References** progressively.
- **Skills** does not execute scripts.
- **Skills** treats non-spec files as **Bundled Skill Files**.
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
- A V1 Agent exposes one **Primary Workspace**.
- A **Capability** can consume one or more **Workspaces**.
- A **Workspace** is not a **Capability**.
- **Root Tools** are not part of the public Agent API.

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
- Root-level raw tools were considered as an Agent extension point - resolved: remove **Root Tools** from the public Agent API; raw tools should be exposed through a Capability.
- Capability containers were considered as object maps - resolved: use a **Capabilities List** for Vite-style composition.
- Inline custom Capabilities were considered to require `defineCapability` - resolved: accept **Inline Capabilities** and normalize them internally with the same validation as `defineCapability`.
- Capability IDs were considered globally unique - resolved: a **Capability ID** must be unique within one Agent's **Capabilities List**.
- Capabilities were considered to assume primitive access implicitly - resolved: Capabilities can declare **Capability Requirements** so missing workspace, sandbox, or other primitive access fails early.
- Capabilities were considered to auto-enable missing Primitives - resolved: missing **Capability Requirements** fail with a clear error.
- Requirement validation was considered runtime-only - resolved: run **Requirement Validation** as early as possible, using runtime checks only for provider state that cannot be known earlier.
- KV, Blob, DB, Sandbox, and Workspace were considered as Capabilities - resolved: they are **Primitives**; Agent-facing helpers such as `kv()`, `blob()`, or `db()` are **Primitive Capabilities** that expose those Primitives to the model.
- Workspace write restrictions were considered as Capability behavior - resolved: path-scoped write behavior belongs to **Workspace Rules**, while Capabilities declare what workspace access they need.
- Skills-specific write behavior was considered for docs-oriented skills - resolved: **Skills** remains a reader of Skill files; reusable write behavior belongs to **Workspace Rules**, **Workspace Write Validation**, and **Workspace Plugins**.
- Skills-specific `SKILL.md` checks were considered as special runtime logic - resolved: **Skills** declares a required workspace path and generic **Requirement Validation** checks it.
- Shell access was considered as raw root tools - resolved: expose it through **Bash** with **Bash Mode**.
- Bash option naming was considered as `preset` or `access` - resolved: use **Bash Mode** and **Workspace Mode** with `read` and `write` values.
- `bash()` without options was considered invalid - resolved: **Bash** defaults to read **Bash Mode**.
- Bash was considered to create an implicit Workspace - resolved: **Bash** requires an explicit **Workspace**.
- Sandbox command allowlists were considered as full command strings - resolved: use **Sandbox Commands** as executable names such as `node`, `python3`, or `pnpm`.
- Sandbox default access was considered implicit - resolved: without **Sandbox** the Agent cannot execute programs; **Sandbox Commands** must be explicitly configured.
- Sandbox was considered to require write-mode Workspace access - resolved: **Sandbox** can execute against a read-mode **Workspace**; persisting changes still requires write-mode access.
- Ephemeral Sandbox writes with a read-mode Workspace were considered - deferred: v1 keeps this out of scope; developers should use write-mode Workspace access when the Agent needs write operations.
- Sandbox path constraints were considered - deferred: v1 uses executable-name allowlisting only.
- Sandbox named profiles were considered - deferred: v1 requires explicit **Sandbox Commands** arrays.
- `sandbox()` without commands was considered valid - resolved: **Sandbox** requires explicit **Sandbox Commands** in v1.
- Sandbox was considered to create an implicit Workspace - resolved: **Sandbox** requires an explicit **Workspace**.
- Multiple public Workspaces were considered for v1 - deferred: v1 exposes one **Primary Workspace** and can normalize internally toward future **Named Workspaces**.
- KV, Blob, and DB mode vocabulary was considered separately - resolved: use read and write modes consistently with Workspace and Bash.
- Skills format was considered as ViteHub-specific - resolved: **Skills** follows the **Agent Skills Spec** only.
- Skills metadata files such as `skill.meta.json` and `agents/*.yaml` were considered special - resolved: non-spec files are ordinary bundled files unless the **Agent Skills Spec** defines otherwise.
- Skill References were considered for automatic loading - resolved: load `SKILL.md` first and load **Skill References** progressively only when needed.
- Skills script execution was considered part of Skills - resolved: **Skills** does not execute scripts; script execution requires Sandbox or an appropriate Bash operation.
