# Shell Package

Shell Package names ownership boundaries for `@vite-hub/shell`.

## Language

**Shell Package**:
The package that owns controlled Unix-like command environments for agent work.
_Avoid_: Sandbox package, terminal package

**Shell Runtime**:
A controlled Unix-like command execution environment with configured execution and file-system boundaries.
_Avoid_: Raw terminal, provider sandbox

**Shell Session**:
A stateful run of a Shell Runtime with working directory, environment, process, observation, and lifecycle state.
_Avoid_: One-shot command, tool call, exec helper

**Shell Workspace**:
The file-system boundary exposed to a Shell Runtime.
_Avoid_: Workspace package, host filesystem

**Workspace File System**:
The adapter that lets a Shell Runtime read or mutate workspace-backed files.
_Avoid_: Workspace Store, Blob Store

**Command Analysis**:
The inspection of a command before execution.
_Avoid_: Policy Decision, shell parsing

**Policy Decision**:
A caller-owned decision about whether a command may run, needs approval, or must be denied.
_Avoid_: Command Analysis, sandbox enforcement

**Shell Session Policy**:
The configured guardrails for command execution within a Shell Session.
_Avoid_: Workspace tool options, app step limit

**Approval Prompt**:
Structured command-risk context that a caller can show before making a Policy Decision.
_Avoid_: Policy Decision, raw command string

**Shell Observation**:
The structured event or result produced by a Shell Runtime while running a command.
_Avoid_: Raw output, log line

**Shell Process**:
A long-running command managed by a Shell Session.
_Avoid_: Terminal, background job

**Execution Provider**:
The adapter that performs command execution for a Shell Runtime.
_Avoid_: Shell Runtime, Workspace File System

**Shell Boundary**:
The declared execution, filesystem, network, process, streaming, timeout, and enforcement limits of a Shell Session.
_Avoid_: supports object, provider metadata

**Shell Network Grant**:
A declared network boundary that allows a Shell Session to run network commands against specific HTTP targets.
_Avoid_: Raw network access, URL allowlist

**Just Bash Provider**:
The built-in Execution Provider that runs Bash-compatible commands through `just-bash`.
_Avoid_: Shell Runtime, default Shell API

**Cloudflare Provider**:
The built-in Execution Provider that adapts a Cloudflare-compatible shell client to the Shell Runtime contract.
_Avoid_: Cloudflare runtime lifecycle, Shell Runtime

## Relationships

- The **Shell Package** owns **Shell Runtime** behavior.
- A **Shell Runtime** can create one or more **Shell Sessions**.
- **Shell Session** is the primary Shell Runtime interaction model.
- A **Shell Session** runs against one **Shell Workspace**.
- A **Workspace File System** adapts workspace-backed files to shell execution.
- **Command Analysis** can inform a **Policy Decision** before execution.
- **Command Analysis** can produce an **Approval Prompt**.
- A **Policy Decision** is owned by the caller, not by the Execution Provider.
- A **Shell Session Policy** bounds command timeout, output, repeated calls, process budget, and broad search behavior.
- A **Shell Runtime** emits **Shell Observations** with command, working directory, output, timing, termination, truncation, and lifecycle facts.
- A **Shell Session** can manage **Shell Processes** without promising full terminal emulation.
- A **Shell Session** has one **Shell Boundary**.
- A **Shell Boundary** may include **Shell Network Grants**.
- A **Shell Session** can expose network commands only when its **Shell Boundary** includes matching **Shell Network Grants**.
- Network command output is returned as a **Shell Observation** unless a separate Workspace policy explicitly materializes it.
- Controlled network command semantics belong to **Execution Providers** such as the **Just Bash Provider** and **Cloudflare Provider**.
- Controlled network requests are validated by the executing network command against **Shell Network Grants**, not by reconstructing request semantics from **Command Analysis**.
- Controlled network commands use normal command syntax while the provider validates the resulting request against **Shell Network Grants**.
- Controlled network commands may accept normal request body flags when the resulting request validates against **Shell Network Grants**.
- Model-facing guidance for controlled network commands belongs in Agent Driver Instructions or structured tool contracts, with **Capability Instruction Coverage** marking any `workspaceShell()`-specific prose.
- The **Shell Package** may expose the command/tool surface facts needed for that guidance, but it does not own a separate prompt template system or instruction slot.
- An **Execution Provider** backs a Shell Runtime without defining the Shell Package's public concept.
- The **Just Bash Provider** is the first built-in Execution Provider.
- The **Cloudflare Provider** is a thin built-in Execution Provider.
- Sandbox can provide a host for Shell Runtime execution, but Shell and Sandbox are separate package boundaries.

