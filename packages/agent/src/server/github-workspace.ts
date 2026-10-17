import { repoRef } from "@vite-hub/forge"
import { hasRuntimeType } from "../internal/runtime-type.ts"
import type { GitHubHost } from "./github-host.ts"

export interface GitHubWorkspaceRevision {
  repository: string
  revision: string
}

export interface GitHubWorkspaceInspector {
  list(workspace: GitHubWorkspaceRevision): Promise<string[]>
  read(workspace: GitHubWorkspaceRevision, path: string): Promise<{ content: string, path: string, revision: string, size: number }>
}

const previewLimit = 512 * 1024

/** Inspect an immutable GitHub revision without retaining an agent's disposable checkout. */
export function createGitHubWorkspaceInspector(host: Pick<GitHubHost, "forge">): GitHubWorkspaceInspector {
  function validate(workspace: GitHubWorkspaceRevision) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(workspace.repository)) throw new Error("Invalid GitHub repository.")
    if (!/^[0-9a-f]{40}$/i.test(workspace.revision)) throw new Error("Invalid Git revision.")
  }
  return {
    async list(workspace: GitHubWorkspaceRevision): Promise<string[]> {
      validate(workspace)
      const forge = await host.forge({ repository: workspace.repository })
      const tree = forge.contents.tree(repoRef(forge, workspace.repository), { ref: workspace.revision, recursive: true })
      const paths: string[] = []
      for await (const entry of tree) if (entry.type === "file") paths.push(entry.path)
      if (tree.warnings.some(warning => warning.code === "tree_truncated")) throw new Error("The Workspace tree is too large to inspect safely.")
      return paths.sort((left, right) => left.localeCompare(right))
    },
    async read(workspace: GitHubWorkspaceRevision, path: string) {
      validate(workspace)
      if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").some(part => !part || part === "." || part === "..")) {
        throw new Error("Invalid Workspace path.")
      }
      const forge = await host.forge({ repository: workspace.repository })
      const file = await forge.contents.file(repoRef(forge, workspace.repository), path, { ref: workspace.revision })
      if (file.encoding !== "binary") throw new Error("GitHub did not return a file.")
      if (file.content.byteLength > previewLimit) throw new Error("This file is too large to preview.")
      let content: string
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(file.content) }
      catch { throw new Error("This binary file cannot be previewed as text.") }
      if (content.includes("\0")) throw new Error("This binary file cannot be previewed as text.")
      return { content, path, revision: workspace.revision, size: file.content.byteLength }
    },
  }
}

/** Serve an invocation's immutable GitHub checkout through a host-managed route. */
export function createGitHubInvocationWorkspaceHandler(options: {
  host: Pick<GitHubHost, 'forge'>
  invocations: Pick<import('../invocations.ts').AgentInvocations, 'get'>
}): (id: string, path?: string) => Promise<Response> {
  const inspector = createGitHubWorkspaceInspector(options.host)
  return async (id, path) => {
    const invocation = await options.invocations.get(id)
    const repository = invocation?.annotations?.['github.repository']
    const revision = invocation?.annotations?.['github.head']
    if (!hasRuntimeType(repository, "string") || !hasRuntimeType(revision, "string")) return new Response('Workspace snapshot not found', { status: 404 })
    const workspace = { repository, revision }
    try {
      return Response.json(path === undefined ? { ...workspace, paths: await inspector.list(workspace) } : await inspector.read(workspace, path))
    }
    catch {
      return new Response('Workspace snapshot unavailable', { status: 422 })
    }
  }
}
