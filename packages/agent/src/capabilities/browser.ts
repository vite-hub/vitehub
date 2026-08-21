import { defineCapability, workspaceMaterializationPathsSymbol } from "../capability-runtime.ts"

import type { AgentCapabilityDefinition } from "../types.ts"

export interface BrowserCapabilityOptions {
  command?: string
  skillContent?: string
  skillPath?: string
  sourceKey?: string
}

const defaultBrowserSkillContent = `# Browser

Use the \`agent-browser\` CLI through the provider's shell for headless browser work.

- Run \`agent-browser --help\` before non-trivial browser work.
- Create \`screenshots/\` before screenshots, then save screenshots inside that workspace directory.
`

function normalizeSkillPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "") || "skills/browser/SKILL.md"
}

function assertCommand(command: string): string {
  if (!command || /[\s\x00-\x1F\x7F/]/.test(command) || command === "." || command === "..") {
    throw new TypeError("[vitehub] browser({ command }) must be a single executable name.")
  }
  return command
}

export function browser(options: BrowserCapabilityOptions = {}): AgentCapabilityDefinition {
  const command = assertCommand(options.command || "agent-browser")
  const skillPath = normalizeSkillPath(options.skillPath || "skills/browser/SKILL.md")
  const sourceKey = options.sourceKey || "skill.browser"
  const skillContent = options.skillContent || defaultBrowserSkillContent.replaceAll("agent-browser", command)

  return Object.assign(defineCapability({
    id: "browser",
    metadata: { command, skillPath, sourceKey },
    requires: [{ primitive: "workspace", workspace: { mode: "write", required: true } }],
    prepare(context) {
      if (context.driver?.kind !== "provider") throw new Error("[vitehub] browser() requires a Provider Agent Driver.")
    },
    workspace: {
      sources: {
        [sourceKey]: {
          content: skillContent,
          mediaType: "text/markdown",
          workspacePath: skillPath,
        },
      },
    },
  }), {
    [workspaceMaterializationPathsSymbol]: [skillPath],
  })
}
