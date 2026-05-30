# Schedule

Schedule names future and recurring runtime work.

## Language

**Schedule**:
A runtime coordination concept for starting work at a future time or recurring cadence.
_Avoid_: Cron as the umbrella term, Agent Capability, background task

**Schedule Package**:
The `@vite-hub/schedule` package that owns Schedule definitions, runtime helpers, and Schedule Capability integration.
_Avoid_: `@vite-hub/scheduling`, cron package

**Schedule Definition**:
A portable declaration that describes when work should start and what target should run.
_Avoid_: Cron job as the umbrella term, task, route

**Static Schedule Definition**:
A Schedule Definition declared in source code, discoverable by ViteHub integrations, and eligible for Provider Output.
_Avoid_: Runtime Schedule, provider cron

**Schedule Definition Boundary Helper**:
The Definition Boundary Helper used to declare a Static Schedule Definition in source code.
_Avoid_: Runtime Helper, cron job factory

**Schedule File Name**:
The file name used as the identity for a discovered Static Schedule Definition.
_Avoid_: Required explicit id, route name

**Runtime Schedule Opt-In**:
The Static Schedule Definition option that allows its handler to be reused by Runtime Schedules and Schedule Capabilities.
_Avoid_: runtime flag, exposed target

**Runtime Schedule**:
A schedule created, changed, enabled, disabled, or deleted at runtime and stored durably by ViteHub.
_Avoid_: Static Schedule Definition, provider cron

**Schedule Runtime Helper**:
A Runtime Helper used by app or server code to create and manage Runtime Schedules.
_Avoid_: Schedule Capability, provider client

**Schedule Capability**:
An Agent Capability that lets an Agent create or manage Runtime Schedules within developer-defined policy.
_Avoid_: Scheduling as an Agent Capability, raw scheduler tools

**Agent Schedule**:
A cron schedule declared through the Schedule Capability that starts the owning Agent.
_Avoid_: Schedule Capability policy, Handler Target, Runtime Schedule

**Self Schedule Permission**:
The Schedule Capability option that allows an Agent to create Runtime Schedules targeting itself.
_Avoid_: Implicit write mode permission, target policy

**Schedule Invocation Input**:
The schedule-owned input metadata passed when a Schedule Run starts an Agent Invocation.
_Avoid_: Synthetic user message, Chat History

**Schedule Capability Mode**:
The Schedule Capability permission axis that controls model-facing read or write access to Runtime Schedules.
_Avoid_: Schedule Runtime Helper permission, target policy

**Schedule Tool Policy**:
The Schedule Capability policy that returns allow, deny, require-approval, or retry decisions for model-facing schedule tools.
_Avoid_: Separate schedule approval flag, autonomous schedule writes

**Schedule Capability Tool Surface**:
The two-tool read/edit shape used by the Schedule Capability to expose scoped Runtime Schedule operations to a model.
_Avoid_: One tool per Schedule Runtime Helper method, raw schedule helper proxy

**Recurring Runtime Schedule**:
A Runtime Schedule that repeats until it is disabled, deleted, expires, or reaches a policy limit.
_Avoid_: Deferred Schedule, Static Schedule Definition

**Provider Wake**:
A provider-level configuration or platform event that wakes ViteHub scheduling code so it can inspect and execute due schedules.
_Avoid_: Runtime Schedule, Schedule Definition

**Schedule Run**:
One scheduling-owned execution record created when a Schedule Definition or Runtime Schedule becomes due.
_Avoid_: Agent Invocation, job, task

**Schedule Run Attempt**:
One try within a Schedule Run for retry, backoff, and failure accounting.
_Avoid_: Schedule Run, Agent Invocation

**Schedule Target**:
The executable destination a Schedule Run starts.
_Avoid_: Agent as the default target, task

**Runtime Schedule Target**:
A Schedule Target that a Runtime Schedule is allowed to start.
_Avoid_: Any discovered Static Schedule Definition handler

**Schedule Target Name**:
The generated string-literal identity of a Runtime Schedule Target.
_Avoid_: Untyped string target, handler path

**Handler Target**:
A Schedule Target that calls app or server code by stable name.
_Avoid_: Agent Target, route

**Agent Target**:
A Schedule Target that starts an Agent Invocation.
_Avoid_: Schedule Capability, Handler Target

**Overlap Policy**:
The scheduling rule for what happens when a Schedule becomes due while an earlier Schedule Run for the same schedule is still active.
_Avoid_: Agent Concurrent Invocation Guard, retry policy

**Retry Policy**:
The scheduling rule for whether and how failed Schedule Run Attempts are retried.
_Avoid_: Overlap Policy, target error handling

