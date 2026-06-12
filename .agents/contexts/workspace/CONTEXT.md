# Workspace

Workspace names persistent file-tree state and source ingestion for agent-oriented Vite apps and server hosts.

## Language

**Workspace**:
A named persistent file tree that agents and server code can inspect, mutate when allowed, snapshot, and sync into execution runtimes.

**Workspace Store**:
The configured backing store used to persist a Workspace file tree.
_Avoid_: Blob Store, Source, Chat State

**Colocated Workspace Definition**:
A Workspace Definition declared inline with the consumer that primarily uses it.
_Avoid_: Agent Workspace, Capability Workspace

**Workspace Source Root**:
The directory beside a Colocated Workspace Definition that contains local files explicitly declared as Sources.
_Avoid_: Project root, worktree root, automatic sibling ingestion

**Source**:
A named origin that exposes read-only addressable files or items through a Workspace.
_Avoid_: Input, files, context, resource, mount, connector

**Source Instruction**:
Model-facing guidance attached to a Source that explains what the Source is for and how an Agent should use it.
_Avoid_: Source description, source metadata, prompt fragment

**Source Resolution**:
The trusted step that turns a Source declaration into the concrete Source origin, Mount, and Source Instructions for one Workspace runtime surface.
_Avoid_: Source callback, dynamic source, provider options

**Invocation-Scoped Source Resolution**:
Source Resolution that narrows a Source for one Agent Invocation from trusted invocation context, usually the Selected Workspace Scope.
_Avoid_: Invoker-aware source, prompt filter, per-user source

**Materialized Source**:
A Source whose items are written into the Workspace Store.
_Avoid_: Stored connector, synced files

**Live Source**:
A Source whose items are fetched on demand without being written into the Workspace Store by default.
_Avoid_: Virtual Source, Ephemeral Source, query tool

**MCP Resource Source**:
A Source that exposes read-only MCP resources from an external MCP Server as addressable Source-Backed Paths.
_Avoid_: MCP Capability, MCP tool bridge, query-only MCP wrapper

**Source Map**:
The keyed object that declares a Workspace's Sources.
_Avoid_: Source list, source array

**Source Namespace**:
The public authoring namespace that contains all Workspace Source helpers.
_Avoid_: Common sources, runtime sources, provider source namespace

**Mount**:
The placement of a Source inside a Workspace file tree.
_Avoid_: Source

**Source-Backed Path**:
A workspace path whose contents come from a Source.
_Avoid_: Editable source file, synced file

**Single-File Source**:
A Source that contributes exactly one build-time materialized file from the Workspace Source Root into a Workspace.
_Avoid_: Workspace file, inline file, source path

**Source Sync**:
An explicit future mechanism that reconciles Source-Backed Paths with their Sources.
_Avoid_: Implicit write-back, normal workspace write

**Workspace Rule**:
A path-scoped policy that controls reads, writes, write size, media type, and write validation.
_Avoid_: Capability rule, tool permission

**Workspace Plugin**:
A reusable Workspace extension that contributes Workspace Rules and Workspace hooks.
_Avoid_: Capability, source, loader

**Workspace Tools**:
Agent tools derived from a Workspace Definition for inspecting or mutating Workspace files.
_Avoid_: Workspace Capability, bash, raw tools

**Workspace Access Mode**:
The read or write authority requested for a Workspace runtime surface or Workspace Capability.
_Avoid_: allowWrite, writable flag, permission boolean

**Workspace Scope**:
The trusted runtime boundary that determines which Workspace file tree, Source-Backed Paths, and Workspace Tools are visible for one Agent Invocation without exposing the scope decision to the model by default.
_Avoid_: Context filtering, tenant filter, dynamic capability, model-facing scope

**Selected Workspace Scope**:
The single Workspace Scope chosen for one Agent Invocation.
_Avoid_: Active organization, current tenant, hidden filter

**All-Scopes Workspace Scope**:
An explicit privileged Workspace Scope that can expose more than one ordinary Workspace Scope in one Agent Invocation.
_Avoid_: Default admin view, merged workspace, unrestricted context

**Workspace Scope Grant**:
A declared visibility grant inside a Workspace Scope, expressed through Source keys, Workspace path prefixes, or both.
_Avoid_: Prompt filter, role, Workspace Rule

