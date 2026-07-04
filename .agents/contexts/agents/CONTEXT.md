# Agents

Agents names definitions, invocations, and runtime state for server actors driven by Agent Drivers.

## Language

**Agent**:
A named server-side actor that receives inputs, is driven by an Agent Driver, and may attach Capabilities.
_Avoid_: Bot, chat definition, workflow

**Agent Definition**:
The code declaration that names an Agent and configures its Channels, Workspace, Capabilities, Agent Actor, and Agent Driver.
_Avoid_: Chat definition, server route

**Agent Driver**:
The Agent Definition boundary that selects and configures how an Agent Invocation is driven, such as a model-backed loop or harness-backed execution.
_Avoid_: Adapter, runtime, top-level model selector, top-level harness selector, driver factory wrapper, root run callback

**Model Driver Instructions**:
Model-facing instruction text or callbacks configured on a model-backed Agent Driver and composed before the model call.
_Avoid_: Root Agent Definition instructions, harness instructions, workspace `AGENTS.md`

**Instruction Document**:
Markdown authored for an Agent and rendered through ViteHub Instruction Composition into model-facing instructions.
_Avoid_: Prompt config, raw system prompt, model adapter prompt

**Instruction Composition**:
The ViteHub-owned render pass that expands deterministic Markdown imports, evaluates safe `context.*` conditions, resolves explicit `context.*` and `workspace.*` bindings, records Source/Capability/Skill coverage wrappers, and strips those wrappers before model execution.
_Avoid_: Prompt templating engine, arbitrary JavaScript, access policy

**Explicit Instruction Coverage**:
A declared relationship in Agent Driver Instructions or deterministic imported instruction Markdown that says a configured Source, Capability, or Skill is intentionally covered by model-facing guidance.
_Avoid_: Ambient system instructions, discoverable file, implicit prompt append

**Instruction Binding**:
The authored marker or placement in an Instruction Document that binds a configured Source, Capability, or Skill to explicit instruction prose or a deterministic imported instruction file.
_Avoid_: Source metadata, Capability metadata, tool description, Workspace file discovery

**Instruction Coverage Diagnostic**:
A DevTools, build, or metadata warning that a configured Source, Capability, or Skill is available to an Agent but lacks Explicit Instruction Coverage.
_Avoid_: Model-facing warning, access error, tool schema validation

**Agent Model Execution**:
The model-backed Agent Driver boundary for `execution` settings such as model call settings, step limits, workspace fallback behavior, and model execution instrumentation.
_Avoid_: Adapter options, provider options, passthrough

**Agent Harness Driver Contract**:
The ViteHub-owned contract implemented by harness-backed Agent Drivers, including how a harness receives invocation input, workspace access, lifecycle events, streams, approvals, and telemetry.
_Avoid_: AI SDK HarnessAgent as public boundary, raw harness adapter, provider-owned Agent Driver

**Harness Permission Policy**:
The ViteHub-owned policy for whether a harness-backed Agent Driver uses adapter-level approval prompts or bypasses them.
_Avoid_: Provider permission stack, hidden adapter approvals, two-layer approval policy

**Harness Credential Source**:
The resolved credential and billing identity source for a harness-backed Agent Driver, such as explicit driver credentials, adapter-default ambient auth, or a no-credentials-required harness.
_Avoid_: Required credential object, hidden cost owner, provider-specific env helper

**Agent Model Execution Instrumentation**:
Invocation-scoped hooks that wrap the resolved model or adjust model call settings before an Agent Invocation calls the model.
_Avoid_: Agent Invocation Lifecycle hooks, adapter middleware, provider wrapper

**Agent Invocation**:
One runtime request to an Agent.
_Avoid_: Chat message, webhook call

**Agent Invocation Stream**:
The ordered structured event stream produced while one Agent Invocation runs and consumed by terminal, DevTools, HTTP clients, tests, or CI.
_Avoid_: Agent Invocation Lifecycle, DevTools state, chat transcript, raw model stream

**Agent Invocation Stream Endpoint**:
The development-server HTTP surface that exposes Agent Invocation Stream events to development clients.
_Avoid_: DevTools Bridge, chat state endpoint, webhook

**Agent Invocation Stream Format**:
The wire format used by an Agent Invocation Stream Endpoint to deliver Agent Invocation Stream events.
_Avoid_: DevTools state format, raw model stream format, trace log format

**Agent Trigger**:
The lower-level server-side primitive that maps a product event into an Agent Invocation.
_Avoid_: Channel, Chat adapter, client integration, model adapter

**Agent Trigger Payload**:
The JSON-shaped event input passed to one Agent Trigger before that trigger maps it into an Agent Invocation.
_Avoid_: Agent Definition dev config, Agent Invocation Context Values file, DevTools meta, dev samples, preset

**Channel**:
A host or integration entry surface through which Agent Invocations are triggered, such as HTTP, Stream, Slack, Teams, Telegram, Discord, CLI, DevTools, or Web Chat. It owns delivery coordination and caller mapping for that surface.
_Avoid_: Agent Actor, Agent Trigger, Chat Platform Adapter, Auth User

**Channel ID**:
The stable id for one Channel declared on an Agent Definition.
_Avoid_: Agent name, Agent Actor id, Agent Run Origin, thread id, platform id

