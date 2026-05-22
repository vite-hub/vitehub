# Hosted ViteHub DevTools Client

ViteHub DevTools use a single hosted **ViteHub DevTools Client** as the public client delivery mode. The DevTools Package owns the **ViteHub DevTools Integration**, **DevTools Discovery Surface**, and shared registration helpers; feature packages own their **Package DevTools Integrations**, **DevTools Features**, **DevTools Bridges**, and package-local opt-outs.

`@vitehub/devtools` is publishable so external applications can install the ViteHub DevTools Integration and test package-owned DevTools Features through the hosted shell.

Chat is the first **DevTools Feature**. It should register feature metadata and a bridge with DevTools discovery, not install a separate embedded client or force application bundling workarounds such as Vue aliasing.

## Considered Options

- Embedded package-owned DevTools clients were rejected because each client inherits the host application's bundling and dependency-resolution problems.
- Multiple package-specific hosted clients were rejected because shared routing, navigation, feature discovery, and RPC conventions would fragment early.
- A configurable embedded fallback was rejected for now because it keeps the fallback behavior in the public contract before there is a concrete offline requirement.
- Putting feature behavior inside `@vitehub/devtools` was rejected because package-owned runtime state, serialization, and bridges belong to the package that owns the feature.
- Global feature toggles on the DevTools shell were deferred because package-local opt-outs are simpler and avoid cross-package naming and versioning policy.

## Consequences

This is a breaking DevTools contract. Applications install the DevTools shell explicitly through `hubDevtools()` from `@vitehub/devtools`, while package integrations such as Chat register their own features and bridges. Missing shell integration should warn during development when package DevTools features are enabled, but it should not fail the application runtime.

The hosted client discovers available features through one DevTools-owned **DevTools Discovery Surface**. The current Vite implementation exposes that surface as a **DevTools Discovery RPC**. Feature registration starts with minimal metadata: feature identity, package ownership, title, icon, and bridge location. Local DevTools client development remains an internal repository workflow, not a user-facing integration mode.