## Example Dialogue

> **Dev:** "Is Shell the same as Sandbox?"
> **Domain expert:** "No. **Shell Runtime** is the command surface; Sandbox is one possible isolated execution provider."

> **Dev:** "Can Workspace be the main Shell API?"
> **Domain expert:** "No. Workspace can supply a **Shell Workspace**, but **Shell Runtime** is the agent-facing command environment."

## Flagged Ambiguities

- Shell was considered equivalent to Sandbox - resolved: Shell owns command execution language; Sandbox owns isolated provider execution.
- Shell Workspace was considered the same as Workspace Store - resolved: **Shell Workspace** is the file-system boundary exposed to the shell, not persistence.
- Shell was considered a Workspace command helper - resolved: **Shell Package** owns the controlled command environment; Workspace integration is an adapter.
- Command Analysis was considered equivalent to allow/deny policy - resolved: **Command Analysis** produces facts; the caller owns the **Policy Decision**.
- One-shot command execution was considered as the main API - resolved: **Shell Session** is primary, while one-shot execution is convenience sugar over a short-lived session.
- Shell-owned allow/deny policy was considered as the default - resolved: Shell produces **Command Analysis** and **Approval Prompts**, while callers own final **Policy Decisions**.
- Minimal command output was considered enough for Shell results - resolved: **Shell Observations** carry structured execution and lifecycle facts for agent recovery, audit, and tests.
- Full interactive terminal UX was considered for the core contract - resolved: support **Shell Process** lifecycle for long-running commands, but do not make terminal emulation part of the first implementation.
- Workspace-specific shell guardrails were considered as ad hoc tool options - resolved: **Shell Session Policy** owns durable shell guardrail language; Workspace tools can adapt it.
- Root export compatibility was considered for existing provider and Workspace helpers - resolved: prefer a breaking export split while the package is pre-1.0 so the public surface stays simple.
- Removing the local Bash-compatible provider was considered for the redesign - resolved: keep the **Just Bash Provider** built in, but expose it as a provider adapter instead of the root Shell model.
- Moving Cloudflare shell support out of the package was considered - resolved: keep a thin built-in **Cloudflare Provider**, but do not let Cloudflare lifecycle concerns define the Shell core.
- A flat provider `supports` object was considered enough - resolved: use a richer **Shell Boundary** so policy, approval, tests, and provider portability can rely on explicit limits.
- Model-facing tool builders were considered as the Shell core identity - resolved: Shell core stays runtime-focused; Workspace and Agent surfaces adapt Shell into model-facing tools.
- `curl` was considered a separate HTTP Capability - resolved: controlled network commands belong to the **Shell Runtime** surface and are exposed only through **Shell Network Grants**.
- Controlled `curl` output was considered as an automatic Workspace write - resolved: return network command output as a **Shell Observation** in v1, leaving materialization to explicit Workspace policy.
- Workspace-level `curl` interception was considered - resolved: implement controlled network command behavior in **Execution Providers**, using Workspace only to supply grants and metadata.
- Parser-enforced `curl` policy was considered - resolved: **Command Analysis** may route or flag commands, but network request enforcement belongs to the executing provider command.
- Custom `curl`-like syntax was considered - resolved: controlled network commands use normal command syntax, with provider-owned validation of the resulting HTTP request.
- A Shell-owned prompt template for controlled network commands was considered - resolved: use Agent Driver Instructions plus **Capability Instruction Coverage** for `workspaceShell()` guidance, while Shell exposes structured tool/runtime facts.
- Disallowing normal `curl` body flags was considered - resolved: allow normal body flags when the resulting request validates against **Shell Network Grants**.