**Channel Kind**:
The reusable Channel family named by what reaches the Agent, such as GitHub, Slack, Teams, Telegram, Discord, Stream, Web Chat, HTTP, CLI, or DevTools.
_Avoid_: Channel ID, Chat Channel, Chat Platform Adapter, product lane

**Channel Definition Helper**:
A helper, such as `defineChannel()`, that returns a Channel Definition for use inside `defineAgent({ channels })`, including custom Channel helpers built by application or integration code.
_Avoid_: Filesystem channel registration, Capability factory, route helper

**GitHub Channel**:
An official Channel Kind for verified GitHub App or webhook delivery into Agent Invocations, plus reusable pull-request delivery facts and write-back effects.
_Avoid_: Quiver Review behavior, browser review command, GitHub Capability

**GitHub Pull Request Context**:
The typed Agent Invocation Context Value produced by GitHub pull-request comment delivery, containing repository, pull-request source, triggering comment, run metadata, and trusted delivery facts.
_Avoid_: Raw webhook payload, app-cast metadata, GitHub Capability

**Stream Channel**:
An official Channel Kind for app-owned HTTP UI-message stream entry into an Agent, such as Portal Ask AI.
_Avoid_: sibling chat route helper, Web Chat, Chat Platform Adapter

**Channel Delivery Admission**:
The Channel-owned protocol acceptance or rejection of an incoming delivery before or while it is mapped into an Agent Invocation.
_Avoid_: Access Capability, Agent Actor resolution, user-visible feedback, model output

**Channel Delivery Effect**:
A Channel-owned platform-native effect that communicates delivery progress, state, or final output back on the external surface that triggered the Agent Invocation.
_Avoid_: Channel Delivery Admission, Agent Finish Hook, Capability hook, result comment, model output

**Channel Delivery Effect Intent**:
A platform-neutral request for the current Channel delivery to apply a user-visible Channel Delivery Effect if the Channel supports it.
_Avoid_: Platform API call, arbitrary Channel operation, generic Capability output, cross-delivery side effect

**Custom Channel**:
A Channel declared for an app-owned product event or bespoke transport when no official Channel fits.
_Avoid_: Entry Capability, route helper, trigger helper, generic Capability

**Agent Invocation Lifecycle**:
The ordered runtime moments that occur while one Agent Invocation is processed.
_Avoid_: Capability Lifecycle, chat event hooks, request middleware

**ViteHub Hook System**:
The shared hook machinery, naming conventions, and inspection model used by owner-scoped Agent, Channel, Capability, Runtime, and integration hooks.
_Avoid_: Global mutation bus, arbitrary event bus, Capability Lifecycle replacement

**Hook Observer**:
A read-only listener for inspectable hook activity across ViteHub owners.
_Avoid_: Channel hook, Capability hook, Agent Finish Hook, Trace Event

**Agent Finish Hook**:
The final Agent Invocation Lifecycle hook for observing the completed invocation outcome.
_Avoid_: onUsage, onRecord, afterRun

**Agent Error Message**:
The normalized failure message exposed on a failed Agent Invocation lifecycle event for reporting or logging.
_Avoid_: Result value, exception wrapper, error detail object

**Agent Invocation Extension**:
Capability-owned data attached to an Agent Invocation Lifecycle event without becoming a top-level lifecycle field.
_Avoid_: Event metadata, arbitrary event fields, built-in usage field

**Agent Eval**:
A repeatable development check that runs an Agent Definition against one or more cases and scores the resulting Agent Invocations.
_Avoid_: Benchmark, unit test, arena

**Agent Run State**:
Runtime state created while an Agent Invocation is being processed.
_Avoid_: Chat state, workflow state

**Agent Run Origin**:
Host-provided Agent Run metadata naming where an Agent Invocation came from, such as `http`, `devtools`, or a Chat Platform name. It is first-class invocation provenance, not Chat context.
_Avoid_: Platform, Agent Trigger, runtime, Chat state

**Agent Run Channel**:
Agent Run metadata that records the configured Channel ID and Channel Kind that triggered an Agent Invocation.
_Avoid_: Platform channel id, thread id, Agent Run Origin

**Agent Run Platform Context**:
Agent Run metadata for platform-native conversation and event identifiers, such as Slack channel ids, Teams conversation ids, Discord interaction ids, or Telegram chat ids.
_Avoid_: Channel ID, Agent Actor, Agent Run Origin

**Chat History**:
Ordered conversational messages for one chat interaction with an Agent.
_Avoid_: Agent Memory, Agent Run State

**Chat History Window**:
The bounded number of prior Chat History messages included in an Agent Invocation.
_Avoid_: memory size, transcript limit, context length

**Chat Trigger History**:
Message Channel Settings configured through `triggerHistory` that select the Chat History Window for one `chat.message` Agent Trigger input.
_Avoid_: Thread History Cache, Agent Memory, full transcript

**Chat Thread History Cache**:
Adapter backfill and cache behavior configured through `threadHistory` for platforms that cannot reliably provide recent thread messages at trigger time.
_Avoid_: Chat Trigger History, Agent Memory, model context

**Chat Session**:
A host-visible conversation boundary inside Chat History that determines which messages are eligible for the Chat History Window.
_Avoid_: Agent Memory, Agent Run State, hidden slice

**Message Channel Settings**:
Agent Definition settings shared by message-shaped Channels, such as Chat History, Chat Session, and overlapping message delivery behavior.
_Avoid_: Channel defaults, runtime input messages, Agent Memory

