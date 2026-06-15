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
A named origin that exposes read-only addressable files, items, or controlled request access through a Workspace.
_Avoid_: Input, files, context, resource, mount, connector

**Request-Only Source**:
An API-backed Source that exposes a Source Request Descriptor and Source Network Grant without a default Source-Backed Path.
_Avoid_: Query-only tool, default materialized file

**Source Instruction**:
Model-facing guidance attached to a Source that explains what the Source is for and how a model-backed Agent Driver should use it.
_Avoid_: Source description, source metadata, prompt fragment

**Source Network Grant**:
A network access boundary contributed by a Source so a Workspace-backed Shell Runtime can inspect the Source's HTTP origin through controlled shell commands.
_Avoid_: Source Instruction, generic fetch permission

**Source Request Shape**:
A structured request boundary for an API-backed Source that describes the allowed HTTP URL, method, query, and body before materialized reads or controlled shell requests run.
_Avoid_: OpenAPI operation, full API catalog, Source Instruction

**Source Request Part Branch**:
The mutually exclusive choice between a concrete Fetch-style request value and a schema-backed model-authored request input for one request part.
_Avoid_: Duplicate default, merged request input, request contract

**Schema-Derived Default Request**:
The default API-backed Source request produced by validating empty input through schema-backed request parts when a Source-Backed Path is present.
_Avoid_: Hidden fallback, inferred model input, second default

**Source Request Schema Projection**:
A Standard JSON Schema-compatible representation of a Source Request Shape's model-authored request inputs for Source Request Descriptor guidance.
_Avoid_: Custom schema summary, OpenAPI operation, prompt-only example

**Source Request Credential**:
A trusted request value, such as a header or cookie, that ViteHub injects for API-backed Source reads and controlled shell requests without exposing the secret to the model.
_Avoid_: Model-authored header, visible token, prompt credential

**Source Request Callback Context**:
The trusted runtime argument passed to an API-backed Source request factory while executing a Source read or controlled shell request.
_Avoid_: Source definition factory, model input, runtime config bag

**Source Request Descriptor**:
A generated Workspace metadata file for one visible API-backed Source, written at `.vitehub/sources/<sourceKey>.json`.
_Avoid_: Source, Source Instructions, full request schema prompt, global request index

**Shell Source Request Hint**:
A generated model-facing instruction block that points a shell-capable Agent Driver to visible Source Request Descriptors for controlled `curl` use.
_Avoid_: Source Instructions, workspace.sources, full request schema prompt, custom curl syntax

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

**Workspace Source Binding**:
A Workspace-owned declaration that places a Source Definition into a Workspace and attaches Workspace-owned source metadata and policy.
_Avoid_: Source Definition, Source Loader, provider adapter

**Workspace Source Binding Input**:
The author-facing plain object form that ViteHub normalizes into a Workspace Source Binding.
_Avoid_: Raw Source Definition, provider options only, Source Loader namespace

**Source Namespace**:
A convenience namespace that groups Source Loader helpers when grouped source imports are useful.
_Avoid_: Primary source authoring surface, Workspace-owned provider namespace

**Mount**:
The placement of a Source inside a Workspace file tree.
_Avoid_: Source

**Source-Backed Path**:
A workspace path whose contents come from a Source.
_Avoid_: Editable source file, synced file

**Source Workspace Path**:
An explicit Workspace File Tree path where an API-backed Source exposes a default Source-Backed Path.
_Avoid_: HTTP path, Source path, fetch path

**Single-File Source**:
A Source that contributes exactly one build-time materialized file from the Workspace Source Root into a Workspace.
_Avoid_: Workspace file, inline file, source path

**Source Sync**:
An explicit Workspace lifecycle operation that reconciles selected Source-Backed Paths with their Sources through the Workspace Store.
_Avoid_: Implicit write-back, normal workspace write

**Source Sync Policy**:
A Source declaration policy, orthogonal to materialization mode, that makes a Source eligible for Source Sync and controls Source Sync behavior such as stale Source-Backed Path handling.
_Avoid_: Source kind, materialization mode, schedule

**Source Sync Inventory**:
The Source-provided complete set of Workspace-facing items for one Source Sync run.
_Avoid_: Live Source listing, Workspace list, raw upstream list

**Source Sync State**:
Workspace-owned metadata that records the latest compact Source Sync state for a Source.
_Avoid_: Schedule Run history, Git history, full run log

