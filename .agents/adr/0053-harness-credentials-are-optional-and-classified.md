# Harness Credentials Are Optional And Classified

Harness-backed Agent Drivers may omit `credentials`. When credentials are omitted, ViteHub lets the harness adapter use its default credential behavior, such as ambient CLI auth, provider-local login state, server-installed harness auth, or no credentials when the harness does not require them. ViteHub should classify the resolved **Harness Credential Source** for diagnostics, deployability checks, usage, approvals, and billing telemetry when the adapter can report it.

Explicit Harness Credential Source configuration belongs as a sibling option on the harness-backed Agent Driver, not inside provider adapter constructors such as `codex()`. Explicit deployable harness credential material should be declared and read through Env Package **Server Env** and **Secret Env**. The harness driver boundary may label, validate deployability, and attach billing identity metadata for the credential source, but it should not introduce provider-specific environment helper namespaces that duplicate Env Package behavior.

Deployment safety is a policy decision over the resolved source, not a reason to make the TypeScript option required. Development diagnostics should warn when omitted credentials resolve to an unknown or local-only source. Hosted production should fail when omitted credentials resolve to an unknown or known local-only source, and may proceed when the adapter classifies the source as deployable or the harness does not require credentials.

## Considered Options

- Requiring explicit credentials for every harness-backed Agent Driver was rejected because installed harnesses can already authenticate through their own local or server-side defaults.
- Hiding explicit credentials inside provider adapter constructors was rejected because Agent Package validation, diagnostics, redaction, deployability checks, and usage labeling need to run before the harness adapter executes.
- Putting harness credentials in Capabilities was rejected because credentials select who can run and pay for the harness execution path, which belongs to the harness-backed Agent Driver boundary.
- Adding provider-specific env helpers for explicit deployable harness credentials was rejected because Env Package owns environment declaration, runtime resolution, Secret Env redaction, and generated Server Env access.
- Treating omitted credentials as always deployable was rejected because ambient local login state, personal subscriptions, and unknown adapter defaults may not be reproducible on hosted production targets.
- Treating development and hosted production omitted-credential diagnostics as equivalent was rejected because local experiments need low-friction installed harness defaults while hosted production needs reproducible credential state.

## Consequences

The harness driver config stays ergonomic for local Codex or Claude Code-style experiments: `driver: { harness: codex() }` can work when the installed harness already has usable auth. The same shape can deploy only when the adapter can classify the omitted credential source as deployable or credentials are not required. Explicit `credentials` remains available when an app needs controlled deployable credentials or an explicit billing identity. Deployable explicit credentials flow through Env Package Server Env and Secret Env, with Secret Unseal delayed until the harness adapter boundary that needs the raw value. Usage, approval, and billing telemetry should record the resolved harness credential source label when available without exposing the underlying secret.