**Agent Actor**:
The trusted principal for one Agent Invocation, shaped as a stable `id`, optional `kind`, optional display `label`, and application-owned `meta`, exposed to callbacks as `context.actor`.
_Avoid_: Auth User, Channel, Agent Trigger, Access Role, Chat Platform Caller Facts, model-facing user profile

**Agent Invoker**:
The legacy name for Agent Actor, currently visible through `context.invoker`, `defineAgent({ invoker })`, and related compatibility APIs while the public language migrates.
_Avoid_: New public identity language, Channel Actor, Agent Trigger, Auth User

**Agent Invoker Profile**:
A static selectable Agent Actor profile currently declared through the legacy `defineAgent({ invoker: { profiles } })` API, mainly for development selection and trusted app routing.
_Avoid_: Invocation Profile, Access Role, dynamic profile Capability

**Agent Invocation Context Value**:
A typed value recorded for one Agent Invocation and exposed to later Agent and Capability callbacks through invocation context access.
_Avoid_: Runtime Config, Agent Memory, dynamic Capability, arbitrary metadata

**Agent Memory**:
Durable knowledge or preferences an Agent can carry across Agent Invocations when explicitly configured.
_Avoid_: Chat History, better chat state

**Concurrent Invocation Guard**:
Internal Agent behavior that prevents overlapping invocations from mutating the same Agent Run State.
_Avoid_: Public lock API, Capability

**Development State Provider**:
An in-memory or local provider used only for single-process Agent development.
_Avoid_: Production state provider, durable coordination

**Agent Usage**:
Normalized driver usage information produced by an Agent Invocation, including token counts when available and provider- or harness-reported usage details.
_Avoid_: Metadata, metrics

**Agent Usage Telemetry**:
Runtime measurement of an Agent Invocation's driver usage, latency, throughput, and cost context.
_Avoid_: Metadata, chat analytics, generic observability

**Agent Usage Record**:
The final completed accounting record captured after one Agent Invocation finishes, combining Agent Usage with selected Agent Driver, response, latency, and optional cost information.
_Avoid_: Live stream event, token log

**Agent Usage Summary**:
An app-facing formatted summary derived from an Agent Usage Record for humans reading delivery output.
_Avoid_: raw Agent Usage Record, hardcoded Channel footer, billing ledger

**Mock Agent Adapter**:
A deterministic Agent Adapter that exercises Agent Invocation behavior without calling a paid model provider.
_Avoid_: Fake agent, dummy model, test bot

## Relationships

