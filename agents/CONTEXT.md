# ViteHub Agent Skills

This context describes the language for workspace-backed agent skills in ViteHub.

## Language

**Tool**:
A developer-defined, tested operation that an agent can call.
_Avoid_: Capability

**Skill**:
A Markdown instruction bundle that shapes agent behavior without naming implementation-specific tools.
_Avoid_: Capability, Tool

**Draft Skill**:
A proposed Skill that has been interpreted from a user request but is not yet written to the Skills Directory.
_Avoid_: Skill when not yet confirmed

**Skill Authoring**:
The Agent feature that injects skill-writing guidance and validates Skill file writes.
_Avoid_: Capability authoring

**Skills Directory**:
The workspace-relative directory where Skills are read and written.
_Avoid_: Local path, filesystem path

**Skill Lint**:
A validation pass that checks Skill files follow the expected frontmatter and Markdown shape.
_Avoid_: Typecheck

**Skill Write Validation**:
Runtime validation attached to developer-exposed `writeFile` calls when the target path is inside the Skills Directory.
_Avoid_: Generated write tool

## Relationships

- A **Draft Skill** becomes a **Skill** only after explicit confirmation
- A **Draft Skill** lives in conversation until confirmed
- **Skill Authoring** includes skill-writing guidance and runtime validation for Skill file writes
- A **Skills Directory** is always a workspace path
- Enabling **Skills** requires and enables an Agent Workspace
- Existing **Skills** in the **Skills Directory** are adopted rather than overwritten
- **Skill Lint** keeps **Skills** aligned with the Skill file format
- **Skill Write Validation** runs only when a developer-exposed `writeFile` targets a Skill file
- **Tools** are selected by the agent runtime, not named by **Skills**

## Example Dialogue

> **Dev:** "Should this Telegram user get a new **Tool**?"
> **Domain expert:** "No, the **Tool** already exists. The user is adding a **Skill** that describes how their agent should behave."

## Flagged Ambiguities

- "tool" was used to mean both developer-defined operations and user-added functionality — resolved: **Tool** is developer-defined and tested; **Skill** is user-facing behavior.
- "capability" conflicted with `@vitehub/runtime` capability handles — resolved: user-facing customization is called a **Skill**.
- "skill store" was considered as a separate persistence layer — resolved: Skills v1 stores **Skills** as files in a Workspace.
- "draft" was considered as workspace state — resolved: **Draft Skills** live only in conversation until explicit confirmation.
- "skills directory" was considered as a local filesystem path — resolved: the **Skills Directory** is always workspace-relative.
