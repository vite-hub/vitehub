# Agents and Server Primitives Are Product Lanes

## Status

Accepted.

## Context

ViteHub has two independently valuable public surfaces. Server Primitives give ordinary Vite server applications portable state and work across hosts. Agents define, invoke, inspect, and deploy server-side Agents that may compose those primitives.

The shared repository, Vite Integration vocabulary, Provider Output contracts, CLI, and verification system make coordinated development faster. They do not require one undifferentiated product story or an all-inclusive application API.

The previous landing-page decision in ADR 0073 correctly made Agents the acquisition wedge, but equal real estate on one page did not make the package and product boundary obvious enough.

## Decision

ViteHub is one platform with two public product lanes:

- **ViteHub Agents** owns Agent Definitions, Agent Drivers, Agent Invocations, Channels, Capabilities, Workspace context, inspection, and Agent deployment behavior.
- **ViteHub Server Primitives** owns portable server state and work through package-owned Definitions, Runtime Helpers, Vite Integrations, and Provider Output.

Agents may compose Server Primitives. Server Primitives must not require Agents. Agent-specific bridges to Auth, Workflow, Workspace, storage, or other primitives belong to Agent-owned or explicit bridge surfaces rather than primitive package cores.

Keep one repository, package scope, release system, documentation site, and root landing page. The root leads with Agents and routes users directly to focused Agents and Server Primitives journeys. Repository topology does not define the product boundary.

Owner-package imports remain the canonical application API. A preset Vite Integration may compose package-owned integrations, but it must not become a second mirrored runtime API.

This decision supersedes ADR 0073 where that ADR requires the two lanes to share one undifferentiated landing narrative or gives the preset facade first-class application API ownership.

## Proof

The boundary is proven by executable consumer stories rather than an export-name snapshot:

1. A primitive-only application builds and runs without Agent in its runtime graph.
2. A minimal Agent application runs without enabling unrelated primitives or DevTools.
3. An Agent application explicitly composes selected Workspace, Workflow, storage, or Auth behavior.
4. Public documentation examples compile against package-owned exports.
5. Package graph checks reject new Server Primitive imports from `@vite-hub/agent`.

## Consequences

- Marketing and docs use the names **Agents** and **Server Primitives** instead of inventing a generic public `Core` product.
- The main landing page may lead with Agents while the header and docs home keep Server Primitives directly reachable.
- Primitive-specific setup does not teach Agent concepts unless the task is Agent composition.
- Agent guides introduce primitives only at the point where an Agent needs them.
- `@vite-hub/vite` facade exports, primitive-to-Agent dependencies, and default-on integrations require follow-up migrations.
- A repository split remains possible if teams, governance, or release cadences diverge, but it is not part of the current product design.