- An **Agent Definition** declares one **Agent**.
- An **Agent Definition** has one **Agent Driver**.
- An **Agent Driver** is configured as one object on the Agent Definition, with exactly one concrete driver key such as `model`, `harness`, or `run`.
- The concrete **Agent Driver** key holds the implementation value directly; driver-specific options are sibling fields on the same driver object.
- **Agent Driver** variants are mutually exclusive; one driver object cannot combine `model`, `harness`, or `run`.
- An **Agent Driver** may be model-backed, harness-backed, or custom-run-backed.
- A model-backed **Agent Driver** uses the AI SDK model execution path when it uses a model.
- A model-backed **Agent Driver** may configure **Model Driver Instructions**.
- **Model Driver Instructions** may be authored as an **Instruction Document**.
- **Model Driver Instructions** own **Explicit Instruction Coverage** for configured Sources, Capabilities, and Skills.
- **Instruction Bindings** must live in Agent Driver Instructions or deterministic imported instruction Markdown; merely discoverable Workspace files do not establish **Explicit Instruction Coverage**.
- **Instruction Composition** reads only explicit **Agent Invocation Context Values** through `context.*` paths.
- **Instruction Composition** does not execute arbitrary JavaScript and does not grant **Capabilities**, **Workspace Scope**, Source visibility, or runtime access.
- **Instruction Composition** may render bound Source, Capability, and Skill guidance, but it should not append free-form primitive prose merely because the primitive is configured.
- **Instruction Coverage Diagnostics** warn in DevTools, build, or generated metadata when a configured Source, Capability, or Skill is available without **Explicit Instruction Coverage**.
- Tool descriptions and schemas are structured tool contracts; they do not become arbitrary system instruction injection and they do not clear **Instruction Coverage Diagnostics** by themselves.
- An **Agent Trigger Payload** belongs to the trigger consumer for one run; it is not authored on an **Agent Definition**.
- An **Agent Trigger** owns mapping an **Agent Trigger Payload** into trusted **Agent Invocation Context Values**, **Agent Run** metadata, and delivery behavior.
- **Agent Definitions** should not carry development-only payload examples such as `dev.samples` or `devtools.meta`.
- A model-backed **Agent Driver** uses `execution` for **Agent Model Execution** settings.
- A harness-backed **Agent Driver** does not receive **Model Driver Instructions** as a system prompt by default.
- Harness-backed instruction behavior should rely on explicit harness or Workspace instruction surfaces, such as workspace `AGENTS.md`, unless a future harness-specific option is introduced.
- A harness-backed **Agent Driver** implements the **Agent Harness Driver Contract**.
- V1 harness-backed **Agent Drivers** use a single active permission layer: ViteHub-owned Workspace and runtime boundaries.
- V1 **Harness Permission Policy** defaults to bypassing adapter-level approval prompts by configuring the harness adapter to its most permissive no-approval mode when the adapter supports one.
- V1 exposes `driver.permissionMode` as a narrow harness-backed **Agent Driver** override when a harness adapter needs a less permissive no-approval mode.
- For the current AI SDK harness adapter, V1 should default to `permissionMode: "allow-all"` behind the ViteHub harness adapter boundary.
- A harness adapter that cannot bypass its own approval layer should be unsupported for V1 rather than introducing a second hidden permission layer.
- V1 should not enable host-executed HarnessAgent approval flows for harness-backed Agent Drivers; approval-based policy is a future design.
- A harness-backed **Agent Driver** receives Workspace state through a scoped **Workspace Session** or equivalent materialized filesystem, not model-facing Workspace Tools by default.
- A harness-backed **Agent Driver** may receive Capability support files through **Harness Workspace Path Contributions** without treating those files as **Model Driver Instructions**.
- A harness-backed **Agent Driver** uses an invocation-scoped Harness Workspace Session by default and requires an explicit Harness Session Key for durable reuse.
- A harness-backed **Agent Driver** may omit `credentials`; omitted credentials let the harness adapter use its default credential behavior, such as ambient CLI auth or no credentials when the harness does not require them.
- Explicit **Harness Credential Source** configuration is a sibling option on the harness-backed **Agent Driver**, not hidden inside the harness adapter constructor.
- Explicit deployable **Harness Credential Sources** should read secret material through Env Package **Server Env** and **Secret Env** instead of provider-specific env helper namespaces.
- A harness-backed **Agent Driver** should classify the resolved **Harness Credential Source** for diagnostics and telemetry when the adapter can report it.
- Development diagnostics should warn when omitted harness credentials resolve to an unknown or local-only **Harness Credential Source**.
- Hosted production should fail when omitted harness credentials resolve to an unknown or known local-only **Harness Credential Source**.
- Hosted production may proceed when omitted harness credentials resolve to an adapter-classified deployable source or a no-credentials-required harness.
- AI SDK `HarnessAgent` support is an implementation adapter behind the **Agent Harness Driver Contract**, not the public ViteHub Agent Driver boundary.
- A custom-run-backed **Agent Driver** invokes developer code directly through `run`.
- A custom-run-backed **Agent Driver** may call a model or harness internally, but ViteHub treats the public Agent Driver as custom-run-backed unless a future explicit composition primitive says otherwise.
- **Agent Model Execution** belongs to a model-backed Agent Driver and is not an adapter boundary.
- **Agent Model Execution Instrumentation** is lower-level Agent execution behavior and should not become root Agent Definition fields.
- **Agent Driver** is not a Capability, Agent Trigger, Chat Platform Adapter, or host runtime.
- Workspace plus Capability composition without an **Agent Driver** is not an **Agent Definition**.
- Capabilities attach above the **Agent Driver** and may expose driver-specific **Capability Driver Contributions**.
- An **Agent** receives zero or more **Agent Invocations**.
- An **Agent Invocation Stream** belongs to one **Agent Invocation**.
- An **Agent Invocation Stream Endpoint** exposes an **Agent Invocation Stream** without becoming a **DevTools Bridge**.
- The V1 **Agent Invocation Stream Endpoint** can invoke plain discovered **Agent Definitions** directly and can still consume the legacy `chat.message` **Agent Trigger** for message-shaped Channels.
- The V1 **Agent Invocation Stream Format** is newline-delimited JSON.
- The Agent Package owns the **Agent Invocation Stream Format** helpers used by development clients.
- An **Agent Invocation Stream** is not the **Agent Invocation Lifecycle**; lifecycle hooks observe runtime moments.
- An **Agent Invocation Stream** is the client-facing Agent Invocation event stream; Runtime Package **Trace Events** are the local observability record and may observe the same invocation without becoming the stream contract.
- Agent Invocation content can appear in the **Agent Invocation Stream** without being persisted into the Runtime Package **Trace Event Log**.
- Text deltas and other high-frequency **Agent Invocation Stream** events are not Runtime Package **Trace Events** by default.
- **Agent Model Execution Instrumentation** may feed Runtime Package **Trace Events**, but provider-specific telemetry should not become the Agent Package observability vocabulary.
- An **Agent Trigger** starts one or more **Agent Invocations** as the lower-level invocation primitive behind Channels and Capability-owned product events.
- An **Agent Trigger** prepares **Agent Run State** and **Chat History** when the product event needs them.
- An **Agent Trigger** may provide message-shaped input, but message-shaped input is not required for every Agent Trigger.
- An **Agent Trigger** may pass host or client intent with the Agent Invocation, but it does not grant Capabilities dynamically.
- An **Agent Trigger** is registered by a Channel when the trigger belongs to reachability, or by a Capability when it belongs to a Capability-owned product ability.
- Channels use one generic Agent Trigger contract; message-shaped Channels add Message Channel Settings on top instead of using a separate trigger contract.
- An **Agent Trigger** is not **Agent Model Execution**.
- An **Agent Trigger** is not a **Chat Platform Adapter**; Chat Platform Adapters receive platform events, while Agent Triggers start Agent Invocations.
- An **Agent Definition** declares the **Channels** through which its **Agent Invocations** can be triggered.
- **Channel IDs** are unique within one **Agent Definition** and stable enough for generated routes, DevTools, Agent Run metadata, admission, rate limits, and identity mapping.
- A **Channel ID** names one configured Channel; a **Channel Kind** names what kind of entry path reaches the Agent.
- In `defineAgent({ channels })`, object keys are **Channel IDs** and helper functions identify **Channel Kinds**.
- Channels are declared from the **Agent Definition**; ViteHub does not use filesystem channel registration as the primary Channel API.
- `defineChannel()` is the public **Channel Definition Helper** for custom Channels.
- Official **Channel Kind** helpers are thin wrappers around the same Channel Definition shape that `defineChannel()` returns.
- `defineAgent({ messages })` configures **Message Channel Settings** shared by message-shaped Channels; it does not declare runtime invocation messages.
- Per-Channel message-shaped overrides live under that Channel's own `messages` option.
- **Message Channel Settings** do not configure identity mapping; each concrete **Channel** maps trusted caller data into an **Agent Actor**.
- **Message Channel Settings** may configure a default overlapping-message concurrency policy; platform rate limits, webhook retries, and provider delivery quotas stay on concrete **Channels**.
- A **Channel** is where an **Agent Invocation** is triggered; an **Agent Actor** is who is trusted for that invocation.
- A **Channel** may use an **Agent Trigger** to start an **Agent Invocation**, but it is not the trigger itself.
- A **Channel** owns adapter and webhook wiring, delivery policies such as locks, dedupe, and concurrency, platform state, and Agent Actor mapping.
- Channel webhook delivery can use generated Agent Package **Agent Webhook Routes** without making non-chat Channels message-shaped or Chat Platform Adapters.
- A **Channel** can resolve an **Agent Actor**, but it does not own identity; Auth, trusted app routing, subagents, schedules, or fallback runtime behavior may also seed the Agent Actor.
- **Channel Delivery Admission** belongs to the **Channel** because protocol-level delivery acceptance, rejection, and retry semantics are owned by the external surface that triggered the Agent Invocation.
- A generated message-shaped **Channel** route may copy request body `meta`, `user`, or `session` into `chat.message` input only when **Channel Delivery Admission** authenticates the request and explicitly trusts those fields.
- Server-derived **Channel Delivery Admission** context runs after trusted request input so it can enrich or override client-provided message context before the **Agent Trigger** starts.
- **Channel Delivery Effects** belong to the **Channel** because they communicate delivery progress or state back on the same external surface that triggered the Agent Invocation.
- **Channel Delivery Effects** may use generic effect kinds such as reactions, replies, or statuses; platform-prefixed names belong to Channel implementation details or examples, not the shared effect vocabulary.
- A Capability may contribute a **Channel Delivery Effect Intent** for the current delivery, but the active **Channel** owns whether and how that intent becomes a **Channel Delivery Effect**.
- A **Channel Delivery Effect Intent** must not address arbitrary platform objects, call platform APIs directly, or assume the active **Channel** supports a requested effect kind.
- Unsupported **Channel Delivery Effect Intents** are ignored with inspectable trace metadata rather than failing the **Agent Invocation**.
- A **Custom Channel** is the root Agent Definition replacement for the old Entry Capability idea.
- App-owned product events use **Custom Channels** when the concern is Agent reachability rather than a reusable Agent ability.
- A **GitHub Channel** owns reusable GitHub delivery, verification, event facts, installation context, actor mapping, Channel Delivery Admission, and supported Channel Delivery Effects for triggering events; product-specific commands and artifacts stay app-owned.
- A **GitHub Channel** trigger receives verified GitHub delivery facts from generated webhook routing. App code owns product-specific admission such as command filtering and trusted actor checks, while first-party helpers may parse pull-request comment command facts and let app handlers accept, reject, or enrich the run input before the Agent runs.
- A **GitHub Channel** exposes **GitHub Pull Request Context** as a typed **Agent Invocation Context Value** so Workspace Source resolvers and app admission code do not parse or cast raw webhook payloads.
- GitHub pull-request write-back should use generic **Channel Delivery Effects** such as reactions, replies, and statuses instead of GitHub-prefixed Capability APIs.
- Official **Channel Kinds** should name concrete entry paths rather than a generic Chat Channel.
- Official **Channel Kind** helpers are imported from `@vite-hub/agent/channels`, not from the Agent Package root or Capabilities entry.
- A **Stream Channel** owns generated AI SDK UI-message stream route metadata and optional trusted input mapping for app-owned surfaces such as Portal Ask AI.
- A **Stream Channel** can supply generated chat route options through `stream({ route })`; sibling `chatRoute` exports are compatibility overrides, not the preferred Channel API.
- Message-shaped **Channel Kinds** keep the existing chat delivery behavior, including Chat Platform Adapters, webhook wiring, locks, dedupe, concurrency, platform state, and identity mapping.
- An **Agent Invocation** follows one **Agent Invocation Lifecycle**.
- The **ViteHub Hook System** applies across Agent, Channel, Capability, Runtime, and integration owners through shared machinery and conventions, not through one public writable hook bus.
- Public hook registration stays scoped to the owner that controls the lifecycle and allowed effects.
- A **Hook Observer** may inspect cross-owner hook activity, but it must not mutate Channel delivery, Agent Invocation input, Capability contributions, Runtime policy, or model output.
- **Hook Observers** start as inspection and DevTools behavior; plugin observers may use the same read-only observer contract once the plugin boundary is clear.
- **Hook Observer** failures are isolated and logged or traced; they never affect **Agent Invocation** control flow.
- **Hook Observers** see structured, redacted hook facts by default; raw payloads require owner-provided debug serializers.
- An **Agent Finish Hook** belongs to the **Agent Invocation Lifecycle**.
- A failed **Agent Invocation** preserves the original thrown value and exposes an **Agent Error Message** for the common reporting path.
- Capabilities can expose **Agent Invocation Extensions** on Agent Invocation Lifecycle events.
- An **Agent Eval** runs an **Agent Definition** to create scored **Agent Invocations**.
- An **Agent** can attach zero or more Capabilities.
- Tools are contributed by Capabilities, not by top-level Agent Definition fields.
- Model-facing tools and instructions are **Capability Driver Contributions** consumed only by compatible Agent Drivers.
- Free-form model-facing guidance from Sources, Capabilities, and Skills should be covered through **Instruction Bindings** instead of ambient contribution from primitive configuration.
- Workspace Tools are derived from an Agent's Colocated Workspace Definition.
- An **Agent Invocation** can create or update **Agent Run State**.
- An **Agent Run Origin** is observability metadata for an **Agent Invocation**; it is not the **Agent Trigger** that prepared the invocation and is not mirrored into Chat context.
- **Chat History** is conversation-scoped and is not **Agent Memory**.
- A **Chat Session** is part of Chat History behavior and is not **Agent Memory**.
- Message-shaped **Channels** resolve the active **Chat Session** before applying the **Chat History Window**.
- A **Chat History Window** is configured by the Agent Definition when the application wants bounded Chat History.
- **Chat Trigger History** can be derived from an explicit **Chat Thread History Cache** max when the Agent Definition does not configure a trigger override.
- A **Chat Thread History Cache** stores or backfills recent platform thread messages; it is not by itself the model-facing Chat History Window.
- Message-shaped **Channels** can require state for **Chat History** through the Agent State Provider.
- Every **Agent Invocation** has an **Agent Actor**; when no trusted identity is supplied, ViteHub provides an origin-specific anonymous fallback.
- Message-shaped **Channels** can produce an **Agent Actor** from trusted Chat Platform Adapter identity before later Capabilities resolve.
- **Agent Actor** is exposed through `context.actor`; legacy APIs expose the same identity through `context.invoker` and the `invoker` Agent Invocation Context Value.
- **Agent Actor** resolution may read **Agent Run Origin** from first-class run metadata, but concrete authorization effects should flow through the resolved **Agent Actor** rather than branching on origin later.
- **Agent Invoker Profiles** are static objects in the first version.
- **Agent Invoker Profile** ids must be unique per Agent Definition.
- DevTools can select configured **Agent Invoker Profiles** before a new Chat Session starts, but does not switch invokers in the middle of one conversation.
- Chat History is explicit application behavior and is not enabled by default.
- **Agent Invocation Context Values** can be produced by Pre-Invocation Decisions and read by later Agent or Capability callbacks.
- **Agent Invocation Context Values** can carry small trusted product metadata, such as pull-request identity facts, while larger review material stays in Workspace Sources.
- **Agent Invocation Context Values** do not grant Capabilities dynamically.
- **Agent Invocation Context Value** ids must be unique per Agent so every invocation has one writer per context value.
- **Agent Memory** can outlive one conversation.
- A **Concurrent Invocation Guard** protects **Agent Run State**.
- A **Development State Provider** is not acceptable for hosted production runtimes.
- **Agent Usage** belongs to one **Agent Invocation**.
- **Agent Usage Records** are the shared accounting surface for model-backed, harness-backed, and custom-run-backed Agent Drivers when they report usage.
- A model-backed **Agent Driver** may report token-shaped **Agent Usage**.
- A harness-backed **Agent Driver** should emit **Agent Usage Records** even when the provider reports sessions, actions, wall time, quota events, or other non-token usage units.
- **Agent Usage** token fields are present only when a provider reports or ViteHub can safely derive token counts.
- Non-token harness usage should be preserved as provider- or harness-reported raw usage details instead of translated into invented token counts.
- **Agent Usage Records** may include the resolved **Harness Credential Source** label or billing identity metadata when available without exposing the underlying secret.
- **Agent Usage Records** record cost only when a provider reports it or explicit pricing logic estimates it; ViteHub must not invent exact cost for subscription-backed harness runs.
- **Agent Usage Telemetry** observes **Agent Usage Records**.
- **Agent Usage Telemetry** can expose an **Agent Usage Record** as an **Agent Invocation Extension**.
- An **Agent Usage Summary** may be formatted by app code because human-facing delivery copy belongs to the application, while ViteHub owns the normalized usage record.
- A **Mock Agent Adapter** can support playgrounds and end-to-end tests without creating provider cost.
- Agent callbacks receive Agent-owned runtime metadata, not app-owned Runtime Env; server code reads app-owned Runtime Env through Server Env.

