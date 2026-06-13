# Auth

Auth names ViteHub authentication primitives for verifying application users, reading sessions, and exposing authentication state to other ViteHub packages without turning auth into an app UI layer.

## Language

**Auth**:
The ViteHub authentication primitive for application user identity and sessions.
_Avoid_: Login UI, route protection, Agent Invoker

**Auth Definition**:
A server-owned Definition that configures authentication behavior and may carry client factory metadata for downstream application code.
_Avoid_: Auth Server Definition, Auth Client Definition, auth route

**Primary Auth Definition**:
The single Auth Definition for an application in the first Auth Package design.
_Avoid_: multiple auth definitions, tenant auth definition, route-specific auth

**Auth Definition Location**:
The source location where the Primary Auth Definition is discovered.
_Avoid_: route file, client auth file, named auth definition

**Auth User**:
The application user identified by Auth.
_Avoid_: Agent Invoker, customer, account

**Auth Session**:
The authenticated request state that connects an Auth User to a current session.
_Avoid_: Agent Invocation, Chat Session, browser state

## Relationships

- An **Auth Definition** declares **Auth** behavior.
- An application has one **Primary Auth Definition** for now.
- The canonical **Auth Definition Location** is `server/auth.ts`.
- `server.auth.ts` is an equal supported suffix-style **Auth Definition Location** alias.
- An **Auth Session** can identify one **Auth User**.
- **Auth User** is not **Agent Invoker**.
- **Auth Session** is not **Chat Session**.
- Client factory metadata can belong to an **Auth Definition** without becoming a separate discovered Definition.

## Example Dialogue

> **Dev:** "Should we create one `defineAuthServer` file and one `defineAuthClient` file?"
> **Domain expert:** "No. Start with one server-owned **Auth Definition** and let it carry client factory metadata when needed."
>
> **Dev:** "Can one app define multiple auth systems?"
> **Domain expert:** "No. The first Auth Package design supports one **Primary Auth Definition** per app."
>
> **Dev:** "Can Auth use suffix-style discovery?"
> **Domain expert:** "Yes. Prefer `server/auth.ts`, but support `server.auth.ts` as an equal **Auth Definition Location** alias."

## Flagged Ambiguities

- Server and client auth were considered as separate discovered definitions - resolved: use one **Auth Definition** for the first package shape, with client factory metadata kept subordinate to it.
- Multiple Auth Definitions were considered - resolved: support one **Primary Auth Definition** per app for now.
- `server.auth.ts` was considered as a named auth identity source - resolved: it is only an alias for the singleton **Primary Auth Definition**.
- Auth identity was considered as Agent identity - resolved: **Auth User** and **Agent Invoker** are separate concepts, with a future bridge able to map one into the other.
