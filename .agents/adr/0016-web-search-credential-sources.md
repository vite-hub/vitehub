# Web Search Credential Sources

The Web Search Capability requires an explicit single-provider policy in its first version and resolves credentials for that selected provider from explicit Secret Env resolvers first, then `VITEHUB_{PROVIDER}_API_KEY`, then canonical provider env vars such as `EXA_API_KEY` and `TAVILY_API_KEY`. It does not read `VITE_*` provider key variants because Vite treats that prefix as browser-exposed build language, and it does not invent `NITRO_*` provider key variants because Nitro naming is framework runtime-config language rather than Capability credential language.

## Considered Options

- Only explicit Secret Env resolvers were rejected because quick-start and existing `.env` provider-key workflows would be unnecessarily difficult.
- Only canonical provider env vars were rejected because ViteHub-scoped overrides let an app use a different credential without changing other tools that read the same provider env var.
- Automatic provider selection and provider fan-out were rejected for the first version because they make cost, privacy, and failure behavior less explicit.
- `VITE_*` provider key variants were rejected because they normalize an unsafe convention for secrets in Vite projects.
- `NITRO_*` provider key variants were rejected because provider credentials should use Capability credential language or Server Env, not framework runtime-config prefixes.
