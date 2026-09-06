import { defineCapability, workspaceMaterializationPathsSymbol } from "../capability-runtime.ts"
import { toAgentRunResult } from "../agent-output.ts"
import { readAgentWorkspaceDiff } from "../agent-workspace-runtime.ts"
import { normalizeDeliveryArtifactPath } from "../delivery-artifacts.ts"
import { isRuntimeRecord } from "../internal/runtime-type.ts"
import { cloneWithPropertyDescriptors } from "../internal/stream-result.ts"

import type { AgentCapabilityDefinition, AgentDeliveryArtifact } from "../types.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"

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
- To attach a screenshot to the final reply, add \`![Description](screenshots/name.png)\` on its own line. ViteHub removes the marker and sends the file.
`

const screenshotRoot = "screenshots"
const screenshotMediaTypes: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
}

function normalizeSkillPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "") || "skills/browser/SKILL.md"
}

function assertCommand(command: string): string {
  if (!command || /[\s\x00-\x1F\x7F/]/.test(command) || command === "." || command === "..") {
    throw agentDiagnostics.AGENT_R0025({ message: "[vitehub] browser({ command }) must be a single executable name." })
  }
  return command
}

function screenshotReferencePath(reference: string): { mediaType: string, path: string } | undefined {
  const normalizedReference = reference.trim().replace(/\\/g, "/")
  if (normalizedReference.startsWith("//")) return
  const workspaceRelative = normalizedReference.match(/^\/workspace\/(.+)$/)?.[1]
  const sessionRelative = workspaceRelative?.match(/^[^/]+\/(.+)$/)?.[1]
  const candidates = workspaceRelative
    ? [workspaceRelative, ...(sessionRelative ? [sessionRelative] : [])]
    : normalizedReference.startsWith("/") ? [] : [normalizedReference]
  for (const candidate of candidates) {
    let path: string
    try {
      path = normalizeDeliveryArtifactPath(candidate)
    }
    catch {
      continue
    }
    const mediaType = screenshotMediaTypes[path.split(".").pop()?.toLowerCase() || ""]
    if (path.startsWith(`${screenshotRoot}/`) && mediaType) return { mediaType, path }
  }
}

function attachBrowserScreenshots(
  result: unknown,
  context: Parameters<NonNullable<AgentCapabilityDefinition["output"]>>[0],
): unknown {
  const diff = readAgentWorkspaceDiff(context.context)
  const runResult = toAgentRunResult(result)
  if (!diff || !runResult.text) return result
  const changedPaths = new Set(diff.entries.flatMap(entry =>
    (entry.type === "added" || entry.type === "modified") && entry.after?.type === "file" ? [entry.path] : [],
  ))
  const screenshots = new Map<string, AgentDeliveryArtifact>()
  const text = runResult.text.replace(
    /!\[([^\]\r\n]*)\]\(\s*<?([^\s)<>]+)>?\s*\)/g,
    (match, alt: string, reference: string) => {
      const screenshot = screenshotReferencePath(reference)
      if (!screenshot || !changedPaths.has(screenshot.path)) return match
      const artifact: AgentDeliveryArtifact = {
        mediaType: screenshot.mediaType,
        path: screenshot.path,
        placement: "attachment",
      }
      const trimmedAlt = alt.trim()
      if (trimmedAlt) artifact.alt = trimmedAlt
      screenshots.set(screenshot.path, artifact)
      return ""
    },
  )
  if (!screenshots.size) return result
  const artifacts = new Map<string, AgentDeliveryArtifact>(screenshots)
  for (const artifact of runResult.artifacts || []) artifacts.set(artifact.path, artifact)
  const nextText = text.replace(/\n{3,}/g, "\n\n").trim()
  if (isRuntimeRecord(result)) {
    return cloneWithPropertyDescriptors(result, {
      artifacts: {
        configurable: true,
        enumerable: true,
        value: [...artifacts.values()],
        writable: true,
      },
      text: {
        configurable: true,
        enumerable: true,
        value: nextText,
        writable: true,
      },
    })
  }
  return {
    ...runResult,
    artifacts: [...artifacts.values()],
    text: nextText,
  }
}

export function browser(options: BrowserCapabilityOptions = {}): AgentCapabilityDefinition {
  const command = assertCommand(options.command || "agent-browser")
  const skillPath = normalizeSkillPath(options.skillPath || "skills/browser/SKILL.md")
  const sourceKey = options.sourceKey || "skill.browser"
  const skillContent = options.skillContent || defaultBrowserSkillContent.replaceAll("agent-browser", command)

  return Object.assign(defineCapability({
    id: "browser",
    metadata: { command, skillPath, sourceKey },
    output(context) {
      if (context.driver?.kind === "provider") {
        context.output.final(result => attachBrowserScreenshots(result, context), { order: "last" })
      }
    },
    requires: [{ primitive: "workspace", workspace: { mode: "write", required: true } }],
    prepare(context) {
      if (context.driver?.kind !== "provider") throw agentDiagnostics.AGENT_R0026({ message: "[vitehub] browser() requires a Provider Agent Driver." })
    },
    workspace: {
      rules: {
        [`${screenshotRoot}/**`]: { commit: true, write: true },
      },
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