**Workspace Scope Resolver**:
Explicit trusted runtime logic that selects the Workspace Scope for one Agent Invocation from host, auth, or invocation context.
_Avoid_: Model route, prompt classifier, Workspace Definition

**Scope-Masked Miss**:
A model-facing not-found result for a Workspace path that exists outside the active Workspace Scope.
_Avoid_: Permission denied, hidden path warning, scope leak

**Default Workspace Scope**:
A developer-declared Workspace Scope used when resolver input does not select a more specific scope.
_Avoid_: Implicit fallback, all scopes, public default

**Workspace File Tree**:
The single public file tree exposed by a Workspace regardless of whether a file is backed by store state, a Source, or a build-time asset.
_Avoid_: Asset workspace, runtime workspace, merged workspace

**Workspace Session**:
A runtime materialization of a Workspace that can execute commands and commit file changes back to the Workspace Store.
_Avoid_: Open workspace, sandbox, mount

## Relationships

- A **Workspace** has one **Workspace Store**.
- A **Workspace** exposes one **Workspace File Tree**.
- A **Colocated Workspace Definition** still defines a **Workspace**.
- A **Workspace Store** can be backed by a Blob Store.
- A **Workspace** has zero or more **Sources**.
- A **Workspace** declares Sources through one **Source Map**.
- A **Source Namespace** contains local, inline, tree, and provider Source helpers.
- A **Source Map** key is ordinary Source identity; a key such as `instructions` does not make Source content into Agent instructions.
- A **Source** may have **Source Instructions**.
- **Source Instructions** may be declared statically or produced by **Source Resolution**.
- **Source Instructions** are explicit developer-authored Source configuration, not inferred provider metadata.
- **Source Instructions** guide Agent behavior, but they do not grant access to hidden Sources or change Workspace Scope.
- An Agent should receive **Source Instructions** only for Sources visible through the **Selected Workspace Scope**.
- If any visible Source has **Source Instructions**, the Agent should receive them by default at the end of its instructions unless the **Agent Definition** explicitly places the source guidance.
- If an **Agent Definition** places `workspace.sources` but no visible Source has **Source Instructions**, the placement should render as empty instructions.
- Explicit Source Instruction placement uses `workspace.sources` and renders the complete generated Source guidance block, including its heading.
- The generated Source guidance block should render each Source under a Source Map key heading and should not add generated descriptions or Mount summaries when the Source already has **Source Instructions**.
- Sources without **Source Instructions** should be omitted from the generated Source guidance block.
- A **Colocated Workspace Definition** has a **Workspace Source Root**.
- A **Workspace Source Root** is a `workspace/` directory beside the Colocated Workspace Definition when present, otherwise the definition directory.
- A **Source Map** key is the canonical identity of its Source.
- A **Source** has zero or one **Mount**.
- A **Source** may use **Source Resolution** to derive its origin, **Mount**, and **Source Instructions** before it is exposed through the **Workspace File Tree**.
- **Invocation-Scoped Source Resolution** depends on trusted Agent Invocation inputs, not model output.
- **Invocation-Scoped Source Resolution** may narrow a Source to the **Selected Workspace Scope**, but it does not replace Workspace Scope enforcement.
- **Invocation-Scoped Source Resolution** cannot broaden visibility beyond the Sources and paths allowed by the **Selected Workspace Scope**.
- A **Source** can expose local or external read-only information when that information has addressable files or items.
- A **Source** must expose addressable files or items; query-only read tools belong outside the Source concept.
- An **MCP Resource Source** is appropriate when an MCP Server mostly exposes read-only resources that can be addressed as files or items.
- MCP tools remain Capability behavior; an **MCP Resource Source** should not turn executable MCP tools into Source-Backed Paths.
- A **Materialized Source** persists its items in the **Workspace Store**.
- A **Live Source** resolves Source-Backed Paths directly from its origin unless an explicit cache or materialization policy says otherwise.
- A **Live Source** cache is separate from the **Workspace Store** and is opt-in.
- A **Live Source** must support direct reads for known Source-Backed Paths, but it does not have to enumerate every item.
- A **Live Source** can provide search, but search results must resolve to readable Source-Backed Paths.
- A **Live Source** exposes which Workspace operations it supports for inspection surfaces such as DevTools.
- A **Source-Backed Path** belongs to exactly one Source.
- A **Single-File Source** path is relative to the Workspace Source Root.
- A **Single-File Source** can default its Mount to the Workspace root and its Source-Backed Path to the source file basename.
- Current workspace writes target normal Workspace paths, not Source-Backed Paths.
- Capability-persisted artifacts, such as Transcription Artifacts, target normal Workspace paths and remain subject to Workspace Rules.
- **Source Sync** is distinct from normal workspace writes.
- A **Workspace Rule** is path-scoped.
- A **Workspace Plugin** can contribute Workspace Rules.
- An Agent with a **Colocated Workspace Definition** receives read-only **Workspace Tools** by default.
- **Workspace Tools** can be disabled or upgraded to write mode through the Workspace Definition.
- A **Workspace Access Mode** is `read` by default and must be explicit when write authority is requested.
- A **Workspace Scope** narrows Workspace visibility for an Agent Invocation without granting new Capabilities dynamically.
- A **Workspace Scope** is resolved from trusted host or invocation context before Workspace Tools are exposed to the model.
- A **Workspace Scope** can be applied by the **Access Capability**, but it does not mutate the Workspace Definition or add Sources.
- A **Workspace Scope** is enforced by Workspace reads, lists, searches, shell-shaped commands, and Workspace Tools; the model sees only the scoped Workspace File Tree.
- A **Workspace Scope** contains **Workspace Scope Grants**.
- A **Workspace Scope Grant** can target a Source key, a Workspace path prefix, or a path prefix within a Source.
- A Source-key **Workspace Scope Grant** fails closed for unknown Sources and root-mounted Sources; root-mounted Sources require explicit path grants.
- A **Workspace Scope Resolver** selects the Workspace Scope before Workspace Tools or Workspace-backed instructions are exposed.
- A **Workspace Scope Resolver** can read trusted host, auth, and invocation context, but it does not use model output as authority.
- A **Workspace Scope Resolver** can select a static named Workspace Scope or return an inline Workspace Scope definition for invocation-specific grants.
- Workspace Scope is read-only in the first version.
- Scoped Workspace Scope does not expose source materialization in the first version.
- An out-of-scope Workspace path is a **Scope-Masked Miss** to the model.
- A **Scope-Masked Miss** can be recorded in server-side audit or tracing without revealing the hidden path to the model.
- An Agent Invocation uses one **Selected Workspace Scope** by default.
- **All-Scopes Workspace Scope** is explicit and privileged; it is not the default result of a user belonging to multiple scopes.
- A missing **Selected Workspace Scope** fails the Agent Invocation unless the developer declared a **Default Workspace Scope**.
- A **Default Workspace Scope** is explicit configuration and never implies **All-Scopes Workspace Scope**.
- A **Workspace Session** starts from a Workspace runtime surface and may use a Sandbox provider behind the boundary.