## Example Dialogue

> **Dev:** "Should users configure `tools` directly on the Agent Definition?"
> **Domain expert:** "No. Tools belong inside Capability definitions so validation, policy, and DevTools metadata stay attached to the Capability."
>
> **Dev:** "Should the playground call a real model provider just to test DevTools?"
> **Domain expert:** "No. Use a **Mock Agent Adapter** when the goal is deterministic Agent behavior without token cost."
>
> **Dev:** "Should Chat DevTools own the server behavior for sending messages to an Agent?"
> **Domain expert:** "No. Chat DevTools should consume an **Agent Trigger** primitive, just like an application server route or webhook would."
>
> **Dev:** "Should an instruction callback read a routing decision from arbitrary metadata?"
> **Domain expert:** "No. Read it as an **Agent Invocation Context Value** produced by a Pre-Invocation Decision."
>
> **Dev:** "Should we put customer, staff, and technical-user branching into both `access()` and prompt instructions?"
> **Domain expert:** "Keep the shared facts on the **Agent Actor**. Let `access()` map `context.actor` to Workspace Scope, and let any prompt Capability or instruction callback read the same actor metadata for model-facing text. `context.invoker` remains a compatibility alias."
>
> **Dev:** "Should a failed Agent Invocation become a Result object so finish hooks can show the error?"
> **Domain expert:** "No. Keep the original unknown error on the lifecycle event and expose an **Agent Error Message** for reporting."
>
> **Dev:** "Is a new Chat Session the same as Agent Memory reset?"
> **Domain expert:** "No. A **Chat Session** changes which Chat History messages enter the Chat History Window; **Agent Memory** is durable knowledge across invocations."

