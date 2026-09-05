import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts"
import type { GitHubHost } from "./github-host.ts"

export interface GitHubWorkspaceRevision {
  repository: string
  revision: string
}

export interface GitHubWorkspaceInspector {
  list(workspace: GitHubWorkspaceRevision): Promise<string[]>
  read(workspace: GitHubWorkspaceRevision, path: string): Promise<{ content: string, path: string, revision: string, size: number }>
}

/** Inspect an immutable GitHub revision without retaining an agent's disposable checkout. */
export function createGitHubWorkspaceInspector(host: Pick<GitHubHost, "command">): GitHubWorkspaceInspector {
  function validate(workspace: GitHubWorkspaceRevision) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(workspace.repository)) throw new Error("Invalid GitHub repository.")
    if (!/^[0-9a-f]{40}$/i.test(workspace.revision)) throw new Error("Invalid Git revision.")
  }
  return {
    async list(workspace: GitHubWorkspaceRevision): Promise<string[]> {
      validate(workspace)
      const result = await host.command([
        "api", "--method", "GET", "-f", "recursive=1",
        `repos/${workspace.repository}/git/trees/${workspace.revision}`,
      ], { repository: workspace.repository })
      const payload: unknown = JSON.parse(result.stdout)
      if (!isRuntimeRecord(payload)) throw new Error("GitHub did not return a Workspace tree.")
      if (payload.truncated === true) throw new Error("The Workspace tree is too large to inspect safely.")
      if (!Array.isArray(payload.tree)) throw new Error("GitHub did not return a Workspace tree.")
      return payload.tree.flatMap((entry: unknown) => {
        if (!isRuntimeRecord(entry)) return []
        const item = entry
        return item.type === "blob" && hasRuntimeType(item.path, "string") ? [item.path] : []
      }).sort((left, right) => left.localeCompare(right))
    },
    async read(workspace: GitHubWorkspaceRevision, path: string) {
      validate(workspace)
      if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").some(part => !part || part === "." || part === "..")) {
        throw new Error("Invalid Workspace path.")
      }
      const endpoint = path.split("/").map(encodeURIComponent).join("/")
      const result = await host.command([
        "api", "--method", "GET", "-f", `ref=${workspace.revision}`,
        `repos/${workspace.repository}/contents/${endpoint}`,
      ], { repository: workspace.repository })
      const payload: unknown = JSON.parse(result.stdout)
      if (!isRuntimeRecord(payload)) throw new Error("GitHub did not return a file.")
      if (payload.type !== "file" || !hasRuntimeType(payload.content, "string")) throw new Error("GitHub did not return a file.")
      if (!hasRuntimeType(payload.size, "number") || payload.size > 512 * 1024) throw new Error("This file is too large to preview.")
      if (payload.encoding !== "base64") throw new Error("This file cannot be previewed as text.")
      const bytes = Buffer.from(payload.content.replaceAll(/\s/g, ""), "base64")
      if (bytes.byteLength > 512 * 1024) throw new Error("This file is too large to preview.")
      let content: string
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
      catch { throw new Error("This binary file cannot be previewed as text.") }
      if (content.includes("\0")) throw new Error("This binary file cannot be previewed as text.")
      return { content, path, revision: workspace.revision, size: bytes.byteLength }
    },
  }
}

/** Serve an invocation's immutable GitHub checkout through a host-managed route. */
export function createGitHubInvocationWorkspaceHandler(options: {
  host: Pick<GitHubHost, 'command'>
  invocations: Pick<import('../invocations.ts').AgentInvocations, 'get'>
}): (id: string, path?: string) => Promise<Response> {
  const inspector = createGitHubWorkspaceInspector(options.host)
  return async (id, path) => {
    const invocation = await options.invocations.get(id)
    const repository = invocation?.annotations?.['github.repository']
    const revision = invocation?.annotations?.['github.head']
    if (typeof repository !== 'string' || typeof revision !== 'string') return new Response('Workspace snapshot not found', { status: 404 })
    const workspace = { repository, revision }
    try {
      return Response.json(path === undefined ? { ...workspace, paths: await inspector.list(workspace) } : await inspector.read(workspace, path))
    }
    catch {
      return new Response('Workspace snapshot unavailable', { status: 422 })
    }
  }
}
