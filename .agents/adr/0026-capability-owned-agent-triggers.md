# Capability-Owned Agent Triggers

ViteHub will let Capability Definitions contribute Agent Triggers directly through a `triggers` field. A trigger declares a Capability-owned product event that can start an Agent Invocation, maps trigger input into Agent Invocation input and run metadata, and leaves execution to the Agent Package so lifecycle hooks, cleanup, output rendering, errors, and DevTools streaming stay centralized.

## Considered Options

- A separate chat trigger/helper API was rejected because it would make Chat a special source of truth and recreate the legacy DevTools/chat boundary this PR is removing.
- A top-level Agent Definition trigger map was rejected because trigger behavior belongs with the Capability that owns the product ability.
- A `server.triggers` grouping was deferred because Agent Triggers are server-authoritative by default and no broader server contribution bucket has earned its name yet.
- Raw framework routes or handlers were rejected as the public trigger primitive because they would leak Nitro/H3 details into Capability authorship and make non-HTTP triggers harder to model.

## Consequences

Capability authors define local trigger names such as `message`; ViteHub resolves stable public trigger identities as `<capabilityId>.<triggerId>`, such as `chat.message`. DevTools, route handlers, client helpers, webhooks, and future transports consume resolved triggers; they do not declare trigger availability or Capability behavior. Chat is the first official Capability-owned trigger and uses AI SDK UIMessage input and UIMessage stream output, but Agent Triggers remain generic and do not require message-shaped input.
