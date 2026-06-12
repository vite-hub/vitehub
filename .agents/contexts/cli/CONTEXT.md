# CLI

CLI names the command-line surface for ViteHub-owned developer workflows.

## Reference

- [Peter Steinberger's create-cli skill](https://github.com/steipete/agent-scripts/tree/737040cf3a196b1a11aeb1c1c7508ce721545745/skills/create-cli) is the standing rubric for ViteHub CLI design: human-first, script-friendly, explicit about help, output, errors, config, and safety.
- [Peter Steinberger's create-cli references](https://github.com/steipete/agent-scripts/tree/737040cf3a196b1a11aeb1c1c7508ce721545745/skills/create-cli/references) are the standing reference set for CLI behavior details.

## Language

**ViteHub CLI**:
The command-line surface for ViteHub-owned developer workflows.
_Avoid_: Evalite wrapper, agent eval product

**Agent Eval Runner**:
The ViteHub CLI responsibility that runs Agent Evals with ViteHub defaults.
_Avoid_: Evalite CLI, benchmark runner

**Domain-Owned Command**:
A ViteHub CLI command grouped by the domain or package that owns the workflow.
_Avoid_: Frequency-owned command, flat command, shortcut-first command

**Agent Eval Target**:
An optional eval file path filter that narrows the Agent Evals run by the Agent Eval Runner.
_Avoid_: Required suite name, eval display name

**Agent Eval Output Mode**:
The selected output contract for Agent Eval Runner results.
_Avoid_: Logger mode, reporter implementation

**Integration-Owned CLI Option**:
A command-exposure or command-plumbing option configured through the package's Vite Integration or an internal Server Host Adapter.
_Avoid_: domain behavior option, ViteHub config file option, standalone CLI config

**CLI Command Namespace**:
A package-owned ViteHub CLI command group that collects related CLI Features.
_Avoid_: CLI package, plugin command, top-level shortcut

**CLI Feature**:
A package-owned workflow exposed inside a CLI Command Namespace.
_Avoid_: Product, package, raw subcommand

**CLI Primitive**:
An internal ViteHub contract for registering CLI Command Namespaces, CLI Features, options, output modes, and execution metadata.
_Avoid_: Public CLI API, command builder, app config

**CLI Contributor**:
A package integration that registers a CLI Command Namespace or CLI Feature through CLI Primitives.
_Avoid_: CLI plugin, standalone command package

**Provision**:
The ViteHub CLI workflow that idempotently creates missing provider resources required by an app's Definitions, without ever deleting or mutating existing ones.
_Avoid_: Ensure (taken by runtime blob validation), setup script, deploy

**Provision Step**:
A package-contributed unit of provisioning owned by the primitive package whose resource it creates.
_Avoid_: Workflow bash, central provisioner, provider script

**Provision State**:
The gitignored local record of non-secret provisioned identifiers that Vite Integrations read as a binding-id source.
_Avoid_: Secrets file, env file, GitHub output

## Relationships

- The **ViteHub CLI** may expose workflows owned by multiple ViteHub packages.
- The **ViteHub CLI** prefers **Domain-Owned Commands** over top-level commands optimized only for frequency.
- The **ViteHub CLI** should prefer package integration surfaces over a repository-level ViteHub config file.
- A package can contribute one **CLI Command Namespace** to the **ViteHub CLI**.
- A **CLI Command Namespace** can expose multiple **CLI Features**.
- **CLI Primitives** are internal and define how **CLI Contributors** register command namespaces, features, options, output modes, and execution metadata.
- A package integration acts as the **CLI Contributor** for its own package-owned command namespace or feature.
- The **Agent Eval Runner** is the first responsibility of the **ViteHub CLI**.
- The **Agent Eval Runner** runs **Agent Evals** without making Evalite the public abstraction.
- `vitehub agent eval` is the canonical **Domain-Owned Command** for the **Agent Eval Runner**.
- `agent` is the Agent Package's **CLI Command Namespace**.
- `eval` is the first Agent Package **CLI Feature**.
- The **Agent Eval Runner** runs all discovered Agent Evals when no **Agent Eval Target** is provided.
- An **Agent Eval Target** identifies Agent Eval files by path filter.
- **Agent Eval Output Mode** defaults to concise human output and can be changed to script-friendly structured output.
- Durable Agent Eval Runner defaults should come from built-in defaults or `agent.eval` on the Agent Package integration surface.
- `vitehub provision` is the canonical command for **Provision**; it aggregates package-contributed **Provision Steps**.
- A **Provision Step** talks to provider APIs through shared provider clients, not by shelling out to provider CLIs.
- **Provision** writes non-secret identifiers to **Provision State** and pushes secrets to the provider's env store; secrets never land on disk.
- Explicit environment variables override **Provision State** when both name the same binding.
- Builds never provision: a Vite Integration may read **Provision State** but must not create provider resources.

## Example dialogue

> **Dev:** "Are we creating an Evalite wrapper?"
> **Domain expert:** "No. We are creating the **ViteHub CLI**, and its first responsibility is the **Agent Eval Runner**."
>
> **Dev:** "Should the command be `vitehub eval` because it is shorter?"
> **Domain expert:** "No. Use `vitehub agent eval` because **Domain-Owned Commands** make ownership clear before shortcuts exist."
>
> **Dev:** "Do I need to pass the support agent name every time?"
> **Domain expert:** "No. Without an **Agent Eval Target**, the **Agent Eval Runner** runs all discovered Agent Evals."
>
> **Dev:** "Should we add `vitehub.config.ts` for eval defaults?"
> **Domain expert:** "No. Prefer the existing package integration surfaces. Agent Eval defaults belong under `agent.eval`; command exposure options can stay under CLI-specific config."
>
> **Dev:** "Is `agent` itself a CLI feature?"
> **Domain expert:** "No. `agent` is a **CLI Command Namespace**; `eval` and future workflows like `doctor` are **CLI Features** inside it."
>
> **Dev:** "Should app developers call CLI registration primitives directly?"
> **Domain expert:** "No. **CLI Primitives** are internal; package integrations act as **CLI Contributors**."

## Flagged ambiguities

- "CLI" was used to mean a standalone eval product - resolved: use **ViteHub CLI** for the durable command-line surface and **Agent Eval Runner** for the first responsibility inside it.
- Top-level `vitehub eval` was considered for convenience - resolved: use `vitehub agent eval` as the canonical **Domain-Owned Command**.
- Required eval arguments were considered for explicitness - resolved: use optional **Agent Eval Targets** so the zero-argument command runs discovered Agent Evals.
- `vitehub.config.ts` was considered for CLI defaults - resolved: prefer existing Vite Integration surfaces and internal host-adapter behavior, with durable Agent Eval defaults under `agent.eval` rather than `agent.cli.eval`.
- Package-contributed CLI behavior was described as one command with many features - resolved: use **CLI Command Namespace** for the package-owned command group and **CLI Feature** for workflows inside it.
- CLI registration was considered as public app API - resolved: use internal **CLI Primitives** and package-owned **CLI Contributors**.