**Source Sync Result**:
The structured result returned by one Source Sync operation.
_Avoid_: Source Sync State, Schedule Run, Workspace Snapshot

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

**Harness Workspace Session**:
A scoped Workspace Session prepared for a harness-backed Agent Driver, exposing a materialized filesystem and session boundary instead of model-facing Workspace Tools by default.
_Avoid_: Workspace Tools, prompt context, unscoped checkout

**Harness Session Key**:
A developer-provided stable identity used to reuse a Harness Workspace Session across Agent Invocations.
_Avoid_: Chat Session, thread id, implicit conversation state

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
- A **Source** may be a **Request-Only Source**.
- **Source Instructions** may be declared statically or produced by **Source Resolution**.
- **Source Instructions** are explicit developer-authored Source configuration, not inferred provider metadata.
- **Source Instructions** guide model-backed Agent Driver behavior, but they do not grant access to hidden Sources or change Workspace Scope.
- A **Source** may contribute a **Source Network Grant** separately from its **Source Instructions**.
- **Source Network Grants** grant controlled shell network access; **Source Instructions** only guide model-backed Agent Driver behavior.
- A visible API-backed **Source** may contribute a **Source Network Grant** automatically when a Workspace-backed Shell Runtime is enabled.
- An API-backed **Source** may declare a **Source Request Shape** to describe allowed query parameters and request body fields.
- A **Source Request Shape** is declared with Standard Schema-compatible schemas.
- A **Source Request Shape** uses **Source Request Part Branches** for query and body.
- A concrete request value branch uses Fetch-style names such as `query` and `body`.
- A schema-backed request input branch uses schema names such as `querySchema` and `bodySchema`.
- A Source declaration must not declare both branches for the same request part.
- A schema-backed request input branch may provide default values through its Standard Schema-compatible validator.
- An API-backed Source with a Source-Backed Path and a schema-backed request input branch uses a **Schema-Derived Default Request** for that request part.
- A **Schema-Derived Default Request** validates empty input through the request part schema.
- If a **Schema-Derived Default Request** cannot be produced, the Source-Backed Path read fails clearly and the Source should either add schema defaults or become a **Request-Only Source**.
- A **Source Request Shape** needs a **Source Request Schema Projection** when it is exposed through a **Source Request Descriptor**.
- A **Source Request Schema Projection** uses the Standard JSON Schema-compatible interface rather than a ViteHub-specific schema summary.
- API-backed Sources use Fetch-style option names such as method, query, body, headers, cookies, timeout, and workspacePath.
- In Fetch-style API-backed Source options, headers and cookies are **Source Request Credentials**, not model-authored request input schemas.
- Request-shaped API-backed Sources support `GET`, `HEAD`, and `POST` in v1.
- A **Source Request Shape** is method-aware; request bodies belong only to methods that support bodies.
- In v1, `GET` and `HEAD` request shapes may use query branches but not body branches.
- In v1, `POST` request shapes may use query and body branches.
- A **Source Request Shape** can shape compact model guidance and **Source Network Grants** without exposing a full API catalog as **Source Instructions**.
- A **Source Request Shape** can generate the mechanical model guidance for controlled shell requests; **Source Instructions** remain optional guidance about the Source's domain meaning.
- A **Source Request Shape** validates the request produced by controlled shell commands.
- API-backed Source response validation is not part of the **Source Request Shape**.
- **Source Request Credentials** may be injected into API-backed Source reads and controlled shell requests but must not be authored or overridden by the model.
- API-backed Source reads and controlled shell requests use the same **Source Request Credentials** by default.
- API-backed Source request factories may receive a **Source Request Callback Context**.
- A **Source Request Callback Context** includes the normalized outbound request facts after request validation and schema defaulting.
- A **Source Request Callback Context** includes Source identity, Workspace identity, Selected Workspace Scope, trusted invocation context when available, run metadata when available, and host/server runtime context when available.
- A Source request factory may use its **Source Request Callback Context** to produce execution-only request additions such as headers, cookies, and timeout.
- A Source request factory must not use its **Source Request Callback Context** to redefine Source identity, URL, method, Workspace placement, request schemas, Source Instructions, or cache policy.
- A **Source Request Descriptor** exposes compact request guidance for one visible API-backed Source.
- A **Source Request Descriptor** is scoped to the **Selected Workspace Scope** and is not generated for hidden Sources.
- A **Source Request Descriptor** redacts **Source Request Credentials**.
- A **Source Request Descriptor** uses the Source Map key as its file stem in `.vitehub/sources/`.
- A request-shaped API-backed Source key must be safe as a single generated file stem in v1.
- A **Request-Only Source** must have a **Source Request Descriptor** when visible.
- A **Request-Only Source** does not create a default Source-Backed Path.
- An API-backed Source uses a **Source Workspace Path** only when it should expose a default Source-Backed Path.
- Controlled shell requests against **Source Network Grants** return ephemeral Shell observations by default, not Workspace Store writes.
- A **Shell Source Request Hint** is emitted only when `workspaceShell()` is enabled and at least one visible API-backed Source has a **Source Request Descriptor**.
- A **Shell Source Request Hint** should reuse existing Capability instruction slot templating rather than introduce a Source-specific placement slot.
- A **Shell Source Request Hint** should be placeable through the `workspaceShell()` Capability instruction block, such as `{{ capabilities.workspaceShell }}` or the catch-all `{{ capabilities }}`.
- A **Shell Source Request Hint** must not render through `workspace.sources`, because it is generated shell guidance rather than developer-authored **Source Instructions**.
- A model-backed Agent Driver should receive **Source Instructions** only for Sources visible through the **Selected Workspace Scope**.
- If any visible Source has **Source Instructions**, a model-backed Agent Driver should receive them by default at the end of its instructions unless the driver explicitly places the source guidance.
- If a model-backed Agent Driver places `workspace.sources` but no visible Source has **Source Instructions**, the placement should render as empty instructions.
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
- A **Source** can expose local or external read-only information as addressable files, addressable items, or controlled request access.
- A Source that exposes only controlled request access must be a **Request-Only Source**.
- Arbitrary model-facing query tools remain outside the Source concept.
- An **MCP Resource Source** is appropriate when an MCP Server mostly exposes read-only resources that can be addressed as files or items.
- MCP tools remain Capability behavior; an **MCP Resource Source** should not turn executable MCP tools into Source-Backed Paths.
- A **Materialized Source** persists its items in the **Workspace Store**.
- A **Live Source** resolves Source-Backed Paths directly from its origin unless an explicit cache or materialization policy says otherwise.
- A **Live Source** cache is separate from the **Workspace Store** and is opt-in.
- A **Live Source** must support direct reads for known Source-Backed Paths, but it does not have to enumerate every item.
- A **Live Source** can provide search, but search results must resolve to readable Source-Backed Paths.
- A **Live Source** exposes which Workspace operations it supports for inspection surfaces such as DevTools.
- A **Source-Backed Path** belongs to exactly one Source.
- A **Source Map** contains **Workspace Source Bindings**.
- A **Source Map** may accept **Workspace Source Binding Inputs** that normalize into Workspace Source Bindings.
- A **Workspace Source Binding** can reference a Source Package **Source Definition**.
- A **Workspace Source Binding** owns Mount, Source Instructions, materialization mode, validation, and Source Sync Policy for that Source inside one Workspace.
- A **Workspace Source Binding Input** may infer a Source Loader from unambiguous Source Loader options.
- A **Workspace Source Binding Input** should use TypeScript types to prevent ambiguous Source Loader option combinations.
- Runtime normalization of a **Workspace Source Binding Input** should reject ambiguous Source Loader option combinations.
- A **Workspace Source Binding Input** may reference a reusable Source Definition.
- A **Workspace Source Binding Input** may declare inline custom Source retrieval behavior.
- Named Source Loader imports from the Source Package are the preferred Source authoring shape.
- A **Source Namespace** can remain a convenience, but it is not the preferred authoring shape.
- A **Single-File Source** path is relative to the Workspace Source Root.
- A **Single-File Source** can default its Mount to the Workspace root and its Source-Backed Path to the source file basename.
- Current workspace writes target normal Workspace paths, not Source-Backed Paths.
- Capability-persisted artifacts, such as Transcription Artifacts, target normal Workspace paths and remain subject to Workspace Rules.
- **Source Sync** is distinct from normal workspace writes.
- **Source Sync** is a lifecycle operation over existing Sources, not a separate Source kind.
- **Source Sync** requires explicit Source selection.
- Source selection for Source Sync may target specific Source Map keys or all eligible Sources.
- The Workspace sync lifecycle requires explicit selection.
- The Workspace sync lifecycle runs **Source Sync** when the explicit selection targets Sources.
- **Source Sync** is not triggered by build, dev, or normal Workspace reads.
- Build-time Sources feed the **Workspace Asset Surface** rather than **Source Sync** or the Workspace sync lifecycle.
- Build and dev integrations own build-time Source materialization.
- Downstream consumption of durable Workspace files is project-specific composition outside Source Sync.
- **Live Sources** may still resolve Source-Backed Paths on read without running **Source Sync**.
- **Source Sync** may materialize Source items, update Workspace-owned source state, and remove stale Source-owned paths when source capabilities and policy allow.
- **Source Sync** does not imply that provider-specific Source adapters are official Workspace Source helpers.
- Downstream apps may implement provider-specific Sources through the generic Source contract.
- A Source may declare a **Source Sync Policy** without becoming a separate Source kind.
- A **Source Sync Policy** is orthogonal to a Source materialization mode.
- A Source may support both read-triggered materialization and **Source Sync** when both are declared.
- The common Source Sync case is a Source with **Source Sync Policy** and no build-time or read-triggered materialization.
- A **Source Sync Policy** does not declare a Schedule.
- **Source Sync** keeps stale Source-Backed Paths by default.
- A **Source Sync Policy** may opt into stale Source-Backed Path removal.
- Stale Source-Backed Path removal requires Source-owned path proof and either complete source enumeration or authoritative source delete events.
- A **Source Sync Inventory** is the complete source enumeration contract for Source Sync.
- A **Source Sync Inventory** returns Workspace-facing items, not raw upstream item identities.
- A Source list or read method does not imply **Source Sync Inventory** support.
- A sync-eligible **Workspace Source Binding** can use `getKeys` and `getItem` as its Source Sync Inventory contract.
- When stale Source-Backed Path removal is enabled, `getKeys` must be complete for the selected Source.
- A Source that cannot enumerate completely can still use **Source Sync** when stale Source-Backed Path removal is disabled.
- **Source Sync State** stores compact latest state, not unbounded Source Sync run history.
- **Source Sync State** can record previous Source-Backed Path manifests, source item digests or versions, cursors, refs, generations, config hashes, last successful sync metadata, and last attempted error summaries.
- A **Source Sync Result** returns per-source counts by default.
- A **Source Sync Result** may include path-level details only when explicitly requested.
- Source Sync Result detail defaults to summary-level output.
- Path-level Source Sync Result detail is an explicit opt-in.
- Schedule-owned run history remains **Schedule Run** and **Schedule Run Attempt** behavior.
- Publication history remains Workspace Store snapshot or provider history.
- **Source Sync** does not own Workspace Store snapshot, publish, no-op persistence, provider conflict, or Git semantics.
- A Workspace lifecycle may compose **Source Sync** with Workspace Store snapshot or publish, but those Store side effects must be explicit at the lifecycle boundary.
- A composed Source Sync snapshot option can be a boolean or snapshot options.
- A composed Source Sync publish option is a boolean v1 lifecycle option.
- A Schedule handler can call **Source Sync** directly; a separate Source Sync target registry is not part of the first design.
- **Source Sync** can return a partial result when one selected Source fails.
- Workspace Store snapshot or publish should not run after partial Source Sync failure unless the caller explicitly opts into partial publication.
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
- A **Workspace Scope Resolver** selects the Workspace Scope before Workspace Tools or model-facing Workspace-backed instructions are exposed.
- A **Workspace Scope Resolver** can read trusted host, auth, and invocation context, but it does not use model output as authority.
- A **Workspace Scope Resolver** can select a static named Workspace Scope or return an inline Workspace Scope definition for invocation-specific grants.
- Workspace Scope is read-only in the first version.
- Generic scoped Workspace Scope does not expose source materialization in the first version; **Harness Workspace Session** is the narrow materialized-session exception for harness-backed Agent Drivers.
- An out-of-scope Workspace path is a **Scope-Masked Miss** to the model.
- A **Scope-Masked Miss** can be recorded in server-side audit or tracing without revealing the hidden path to the model.
- An Agent Invocation uses one **Selected Workspace Scope** by default.
- **All-Scopes Workspace Scope** is explicit and privileged; it is not the default result of a user belonging to multiple scopes.
- A missing **Selected Workspace Scope** fails the Agent Invocation unless the developer declared a **Default Workspace Scope**.
- A **Default Workspace Scope** is explicit configuration and never implies **All-Scopes Workspace Scope**.
- A **Workspace Session** starts from a Workspace runtime surface and may use a Sandbox provider behind the boundary.
- A **Harness Workspace Session** starts after the **Selected Workspace Scope** is resolved, so harness-backed Agent Drivers see only scoped Workspace state.
- A **Harness Workspace Session** is invocation-scoped by default.
- A **Harness Workspace Session** is reused across Agent Invocations only when a driver option or Capability provides an explicit **Harness Session Key**.
- A **Harness Session Key** is not inferred from Chat Session, Chat History, Agent Run thread id, or Agent Invoker by default.
- Harness-backed Agent Drivers receive Workspace state through a **Harness Workspace Session** or equivalent materialized filesystem, not model-facing **Workspace Tools** by default.