## Flagged Ambiguities

- Raw tools were considered as top-level Agent Definition fields - resolved: tools are contributed by Capabilities.
- Flue-style root `tools`, `skills`, and `sandbox` fields were considered for harness-backed Agents - resolved: keep harness execution under the **Agent Driver**, keep custom harness sandbox providers behind `harnessSandbox`, keep default harness sandbox setup behind the **Agent Harness Driver Contract**, and keep tools or Skills behind Capabilities.
- Multi-adapter support was considered part of Agent Definition shape - resolved: use one **Agent Driver** boundary rather than public adapter selectors.
- Top-level `model` and `harness` selectors were considered part of Agent Definition shape - resolved: select model-backed or harness-backed execution through **Agent Driver**.
- Driver factory wrappers such as `modelDriver()` and `harnessDriver()` were considered for explicitness - resolved: configure the **Agent Driver** as a single object variant and distinguish variants by exclusive keys.
- Nested driver implementation objects such as `driver: { model: { use } }` were considered - resolved: the driver variant key holds the implementation value directly, with variant options as sibling fields.
- Deterministic `run` callbacks were considered separate from **Agent Driver** - resolved: `run` is the custom-run-backed Agent Driver variant and root `run` should migrate to `driver: { run }`.
- Combining model-backed execution with custom `run` was considered for fallback or post-processing - resolved: **Agent Driver** variants are mutually exclusive; custom code that wants to call a model belongs in `driver: { run }`.
- Root `modelExecution` was considered for preservation inside model-backed drivers - resolved: the model-backed Agent Driver uses `execution` because `model` is already implied by the driver variant.
- Root Agent Definition `instructions` were considered shared by model-backed and harness-backed execution - resolved: use **Model Driver Instructions** for model-backed drivers, and do not pass them to harness-backed drivers by default.
- Ambient Source, Capability, and Skill prose was considered convenient default model guidance - resolved: use **Explicit Instruction Coverage** and **Instruction Coverage Diagnostics** so model-facing guidance has an authored owner.
- AI SDK `HarnessAgent` was considered as the public harness boundary - resolved: use the ViteHub-owned **Agent Harness Driver Contract** and adapt AI SDK harnesses behind it.
- Adapter-level harness approvals were considered for V1 - resolved: use **Harness Permission Policy** to bypass adapter approvals by default and rely on ViteHub-owned Workspace and runtime boundaries, avoiding two active permission layers.
- A public permission option was considered for V1 - resolved: expose only `driver.permissionMode` for harness adapter no-approval modes, while keeping raw harness permissions unsupported.
- A full approval policy matrix was considered for V1 - resolved: defer it; if a harness adapter cannot bypass its own approval layer, mark it unsupported for V1.
- Model-facing Workspace Tools were considered the default Workspace surface for harness-backed drivers - resolved: harness-backed drivers use a scoped **Workspace Session** or equivalent materialized filesystem by default.
- Capability-owned support files were considered harness instructions - resolved: pass them only as **Harness Workspace Path Contributions** when a harness-backed **Agent Driver** needs filesystem-visible support files.
- Durable harness sessions were considered as an implicit chat or thread default - resolved: harness-backed Agent Drivers use invocation-scoped Harness Workspace Sessions by default and require an explicit Harness Session Key for reuse.
- Requiring a `credentials` option for every harness-backed Agent Driver was considered - resolved: credentials are optional; omission means the harness adapter may use its default auth behavior, and ViteHub classifies the resolved **Harness Credential Source** when possible.
- Treating omitted harness credentials the same in development and hosted production was considered - resolved: warn in development for unknown or local-only sources, but fail hosted production for unknown or known local-only sources.
- Hiding credential configuration inside harness adapter constructors such as `codex()` was considered - resolved: configure **Harness Credential Source** as a sibling harness-backed Agent Driver option so ViteHub can validate, redact, and report it before adapter execution.
- Provider-specific env helper namespaces were considered for harness credentials - resolved: use Env Package **Server Env** and **Secret Env** for deployable secret material, and keep harness credential options focused on driver auth metadata.
- Harness usage accounting was considered a separate telemetry concept from model usage - resolved: use **Agent Usage Records** for every Agent Driver that reports usage, preserve non-token harness details, and do not invent exact subscription cost.
- Adapter-owned options were considered the home for model execution settings - resolved: use **Agent Model Execution** inside the model-backed Agent Driver and do not reintroduce public adapter-boundary language.
- Evalite-backed checks were considered generic tests - resolved: use **Agent Eval** when the check runs an Agent Definition and scores Agent Invocation output.
- Chat runtime state was considered a public Chat option - resolved: use **Agent Run State** for Agent-owned runtime state.
- Chat History and Agent Memory were considered interchangeable - resolved: Chat History is conversation-scoped message history; Agent Memory is durable knowledge or preferences across invocations.
- Chat Sessions were considered as Agent Memory or separate Chat Session Capabilities - resolved: **Chat Session** is Chat History behavior used by message-shaped **Channels**.
- `channelDefaults.message` and `channels.messages` were considered for shared message behavior - resolved: use root **Message Channel Settings** through `defineAgent({ messages })` and keep `channels` as the direct **Channel ID** map.
- Flat per-Channel message overrides were considered - resolved: nest them under the Channel's own `messages` option so route, adapter, identity, and message behavior do not collapse into one option bag.
- Identity mapping was considered for **Message Channel Settings** - resolved: keep it on concrete **Channels** because each Channel trusts different actor data.
- Root `messages.concurrency` was considered too platform-specific - resolved: allow it for overlapping message turns, while platform delivery limits stay Channel-specific.
- Start acknowledgements were considered one Channel delivery concept - resolved: split protocol-level **Channel Delivery Admission** from user-visible **Channel Delivery Effects**.
- One global writable hook bus was considered for Agent, Channel, Capability, Runtime, and integration hooks - resolved: use one **ViteHub Hook System** with owner-scoped public mutation hooks and read-only **Hook Observers** for cross-owner inspection.
- Platform-prefixed delivery effects such as GitHub reactions were considered shared public vocabulary - resolved: use generic **Channel Delivery Effect** kinds such as reactions, with platform-specific mapping owned by the active **Channel**.
- Capability-owned Channel effects were considered as direct platform operations - resolved: Capabilities may contribute **Channel Delivery Effect Intents** for the current delivery, while Channels own execution and unsupported intents are traced and ignored.
- **Hook Observer** failures were considered possible control-flow failures - resolved: observer failures are isolated to logging or tracing and never fail an **Agent Invocation**.
- Hidden model-selected history slicing was considered - resolved: **Chat Session** selection is a host-visible boundary over preserved Chat History, not destructive message truncation.
- Route and gate results were considered for ad hoc input context or metadata - resolved: expose them as typed **Agent Invocation Context Values**.
- Shared access-and-audience branching was considered for reusable Invocation Profiles - resolved: use **Agent Actor** as the trusted identity concept, with legacy **Agent Invoker Profiles** and app-owned actor metadata for V1.
- Chat state was considered separate from Agent State Provider - resolved: Chat History state is satisfied through the Agent State Provider when available.
- Chat actor identity was considered a chat-history-only detail - resolved: expose it as an **Agent Actor** so other Capabilities can consume it.
- Chat History was considered an implicit chat default - resolved: keep Chat History opt-in, aligned with Chat SDK-style application control.
- Local and hosted state providers were considered equivalent - resolved: hosted production runtimes require a durable provider and a **Concurrent Invocation Guard**.
- Model-free playground behavior was described as a dummy Agent - resolved: use **Mock Agent Adapter** for deterministic, cost-free Agent Invocations.
- Callback runtime config was considered an Agent app configuration surface - resolved: app-owned Runtime Env belongs to Server Env, not Agent callback context.
- Server-side chat integration was described as a chat adapter or client integration - resolved: use **Agent Trigger** for server-side behavior that starts Agent Invocations.
- ChatSDK adapters were considered Agent Triggers - resolved: a Chat Platform Adapter receives platform webhook events, and generated Chat Webhook wiring bridges those events into the concrete message-shaped **Channel**.
- Agent run metadata used `platform` for both chat adapters and generic invocation sources - resolved: use **Agent Run Origin** for run metadata and reserve platform language for **Chat Platform Adapters**.
- `run.channelId` was considered for both configured Channel IDs and platform conversation ids - resolved: use **Agent Run Channel** for configured ViteHub Channel identity and **Agent Run Platform Context** for platform-native ids.
- Agent Triggers were considered chat-only because chat is the first major use case - resolved: message-shaped **Channels** can provide official triggers, but Agent Triggers remain general and do not require message-shaped input.
- Chat helper APIs were considered the primary exposure path - resolved: declared Channel delivery paths are the primary server-side path, with helpers only as optional callers or ergonomics around registered triggers.
- Client-provided flags were considered Capability configuration - resolved: triggers may pass host or client intent with the Agent Invocation, while Capabilities remain server-configured Agent behavior and the exact input field name is not fixed yet.
- Result or Effect-style failure values were considered for Agent Invocation lifecycle errors - resolved: preserve the original unknown error and expose an **Agent Error Message** at the Agent Invocation boundary.