**Dedupe Policy**:
The scheduling rule for avoiding duplicate Schedule Runs for the same intended schedule delivery.
_Avoid_: Idempotent target implementation, retry policy

**Cron Schedule**:
A Schedule Definition that uses a cron expression for recurring wall-clock timing.
_Avoid_: Interval, heartbeat, every

**Schedule Time Base**:
The time reference used to interpret cron expressions.
_Avoid_: Per-user timezone, local server time

## Relationships

- A **Schedule Definition** can be a **Cron Schedule**.
- `@vite-hub/schedule` is the **Schedule Package**.
- The **Schedule Package** owns Schedule primitive behavior and the Schedule Capability helper, while the Agent Package owns Agent capability composition.
- A **Cron Schedule** can be source-declared as a **Static Schedule Definition** or created as a **Runtime Schedule**.
- The first **Schedule Time Base** is UTC.
- Interval-style `every` timing is not part of the Scheduling vocabulary.
- Future developer-experience helpers may convert interval-shaped input to cron syntax without creating an Interval Schedule concept.
- A **Static Schedule Definition** is source-declared and can be lowered to Provider Output.
- `defineSchedule` files and inline **Agent Schedules** are authoring forms over the same internal Static Schedule Definition model.
- `defineSchedule` is the **Schedule Definition Boundary Helper**.
- A **Runtime Schedule** is durably stored by ViteHub instead of being represented as provider deployment configuration.
- A **Schedule Runtime Helper** is for app/server code.
- `schedules` is the app-facing Schedule Runtime Helper name.
- The first Schedule Runtime Helper operations are create, list, get, update, delete, enable, and disable.
- A **Schedule Capability** is for Agent-controlled scheduling through Capability policy.
- A **Schedule Capability** can declare **Agent Schedules** inline.
- **Schedule Capability Mode** uses `mode: 'read' | 'write'` like official primitive Capabilities.
- The Schedule Capability uses a **Schedule Capability Tool Surface** rather than one model-facing tool per Schedule Runtime Helper method.
- Schedule write tools require `policy: 'require-approval'` by default unless the developer explicitly supplies a different **Schedule Tool Policy**.
- Schedule itself is not an Agent Capability, but a **Schedule Capability** can expose controlled scheduling operations to an Agent.
- An **Agent Schedule** has an implicit Agent Target: the owning Agent.
- An **Agent Schedule** starts an Agent Invocation with **Schedule Invocation Input**, not a synthetic user message.
- An **Agent Schedule** starts an independent Agent Invocation and does not require Chat History.
- An **Agent Schedule** can omit id when ViteHub can derive stable identity from a normalized cron expression.
- The `schedule` Capability helper uses `schedule(options)`.
- Inline **Agent Schedules** are declared through `schedule({ schedules: [...] })`.
- **Self Schedule Permission** is explicit and is not implied by `mode: 'write'`.
- A **Schedule Runtime Helper** can create or manage **Recurring Runtime Schedules**.
- One-time future execution is not part of Scheduling vocabulary in the first version.
- A **Provider Wake** can drive Runtime Schedule execution without being the Runtime Schedule itself.
- A due **Schedule Definition** or **Runtime Schedule** creates a **Schedule Run**.
- A **Schedule Run** can have one or more **Schedule Run Attempts**.
- A **Schedule Run** can start an Agent Invocation without becoming an Agent Invocation.
- A Static Schedule Definition can provide both cron timing and its default **Schedule Target**.
- A **Schedule File Name** provides the Static Schedule Definition identity.
- `allowRuntimeSchedules` is the **Runtime Schedule Opt-In**.
- A **Schedule Run** starts one **Schedule Target**.
- A Static Schedule Definition handler is not a **Runtime Schedule Target** unless it explicitly opts into runtime reuse.
- A Schedule Capability can only use Runtime Schedule Targets that are also allowed by that Capability's target policy.
- **Schedule Target Names** are generated behind a Stable ViteHub Import Path for typed Schedule Runtime Helper and Schedule Capability usage.
- A Schedule Capability can target a Runtime Schedule Target only when the target opted into runtime reuse and the Capability policy allows that target id.
- A **Handler Target** and **Agent Target** are Schedule Target kinds.
- An **Agent Target** starts an Agent Invocation but is not a Schedule Capability.
- **Runtime Schedules** are dynamic timing data over static Schedule Targets.
- A Static Schedule Definition with stable identity can opt into exposing its handler as a Runtime Schedule Target.
- **Overlap Policy**, **Retry Policy**, and **Dedupe Policy** belong to Schedule by default.
- Naming a scheduling policy does not imply it is user-configurable in the first version.
- `cron` can be public API/product language without making cron the umbrella domain term.
- Schedule is runtime coordination and is not an Agent Capability.