## Example Dialogue

> **Dev:** "Should we rename `workspace.sources` to `workspace.mounts`?"
> **Domain expert:** "No. A **Source** is the origin. The **Mount** only says where that source appears inside the **Workspace**."

## Flagged Ambiguities

- "source" can mean source code, provenance, or data connector - resolved: in Workspace, **Source** means a named origin that exposes read-only addressable files or items.
- "source instructions" were considered source descriptions or generic metadata - resolved: use **Source Instruction** for model-facing guidance about how a model-backed Agent Driver should use a Source.
- Dynamic Source Instructions were considered - resolved: **Source Instructions** may be produced by **Invocation-Scoped Source Resolution** when the guidance describes the resolved Source itself; invocation-specific audience or behavior guidance still belongs in model-backed driver or Capability instructions.
- Unplaced Source Instructions were considered explicit-placement-only - resolved: append visible Source Instructions by default at the end of model-backed driver instructions, while allowing explicit placement.
- Empty Source Instruction placement was considered for an explanatory fallback - resolved: render empty instructions so hidden or scoped-out Sources are not implied.
- Custom heading ownership for Source Instruction placement was considered - resolved: the generated Source guidance block includes its own heading.
- Generated Source descriptions and Mount summaries were considered for each Source Instruction entry - resolved: when a Source declares **Source Instructions**, render the Source Map key heading plus the declared instructions only.
- Inferring **Source Instructions** from provider metadata such as GitHub repository descriptions was considered - resolved: do not infer prompt text from provider metadata in the first version.
- Rendering every visible Source in the generated Source guidance block was considered - resolved: only Sources with explicit **Source Instructions** appear.
- Query-only access to external information was considered a Source shape - resolved: arbitrary query tools remain outside Source, while API-backed **Request-Only Sources** are valid only through **Source Request Shape**, **Source Request Descriptor**, and **Source Network Grant** boundaries.
- API-backed Sources without useful default data files were reconsidered - resolved: allow **Request-Only Sources** when they expose a scoped **Source Request Descriptor** and **Source Network Grant**.
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
- API-backed Source `path` was considered for Workspace placement - resolved: use **Source Workspace Path** language and `workspacePath` so it does not collide with HTTP paths or Source Package paths.
- Single-file Sources were considered source-key mounted by default - resolved: **Single-File Sources** root-mount by default; source-key mounting is explicit.
- Workspace inspection was considered a separate Workspace Capability - resolved: **Workspace Tools** are derived from the Workspace Definition by default.
- Model-facing **Workspace Tools** were considered the default Workspace surface for harness-backed Agent Drivers - resolved: use a scoped **Harness Workspace Session** or equivalent materialized filesystem by default.
- Durable harness sessions were considered as an implicit chat or thread default - resolved: **Harness Workspace Sessions** are invocation-scoped by default and require an explicit **Harness Session Key** for reuse.
- Local and provider Source helpers were considered separate public namespaces - resolved: use one **Source Namespace** for all public Source authoring helpers.
- Workspace write authority was considered as `allowWrite: true` - resolved: use **Workspace Access Mode** language such as `mode: "write"` instead of a permission boolean.
- Per-user or per-customer context filtering was considered as instruction-only behavior - resolved: use **Workspace Scope** for the trusted runtime visibility boundary.
- Multi-scope visibility was considered as a default merged view - resolved: use one **Selected Workspace Scope** by default, with **All-Scopes Workspace Scope** as an explicit privileged mode.
- Out-of-scope paths were considered for permission-denied tool feedback - resolved: return model-facing not-found behavior as a **Scope-Masked Miss** to avoid leaking hidden paths.
- Workspace Scope write grants were considered for the first version - resolved: keep Workspace Scope read-only until read isolation is proven.
- `workspaceScope()` was considered as the Capability helper name - resolved: keep **Workspace Scope** as Workspace language and use `access()` for the broader Capability.
- Ambient `workspaceScope` invocation context was considered as authority - resolved: require an explicit **Workspace Scope Resolver** or **Default Workspace Scope**.
- Static pre-registration for every customer scope was considered necessary - resolved: use inline Workspace Scope definitions from the **Workspace Scope Resolver** when grants are derived from trusted invocation context.
- Source materialization under scoped access was considered for the first version - resolved: disable generic materialization for scoped V1 to avoid source metadata leakage, with **Harness Workspace Session** as the narrow harness-backed Agent Driver exception.
- Source-level narrowing was considered as direct invoker access - resolved: use **Invocation-Scoped Source Resolution** from trusted invocation context and the **Selected Workspace Scope**, not raw model-facing metadata or duplicate authorization logic inside a Source.
- Source Instructions were considered as network policy for shell `curl` - resolved: use **Source Network Grants** for authority and **Source Instructions** only for model guidance.
- OpenAPI operations were considered as the first public request language for API-backed Sources - resolved: use **Source Request Shape** for the Source-owned boundary, with OpenAPI left as a possible future import/export format.
- Plain examples were considered for Source Request Shapes - resolved: require Standard Schema-compatible schemas so request enforcement has a validation boundary.
- Validation-only Standard Schema was considered enough for the **Source Request Descriptor** - resolved: request validation uses Standard Schema-compatible schemas, while model-visible request guidance requires a Standard JSON Schema-compatible **Source Request Schema Projection**.
- Allowing both concrete request values and schema-backed inputs for the same request part was considered - resolved: use a **Source Request Part Branch** so `query`/`body` and `querySchema`/`bodySchema` are mutually exclusive.
- Requiring a separate default request beside schema-backed request parts was considered - resolved: use a **Schema-Derived Default Request** for Source-Backed Path reads, and fail clearly when schema defaults cannot produce one.
- A nested credentials option was considered for injected headers and cookies - resolved: use Fetch-style option names and avoid overloading credentials language.
- Copying ofetch-style hooks was considered - resolved: borrow stable request option vocabulary, but keep public hooks deferred to a future extension boundary.
- Duplicating request mechanics in Source Instructions was considered - resolved: let **Source Request Shapes** generate mechanical request guidance and keep **Source Instructions** for domain-specific guidance.
- Response validation was considered for API-backed Sources - resolved: keep the first request-shaped `source.fetch()` design request-side only.
- Controlled shell request output was considered for automatic Source materialization - resolved: keep `curl` output ephemeral by default and leave materialization to explicit Workspace policy.
- A new Workspace template slot for controlled `curl` descriptors was considered - resolved: reuse existing Capability instruction slot templating through the `workspaceShell()` Capability contribution.
- Method-neutral Source Request Shapes were considered - resolved: make **Source Request Shape** method-aware so bodies are not allowed on methods that do not support bodies.
- Supporting write-semantics HTTP methods in request-shaped Sources was considered - resolved: v1 supports `GET`, `HEAD`, and `POST`; methods such as `PUT`, `PATCH`, and `DELETE` belong to Capabilities or a future effect boundary.
- Treating headers and cookies as model-authored request schema fields was considered - resolved: use injected **Source Request Credentials** for headers and cookies, and do not expose secret values to the model.
- Separate credentials for Source reads and controlled shell requests were considered - resolved: use the same **Source Request Credentials** by default.
- Zero-argument-only request factories were considered - resolved: allow a **Source Request Callback Context** so credential factories can inspect the final validated request and trusted invocation/runtime context.
- Full `source.fetch(() => options)` factories were considered - resolved: keep Source definitions static and restrict request factories to execution-only request additions.
- A single scoped request index was considered - resolved: generate one **Source Request Descriptor** per visible API-backed Source at `.vitehub/sources/<sourceKey>.json`.
- Custom request syntax for controlled shell commands was considered - resolved: keep normal command syntax and validate the resulting request against the **Source Request Shape**.
- Build-time Workspace assets were considered a second user-facing read surface - resolved: users read one **Workspace File Tree** while asset provenance remains internal by default.
- `open()` was considered as the Workspace execution-session method - resolved: use `startSession()` because it names the **Workspace Session** lifecycle.
- "explicit sync source" was considered as a Source kind - resolved: keep **Source Sync** as a Workspace lifecycle operation over existing Sources.
- Source Sync snapshot and publish defaults were considered part of Source reconciliation - resolved: keep low-level **Source Sync** focused on Source reconciliation, with Store snapshot and publish as explicit composed lifecycle behavior.
- Source Sync eligibility was considered as a new `materialize` mode - resolved: use **Source Sync Policy** so `materialize` can remain focused on build-time or read-triggered materialization, while the policy remains orthogonal for Sources that support both.
- Treating the common Source Sync case as a Source kind was considered - resolved: describe it as a Source with **Source Sync Policy** and no build-time or read-triggered materialization.
- Stale Source-Backed Path removal was considered a default Source Sync behavior - resolved: keep stale paths by default and require **Source Sync Policy** opt-in plus source-owned path proof and complete enumeration or authoritative delete events.
- Reusing normal Source listing for deletion-safe Source Sync enumeration was considered - resolved: use **Source Sync Inventory** so Live Source listing and Source Sync enumeration can remain separate contracts.
- Adding a separate `getSyncInventory` method for custom Sources was considered for v1 - resolved: let sync-eligible Workspace Source Bindings use `getKeys` and `getItem` as the default Source Sync Inventory contract, with complete enumeration required only when stale removal is enabled.
- Returning raw upstream identities from Source Sync Inventory was considered - resolved: **Source Sync Inventory** returns Workspace-facing items so Source Sync can reconcile the Workspace file tree directly.
- Persisting every Source Sync run in Workspace was considered - resolved: persist compact **Source Sync State** per Source, while callers receive full run results and Schedule or Store keep their own histories.
- A separate Source Sync target registry was considered for Schedule integration - resolved: v1 Schedule handlers can call **Source Sync** directly.
- Publishing partial Source Sync results was considered as a default - resolved: do not snapshot or publish after partial Source Sync failure unless the caller explicitly opts into partial publication.
- Path-level Source Sync results were considered as the default - resolved: **Source Sync Result** returns per-source counts by default and includes path-level details only when explicitly requested.
- `include` was considered for Source Sync Result detail selection - resolved: use a single result detail axis with summary output by default and path-level detail as opt-in.
- Separate snapshot and publish lifecycle methods were considered mandatory for Source Sync - resolved: a composed Source Sync lifecycle may use explicit snapshot options and a boolean publish option.
- Implicitly syncing every eligible Source when no Source selection is provided was considered - resolved: require explicit Source selection, with an explicit all-eligible selection for broad Source Sync.
- A separate Source Sync lifecycle verb was considered - resolved: run **Source Sync** through the Workspace sync lifecycle with explicit Source selection instead of introducing a second sync verb.
- No-argument Workspace sync was considered for compatibility with existing build-source synchronization - resolved: the target Workspace sync lifecycle requires explicit selection and does not keep no-argument sync semantics.
- Build-time Source materialization through Workspace sync was considered - resolved: build and dev integrations own build-time materialization through the **Workspace Asset Surface**, while Workspace sync owns explicit **Source Sync**.
- Treating Airtable as an official Workspace Source helper was considered - resolved: Airtable remains a downstream/custom Source example unless the Workspace Package explicitly adds an official adapter.
- Treating Workspace Source declarations as raw Source Definitions was considered - resolved: use **Workspace Source Binding** for Workspace-owned placement, instructions, materialization, validation, and Source Sync Policy around Source Package retrieval.
- Treating `source.<helper>` as the preferred Source authoring style was considered - resolved: prefer named Source Loader imports from the Source Package, with **Source Namespace** as a convenience only.
- Requiring every Workspace Source declaration to wrap a `source` field was considered - resolved: use **Workspace Source Binding Input** so unambiguous plain objects can infer a Source Loader while reusable or custom Source Definitions remain explicit.
- Permissive plain-object Source inference was considered - resolved: use strong TypeScript input types and runtime normalization errors so ambiguous Source Loader option combinations fail clearly.
- Adding project-specific file consumers to Source Sync was considered - resolved: Source Sync owns durable Workspace file-tree reconciliation, while downstream file consumption remains project composition.
