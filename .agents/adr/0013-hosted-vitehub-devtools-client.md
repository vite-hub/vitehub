# Hosted ViteHub DevTools Client

ViteHub DevTools use a single hosted **ViteHub DevTools Client** as the public client delivery mode. The DevTools Package owns the **ViteHub DevTools Integration**, **DevTools Discovery Surface**, and shared registration helpers; feature packages own their **Package DevTools Integrations**, **DevTools Features**, **DevTools Bridges**, and package-local opt-outs.

`@vitehub/devtools` is publishable so external applications can install the ViteHub DevTools Integration and test package-owned DevTools Features through the hosted shell.

Chat is the first **DevTools Feature**. It should register feature metadata and a bridge with DevTools discovery through the Agent Package's primary integration, not install a separate embedded client, expose a separate public feature plugin, or force application bundling workarounds such as Vue aliasing.

The ViteHub DevTools Integration is a shell and discovery integration, not a package scanner. It discovers already-registered DevTools Features through the DevTools Discovery Surface; each active package integration owns registering its own DevTools Feature and DevTools Bridge unless a package-local opt-out disables that feature.

## Considered Options

- Embedded package-owned DevTools clients were rejected because each client inherits the host application's bundling and dependency-resolution problems.
- Multiple package-specific hosted clients were rejected because shared routing, navigation, feature discovery, and RPC conventions would fragment early.
- A configurable embedded fallback was rejected for now because it keeps the fallback behavior in the public contract before there is a concrete offline requirement.
- Putting feature behavior inside `@vitehub/devtools` was rejected because package-owned runtime state, serialization, and bridges belong to the package that owns the feature.
- A global scanner in `@vitehub/devtools` was rejected because the shell would need to know how to enable package runtime behavior that belongs to each package integration.
- Separate public feature plugins such as `hubChatDevtools()` were rejected because they make package-owned DevTools Feature Registration look optional and separate from the owning package integration.
- Public Chat DevTools bridge route customization was rejected for v1 because bridge location is part of package-owned DevTools Feature Registration and no concrete routing requirement justifies the extra public API.
- Global feature toggles on the DevTools shell were deferred because package-local opt-outs are simpler and avoid cross-package naming and versioning policy.

## Consequences

This is a breaking DevTools contract. Applications install the DevTools shell explicitly through `hubDevtools()` from `@vitehub/devtools`, while active package integrations register their own features and bridges automatically. For Agent Chat, the Agent integration should register the Chat DevTools Feature and its fixed package-owned DevTools Bridge by default, with only a package-local DevTools Opt-Out for disabling it. Missing shell integration should warn during development when package DevTools features are enabled, but it should not fail the application runtime.

The hosted client discovers available features through one DevTools-owned **DevTools Discovery Surface**. The current Vite implementation exposes that surface as a **DevTools Discovery RPC**. Feature registration starts with minimal metadata: feature identity, package ownership, title, icon, and bridge location. Local DevTools client development remains an internal repository workflow, not a user-facing integration mode.
