# Capabilities

Capabilities are the user-shareable abilities that ViteHub applications can add.

## Language

**Capability**:
A shareable ViteHub bundle that adds a named product ability to an application.
_Avoid_: Plugin, integration, extension

**Official Capability**:
A Capability shipped by ViteHub.
_Avoid_: Built-in plugin, core feature

**Transcription**:
An Official Capability that turns audio input parts into transcript text before an Agent runs.
_Avoid_: Voice Input, audio support, voice plugin

**Input Commands**:
An Official Capability that transforms a user's command-style input message before an Agent runs.
_Avoid_: Commands, shell commands, chat commands

**Skills**:
An Official Capability that lets an agent consume Skill files from its workspace.
_Avoid_: Skill plugin, skill system

**Image Generation**:
A Capability that lets an agent create images for the user.
_Avoid_: Image tool, image plugin

**MCP**:
A Capability that lets an agent use tools from configured Model Context Protocol servers.
_Avoid_: MCP client plugin, MCP tools

**Storage Capability**:
An Official Capability that lets an agent access a configured storage primitive.
_Avoid_: Agent Storage Tool, storage plugin, package-owned agent tool

**Chat**:
An Official Capability that lets external conversation events invoke an agent.
_Avoid_: Chat definition, chat plugin, bot definition

**Chat History**:
Conversation context that Chat can persist in an Agent workspace and include in later Agent invocations.
_Avoid_: Chat state, Chat SDK state, agent memory

**Chat Runtime State**:
Internal operational state that Chat uses to coordinate conversation processing across invocations.
_Avoid_: Chat History, public state adapter, agent memory

**Chat Storage**:
The ViteHub storage primitive selected to back Chat Runtime State.
_Avoid_: Chat state adapter, Chat SDK state, lock adapter

**Memory**:
An Official Capability that lets an agent use durable scoped records across invocations.
_Avoid_: Chat History, basic memory, memory file

**Memory Store**:
A named durable collection of Memory Records backed by a replaceable storage adapter.
_Avoid_: Memory backend, memory file, vector memory

**Memory Record**:
A scoped durable fact, episode, procedure, or profile item that Memory can retrieve or mutate.
_Avoid_: Memory entry, note, remembered message

**Memory Scope**:
The boundary that determines which invocations can read or mutate a Memory Record.
_Avoid_: Namespace, key prefix, memory path

**Memory Kind**:
The category of a Memory Record, such as semantic, episodic, procedural, or profile.
_Avoid_: Memory type, backend type, vector kind

**Workspace JSONL Memory Store**:
A Memory Store that persists Memory Records as append-only JSONL in an Agent workspace.
_Avoid_: Markdown memory, basic memory store, memory.md

**Agent-Scoped Invocation**:
An external event route that targets one discovered Agent.
_Avoid_: Global webhook, chat registry route

**MCP Server**:
A named Model Context Protocol server configured inside the MCP Capability.
_Avoid_: MCP instance, MCP capability

**MCP Client Configuration**:
The AI SDK MCP client configuration used by the MCP Capability to connect to an MCP Server.
_Avoid_: ViteHub MCP transport config

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
- **Transcription** is the first planned **Official Capability**.
- **Input Commands** is an **Official Capability**.
- **Skills** is an **Official Capability**.
- **MCP** is an **Official Capability**.
- A **Storage Capability** is an **Official Capability**.
- **Chat** is an **Official Capability**.
- **Chat** can use **Chat History**.
- **Chat History** depends on **Chat Runtime State**.
- **Chat Runtime State** is not a public Capability.
- **Chat Storage** backs **Chat Runtime State**.
- **Memory** is an **Official Capability**.
- **Memory** uses one or more **Memory Stores**.
- A **Memory Store** contains zero or more **Memory Records**.
- A **Memory Record** has one **Memory Scope**.
- A **Memory Record** has one **Memory Kind**.
- A **Workspace JSONL Memory Store** is a **Memory Store**.
- **Memory** is distinct from **Chat History**.
- **MCP** can configure one or more **MCP Servers**.
- An **MCP Server** uses **MCP Client Configuration**.
- **Skills** reads Skill files from a **Skills Path**.
- The **V1 Capability Set** contains **Skills**, **Transcription**, **MCP**, and **Storage Capabilities**.
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
- **Chat** uses **Agent-Scoped Invocations**.
- A **Capability** is a **Single-Instance Capability** by default.

## Example Dialogue

> **Dev:** "Should image generation configure storage?"
> **Domain expert:** "No. Storage belongs to the agent's workspace. **Image Generation** only needs an **Artifact Path** inside that workspace."

## Flagged Ambiguities

- "plugin" was used to mean both framework plugins and user-shareable ViteHub feature bundles - resolved: use **Capability** for the ViteHub domain concept.
- "audio input", "voice input", and "voice transcription" all appeared as names for spoken user messages - resolved: use **Transcription** for the capability.
- "commands" could mean shell/runtime execution or user message shortcuts - resolved: use **Input Commands** for command-style input transforms.
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
- A ViteHub-specific MCP transport shape was considered - resolved: use AI SDK **MCP Client Configuration** for each **MCP Server**.
- Package-owned storage agent tools were considered - resolved: expose storage access through **Storage Capabilities**.
- The default Skills location was unresolved - resolved: the default **Skills Path** is `skills`.
- Capability Phases were considered as functions returning raw contribution objects - resolved: phases mutate a typed **Capability Context**.
- Capability instructions needed placement control - resolved: Capabilities contribute named **Instruction Blocks**, Agent instructions can place them with **Instruction Slots**, and unplaced blocks append at the end.
- Chat was considered as a separate definition type - resolved: **Chat** is an Agent-Scoped Capability.
- Chat discovery was considered as a separate file convention - resolved: **Chat** is discovered only through Agent definitions.
- Chat webhook routing was considered as a global route - resolved: **Chat** uses agent-scoped webhook routes.
- Chat state was considered as a user-facing Capability or option - resolved: expose **Chat History** and keep any Chat SDK state adapter internal.
- Chat History and runtime state were considered the same concept - resolved: **Chat History** is replayable conversation context; **Chat Runtime State** is internal operational state.
- Chat Runtime State was considered opt-in only when Chat History is enabled - resolved: **Chat** always creates internal **Chat Runtime State**; **Chat History** only controls conversation replay.
- Chat runtime backing was considered as a public `state` option - resolved: use **Chat Storage** to select a ViteHub primitive without exposing Chat SDK adapters.
- Agent memory was considered as an extension of **Chat History** - resolved: use **Memory** for durable scoped records and keep **Chat History** limited to conversation replay.
- `basicMemory()` and markdown-backed memory were considered as the public concept - resolved: use **Memory** for the capability and **Workspace JSONL Memory Store** for the first store implementation.
