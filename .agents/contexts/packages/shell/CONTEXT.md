# Shell Package

Shell Package names ownership boundaries for `@vitehub/shell`.

## Language

**Shell Package**:
The package that owns controlled shell runtimes over workspace-like file systems.
_Avoid_: Sandbox package, terminal package

**Shell Runtime**:
A controlled command execution environment with a configured file-system boundary.
_Avoid_: Raw terminal, provider sandbox

**Shell Workspace**:
The file-system boundary exposed to a Shell Runtime.
_Avoid_: Workspace package, host filesystem

**Workspace File System**:
The adapter that lets a Shell Runtime read or mutate workspace-backed files.
_Avoid_: Workspace Store, Blob Store

**Command Analysis**:
The inspection of a command before execution.
_Avoid_: Policy decision, shell parsing

## Relationships

- The **Shell Package** owns **Shell Runtime** behavior.
- A **Shell Runtime** runs against one **Shell Workspace**.
- A **Workspace File System** adapts workspace-backed files to shell execution.
- **Command Analysis** can inform whether a command is acceptable before execution.
- Sandbox can provide a host for Shell Runtime execution, but Shell and Sandbox are separate package boundaries.

## Example Dialogue

> **Dev:** "Is Shell the same as Sandbox?"
> **Domain expert:** "No. **Shell Runtime** is the command surface; Sandbox is one possible isolated execution provider."

## Flagged Ambiguities

- Shell was considered equivalent to Sandbox - resolved: Shell owns command execution language; Sandbox owns isolated provider execution.
- Shell Workspace was considered the same as Workspace Store - resolved: **Shell Workspace** is the file-system boundary exposed to the shell, not persistence.
