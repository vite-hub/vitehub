# Vite-Only Framework Integration

Updated by [ADR 0051: Schedule Provider Wake Allows Nitro Cloudflare Wiring](./0051-schedule-provider-wake-allows-nitro-cloudflare-wiring.md): ViteHub remains Vite-only for public framework integrations, but Schedule may generate package-owned Nitro Cloudflare hook/config wiring as a narrow Provider Wake exception.

Updated by [ADR 0056: Workspace Hosted Runtime Setup Allows Nuxt Nitro Handoff](./0056-workspace-hosted-runtime-setup-allows-nuxt-nitro-handoff.md): Workspace may expose a narrow Nuxt module that installs the existing Vite Integration and merges generated hosted Workspace runtime setup into Nuxt's top-level Nitro config.

ViteHub's framework integration surface is Vite-only. Packages expose Vite Integrations, Stable ViteHub Import Paths, Runtime Registries, Runtime Helpers, and Provider Output. Nitro is not a ViteHub-owned Framework Integration, Server Host Adapter, internal compatibility adapter, example target, or test target.

Package-specific `@vite-hub/*/nitro` modules, generated Nitro plugins, Vite plugin `.nitro` adapters, and Nitro-specific discovery modes are removed except for ADR 0051's Schedule Provider Wake exception. Server directory discovery belongs to ViteHub's Vite Integration, not to Nitro.

## Considered Options

- Keeping Vite and Nitro as equal public integrations was rejected because it duplicates package setup, makes users choose between framework surfaces, and preserves host-specific plumbing as ViteHub API.
- Keeping Nitro compatibility internally was rejected because it preserves a second integration architecture and keeps host-specific plumbing alive as hidden ViteHub behavior.
- Treating `server/**` discovery as Nitro-owned was rejected for the long-term model. Server file conventions can remain compatibility or host conventions, but Discovery Identity belongs to ViteHub's package-owned discovery rules.

## Consequences

Docs, examples, playgrounds, manual actions, package exports, and package tests should teach and validate Vite Integrations only.

Package-specific public `./nitro` exports, internal Nitro adapter paths, generated Nitro runtime plugins, and Vite plugin `.nitro` properties should stay removed except for ADR 0051's Schedule Provider Wake exception. If a downstream app uses Nitro outside that exception, that app can compose ViteHub runtime helpers explicitly; ViteHub packages do not own general Nitro wiring.

ADR 0025 remains correct about location-derived Discovery Identity, but server discovery should be read as ViteHub-owned Vite discovery rather than Nitro discovery.
