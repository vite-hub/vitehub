# Vite-Only Framework Integration

ViteHub's framework integration surface is Vite-only. Packages expose Vite Integrations, Stable ViteHub Import Paths, Runtime Registries, Runtime Helpers, and Provider Output. Nitro is not a ViteHub-owned Framework Integration, Server Host Adapter, internal compatibility adapter, example target, or test target.

Package-specific `@vite-hub/*/nitro` modules, generated Nitro plugins, Vite plugin `.nitro` adapters, and Nitro-specific discovery modes are removed. Server directory discovery belongs to ViteHub's Vite Integration, not to Nitro.

## Considered Options

- Keeping Vite and Nitro as equal public integrations was rejected because it duplicates package setup, makes users choose between framework surfaces, and preserves host-specific plumbing as ViteHub API.
- Keeping Nitro compatibility internally was rejected because it preserves a second integration architecture and keeps host-specific plumbing alive as hidden ViteHub behavior.
- Treating `server/**` discovery as Nitro-owned was rejected for the long-term model. Server file conventions can remain compatibility or host conventions, but Discovery Identity belongs to ViteHub's package-owned discovery rules.

## Consequences

Docs, examples, playgrounds, manual actions, package exports, and package tests should teach and validate Vite Integrations only.

Package-specific public `./nitro` exports, internal Nitro adapter paths, generated Nitro runtime plugins, and Vite plugin `.nitro` properties should stay removed. If a downstream app uses Nitro, that app can compose ViteHub runtime helpers explicitly; ViteHub packages do not own Nitro wiring.

ADR 0025 remains correct about location-derived Discovery Identity, but server discovery should be read as ViteHub-owned Vite discovery rather than Nitro discovery.
