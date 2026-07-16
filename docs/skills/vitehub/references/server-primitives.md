# Server Primitives

Use this for application-owned storage, scheduling, environment, messaging, execution, or infrastructure behavior that does not need model judgment.

## Choose the primitive

When the primitive is known, open only its raw docs page, such as `https://vitehub.dev/raw/docs/server-primitives/kv.md`. Use the [Server Primitives index](https://vitehub.dev/raw/docs/server-primitives.md) only when choosing between primitives. Confirm the selected primitive's Vite Integration, optional Definition, Runtime Helper, local driver, and host support.

Common composition:

```text
vite.config.ts           provider and integration
server/<definitions>/    named discovered configuration when required
application server code stable Runtime Helper calls
.vitehub/                generated registry and diagnostics
provider output          deployment artifact when applicable
```

With the current facade, register `vitehub()` from `vite-hub` and import application APIs from feature subpaths such as `vite-hub/kv` or `vite-hub/blob`. Validate those paths against installed exports before coding.

## Authority

Runtime Helpers called by application code keep authority in the application. If an Agent needs the same behavior, grant the narrow Capability documented for that feature; do not make every application primitive an Agent tool.

## Provider boundary

Keep provider selection in Vite config or the documented Definition. Application code should remain on stable Runtime Helpers when moving from a local driver to a hosted provider.

## Proof

Register the integration, execute the Runtime Helper, and observe the expected provider effect. For persistence, restart the process and read the value again. For a hosted target, also inspect the documented Provider Output.
