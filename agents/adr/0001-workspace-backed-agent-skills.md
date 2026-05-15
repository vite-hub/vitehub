# Use Workspace-Backed Agent Skills

We decided to add Skills as a first-class Agent option backed by Workspace files instead of creating a separate Forge/Atelier package, store, or plugin system. Skills are Markdown files under a workspace-relative Skills Directory, indexed from frontmatter, and optionally authored through developer-exposed workspace write tools with Skill validation. This keeps storage and provider behavior inside the existing Workspace boundary while giving agents a simple way to grow behavior over time.

## Considered Options

- Add a separate Forge or Atelier package with its own KV/DB store.
- Add a general plugin/preset system that can inject workspace sources, instructions, tools, routes, and future MCP integrations.
- Add a root `skills` Agent option that enables workspace-backed Skills directly.

## Consequences

`skills: true` enables an Agent Workspace and adopts existing files in the Skills Directory. `skills.authoring: true` injects skill-writing guidance and validates writes through a developer-exposed `writeFile` tool when the target path is a Skill file. Draft Skills remain in conversation until explicit user confirmation.
