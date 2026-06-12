# Explicit package-contributed provisioning over build-time or workflow-owned resource creation

The live e2e workflow accumulated ~150 lines of bash that create queues, R2 buckets, D1 databases, and Vercel blob stores before any ViteHub code runs — proving ViteHub lacked the provisioning primitive its own CI needed. We decided that provisioning is an explicit ViteHub CLI workflow (`vitehub provision`) composed of package-contributed Provision Steps (per ADR 0028's CLI contribution model), idempotent and strictly create-if-absent, talking to provider REST APIs through shared provider clients rather than shelling out to `wrangler`/`vercel`. Builds never provision: Vite Integrations may read provisioned identifiers but must not create provider resources, because builds that mutate cloud state are unpredictable in CI and hide effects from users.

## Considered Options

- **Build-time auto-provision** in the Vite plugins — rejected: builds gain network/auth side effects and silently mutate cloud state.
- **Central provisioner** in one package — rejected: each primitive's resource knowledge would leak out of the package that owns it.
- **Keep workflow bash** — rejected: it duplicates per-user plumbing ViteHub promises to own, and it can never serve users.

## Consequences

- Writeback splits by sensitivity: non-secret identifiers (database ids, bucket/queue names) go to gitignored Provision State (`.vitehub/provision.json`) read by Vite Integrations with explicit env vars taking precedence; secrets are pushed to the provider's env store and never written to disk.
- The Live Smoke workflow becomes the first consumer of `vitehub provision`, replacing its bash setup steps — CI dogfoods the user path.