## Example Dialogue

> **Dev:** "Should we rename `workspace.sources` to `workspace.mounts`?"
> **Domain expert:** "No. A **Source** is the origin. The **Mount** only says where that source appears inside the **Workspace**."

## Flagged Ambiguities

- "source" can mean source code, provenance, or data connector - resolved: in Workspace, **Source** means a named origin that exposes read-only addressable files or items.
- "source instructions" were considered source descriptions or generic metadata - resolved: use **Source Instruction** for model-facing guidance about how an Agent should use a Source.
- Dynamic Source Instructions were considered - resolved: **Source Instructions** may be produced by **Invocation-Scoped Source Resolution** when the guidance describes the resolved Source itself; invocation-specific audience or behavior guidance still belongs in Agent or Capability instructions.
- Unplaced Source Instructions were considered explicit-placement-only - resolved: append visible Source Instructions by default at the end of Agent instructions, while allowing explicit placement.
- Empty Source Instruction placement was considered for an explanatory fallback - resolved: render empty instructions so hidden or scoped-out Sources are not implied.
- Custom heading ownership for Source Instruction placement was considered - resolved: the generated Source guidance block includes its own heading.
- Generated Source descriptions and Mount summaries were considered for each Source Instruction entry - resolved: when a Source declares **Source Instructions**, render the Source Map key heading plus the declared instructions only.
- Inferring **Source Instructions** from provider metadata such as GitHub repository descriptions was considered - resolved: do not infer prompt text from provider metadata in the first version.
- Rendering every visible Source in the generated Source guidance block was considered - resolved: only Sources with explicit **Source Instructions** appear.
- Query-only access to external information was considered a Source shape - resolved: a **Source** must expose addressable files or items, even when search or query helps discover them.
- Non-store-backed external Sources were called "virtual" or "ephemeral" - resolved: use **Live Source** for on-demand read-through Sources and reserve "virtual" for Vite module surfaces.
- Addressable Sources were assumed to be fully enumerable - resolved: a **Live Source** can support direct reads for known paths without global enumeration.
- Live Source search was considered mandatory - resolved: search is optional, and any search hit must resolve to a readable Source-Backed Path.
- "mount" was considered as the name for `workspace.sources` - resolved: **Mount** is only the placement of a Source inside the Workspace.
- `workspace.sources` was considered as an array for simple one-off Sources - resolved: use a **Source Map** so every Source has stable identity.
- A Source Map key named `instructions` was considered as a special prompt signal - resolved: keep it an ordinary Source key and use explicit **Source Instructions** for model-facing guidance.
- A broad `workspace` instruction placement slot was considered for **Source Instructions** - resolved: use `workspace.sources` so Source guidance is precise and does not imply all Workspace behavior.
- Agent `workspace: { ... }` shorthand was considered as Agent-owned configuration - resolved: treat it as a **Colocated Workspace Definition**.
- Sibling files next to a **Colocated Workspace Definition** were considered for automatic ingestion - resolved: require explicit **Sources** instead.
- Single-file Source root mounting was considered equivalent to tree Source root mounting - resolved: **Single-File Source** can use basename-at-root defaults because it contributes one build-time materialized file.
- Single-file Source paths were considered project-root paths - resolved: **Single-File Source** paths are relative to the **Workspace Source Root** and do not allow absolute paths; this applies to both shorthand and object forms.
- Single-file Source `path` was considered an inline content output path - resolved: `path` is only a local input path; inline content uses `workspacePath`.
- Single-file Sources were considered source-key mounted by default - resolved: **Single-File Sources** root-mount by default; source-key mounting is explicit.
- Workspace inspection was considered a separate Workspace Capability - resolved: **Workspace Tools** are derived from the Workspace Definition by default.
- Local and provider Source helpers were considered separate public namespaces - resolved: use one **Source Namespace** for all public Source authoring helpers.
- Workspace write authority was considered as `allowWrite: true` - resolved: use **Workspace Access Mode** language such as `mode: "write"` instead of a permission boolean.
- Per-user or per-customer context filtering was considered as instruction-only behavior - resolved: use **Workspace Scope** for the trusted runtime visibility boundary.
- Multi-scope visibility was considered as a default merged view - resolved: use one **Selected Workspace Scope** by default, with **All-Scopes Workspace Scope** as an explicit privileged mode.
- Out-of-scope paths were considered for permission-denied tool feedback - resolved: return model-facing not-found behavior as a **Scope-Masked Miss** to avoid leaking hidden paths.
- Workspace Scope write grants were considered for the first version - resolved: keep Workspace Scope read-only until read isolation is proven.
- `workspaceScope()` was considered as the Capability helper name - resolved: keep **Workspace Scope** as Workspace language and use `access()` for the broader Capability.
- Ambient `workspaceScope` invocation context was considered as authority - resolved: require an explicit **Workspace Scope Resolver** or **Default Workspace Scope**.
- Static pre-registration for every customer scope was considered necessary - resolved: use inline Workspace Scope definitions from the **Workspace Scope Resolver** when grants are derived from trusted invocation context.
- Source materialization under scoped access was considered for the first version - resolved: disable materialization for scoped V1 to avoid source metadata leakage.
- Source-level narrowing was considered as direct invoker access - resolved: use **Invocation-Scoped Source Resolution** from trusted invocation context and the **Selected Workspace Scope**, not raw model-facing metadata or duplicate authorization logic inside a Source.
- Build-time Workspace assets were considered a second user-facing read surface - resolved: users read one **Workspace File Tree** while asset provenance remains internal by default.
- `open()` was considered as the Workspace execution-session method - resolved: use `startSession()` because it names the **Workspace Session** lifecycle.
