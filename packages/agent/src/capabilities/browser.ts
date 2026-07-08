import { defineCapability, workspaceMaterializationPathsSymbol } from "../capability-runtime.ts"

import type { AgentCapabilityDefinition } from "../types.ts"

export interface BrowserCapabilityOptions {
  command?: string
  skillContent?: string
  skillPath?: string
  sourceKey?: string
}

const defaultBrowserSkillContent = `# Browser

Use the \`agent-browser\` CLI through the bash tool for headless browser work.

- Run \`agent-browser --help\` before non-trivial browser work.
- Save screenshots inside the workspace, usually under \`screenshots/\`.
- Upload selected screenshots with \`blob_edit\` using \`workspacePath\`.
- Include the public URL returned by Blob when referencing uploaded assets.
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
    bash: [{ command, description: "Run headless browser." }],
    id: "browser",
    metadata: { command, skillPath, sourceKey },
    requires: [{ primitive: "workspace", workspace: { mode: "write", required: true } }],
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
