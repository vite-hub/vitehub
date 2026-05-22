# DevTools

DevTools names the development inspection surface shared by ViteHub packages.

## Language

**ViteHub DevTools Client**:
The single hosted development UI shell for inspecting ViteHub features in an application.
_Avoid_: Chat DevTools app, embedded client, package devtools page

**DevTools Feature**:
A package-owned inspection area registered into the ViteHub DevTools Client.
_Avoid_: Separate DevTools app, standalone panel, route package

**ViteHub DevTools Integration**:
The Vite integration that registers the ViteHub DevTools Client shell with the host DevTools environment.
_Avoid_: Chat plugin, feature plugin, bridge route

**Package DevTools Integration**:
The package-owned integration behavior that registers one DevTools Feature and its DevTools Bridge with the ViteHub DevTools discovery system.
_Avoid_: Shell plugin, global DevTools config, client app

**DevTools Bridge**:
The application-side endpoint or RPC surface that connects the ViteHub DevTools Client to package runtime state.
_Avoid_: API route, webhook, app backend

**DevTools Discovery Endpoint**:
The DevTools Package-owned app-side endpoint that lists registered DevTools Features for the ViteHub DevTools Client.
_Avoid_: Feature route, package bridge, hardcoded client list

**DevTools Feature Registration**:
The integration behavior that makes a DevTools Feature discoverable to the ViteHub DevTools Client.
_Avoid_: Client routing, plugin install, sidebar item

**DevTools Opt-Out**:
A package-owned Integration Option that disables one DevTools Feature while leaving the package integration active.
_Avoid_: Remove plugin, hide route, disable client

## Relationships

- The **ViteHub DevTools Client** contains zero or more **DevTools Features**.
- The **ViteHub DevTools Integration** registers the **ViteHub DevTools Client** shell.
- The DevTools Package owns the **ViteHub DevTools Integration**.
- A **Package DevTools Integration** registers one package-owned **DevTools Feature** and its **DevTools Bridge**.
- A package owns its **DevTools Feature**.
- A **DevTools Feature** talks to application runtime state through a **DevTools Bridge**.
- The **ViteHub DevTools Client** discovers available **DevTools Features** through the **DevTools Discovery Endpoint**.
- The DevTools Package owns the **DevTools Discovery Endpoint**.
- **DevTools Feature Registration** makes a **DevTools Feature** available when its package integration is active.
- **DevTools Feature Registration** starts with feature identity, package ownership, title, icon, and bridge location.
- **DevTools Feature Registration** is automatic unless a **DevTools Opt-Out** disables that feature.
- A package owns the **DevTools Opt-Out** for its own **DevTools Feature**.
- **DevTools Opt-Out** is package-local unless an ADR introduces a global feature policy.
- A missing **ViteHub DevTools Integration** should warn during development when package-local DevTools features are enabled.
- Hosted delivery is the default behavior for the **ViteHub DevTools Client**.
- Embedded DevTools client delivery is not a public integration mode.

## Example Dialogue

> **Dev:** "Should `@vitehub/agent` ship its own chat DevTools app?"
> **Domain expert:** "No. Chat is a **DevTools Feature** inside the **ViteHub DevTools Client**. The Agent Package owns the feature and bridge, not a separate client shell."
>
> **Dev:** "Should installing a package require a second DevTools plugin to see its feature?"
> **Domain expert:** "No. **DevTools Feature Registration** is automatic with the package integration; use a **DevTools Opt-Out** only when a feature should be disabled."
>
> **Dev:** "Should Chat register the ViteHub DevTools shell?"
> **Domain expert:** "No. The **ViteHub DevTools Integration** registers the shell. Chat registers a **DevTools Feature** and **DevTools Bridge**."
>
> **Dev:** "Should `@vitehub/devtools` know how Chat History is serialized?"
> **Domain expert:** "No. Chat serialization belongs to the Agent Package's **Package DevTools Integration**; the DevTools Package owns the shell and discovery protocol."
>
> **Dev:** "Should an app fail if Chat DevTools is enabled but `hubDevtools()` is missing?"
> **Domain expert:** "No. Warn during development; DevTools visibility should not break the app runtime."
>
> **Dev:** "Should the hosted client hardcode Chat, KV, and DB routes?"
> **Domain expert:** "No. The hosted client reads registered features from the **DevTools Discovery Endpoint**."

## Flagged Ambiguities

- Chat DevTools was treated as its own client application - resolved: use **ViteHub DevTools Client** for the hosted shell and **DevTools Feature** for package-owned inspection areas.
- App-side DevTools routes were described as webhooks or generic APIs - resolved: use **DevTools Bridge** for the runtime connection used by the hosted client.
- Embedded DevTools fallback was considered a user-facing option - resolved: local client delivery is an internal development workflow, not a public integration mode.
- Global DevTools feature toggles were considered for the shell integration - resolved: **DevTools Opt-Out** stays package-local until global policy has a concrete need.
- DevTools Feature Registration was considered as a client-rendering plugin contract - resolved: v1 registration only describes feature metadata and bridge location.
