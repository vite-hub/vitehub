import { WorkspaceError } from "../core/errors.ts"
import { normalizeWorkspacePath } from "../core/path.ts"
import {
  commitGitHubChanges,
  createGitHubFileUpdate,
  githubWorkspaceStoreTarget,
  isWorkspaceFileEntry,
  readGitHubBranchState,
  requireGitHubOption,
  resolveGitHubBranchOption,
  resolveGitHubOption,
  resolveGitHubRepositoryOption,
  resolveGitHubRootOption,
  resolveGitHubTokenOption,
  type GitHubWorkspaceStoreTarget,
} from "../providers/github/shared.ts"

import type {
  GitHubWorkspaceOption,
  PublishContext,
  WorkspaceFile,
  WorkspacePublisher,
} from "../core/types.ts"

export type GitHubPublisherOption = GitHubWorkspaceOption

export interface GitHubPublisherOptions {
  branch?: GitHubPublisherOption
  message?: GitHubPublisherOption
  repo?: GitHubPublisherOption
  repository?: GitHubPublisherOption
  root?: GitHubPublisherOption
  token?: GitHubPublisherOption
}

interface GitHubPublisherFile extends WorkspaceFile {
  bytes: Uint8Array
  fullPath: string
  gitSha: string
}

function resolveMessage(options: GitHubPublisherOptions, ctx: PublishContext): string {
  return ctx.snapshot?.name
    || resolveGitHubOption(options.message)
    || "chore: update workspace snapshot"
}

function resolveActiveGitHubStoreTarget(ctx: PublishContext): GitHubWorkspaceStoreTarget | undefined {
  const configuredStore = ctx.workspace.store
  if (configuredStore && "provider" in configuredStore && configuredStore.provider === "github") {
    const repository = resolveGitHubRepositoryOption(configuredStore)
    if (repository) return { branch: resolveGitHubBranchOption(configuredStore), repository }
  }
  return (ctx.store as unknown as {
    [githubWorkspaceStoreTarget]?: () => GitHubWorkspaceStoreTarget
  })[githubWorkspaceStoreTarget]?.()
}

async function readFiles(ctx: PublishContext, root: string): Promise<GitHubPublisherFile[]> {
  const entries = await ctx.store.list("", { recursive: true })
  return await Promise.all(entries.filter(isWorkspaceFileEntry).map(async (entry) => {
    const file = await ctx.store.readFile(entry.path)
    if (!file) throw new WorkspaceError(`[vitehub] Workspace file disappeared before GitHub publish: ${entry.path}.`)
    const update = await createGitHubFileUpdate(entry.path, root, file.content)
    return {
      ...file,
      path: normalizeWorkspacePath(entry.path),
      ...update,
    }
  }))
}

export function github(options: GitHubPublisherOptions = {}): WorkspacePublisher {
  return {
    name: "github",
    async publish(ctx) {
      const repository = requireGitHubOption("publisher", "a repository", resolveGitHubRepositoryOption(options))
      const branch = resolveGitHubBranchOption(options)
      const root = resolveGitHubRootOption(options, ctx.workspace.name)
      const token = requireGitHubOption("publisher", "a token", resolveGitHubTokenOption(options))
      const storeTarget = resolveActiveGitHubStoreTarget(ctx)
      if (!ctx.durable && storeTarget?.repository === repository && storeTarget.branch === branch) {
        throw new WorkspaceError(
          `[vitehub] GitHub publisher cannot publish to ${repository}@${branch} while it backs the active GitHub Workspace Store. Use workspace.snapshot() for that branch or configure the publisher to use a different repository or branch.`,
        )
      }
      const files = await readFiles(ctx, root)
      const nextPaths = new Set(files.map(file => file.path))

      const remote = await readGitHubBranchState({ branch, kind: "publisher", repository, root, token })
      const changedFiles = files.filter(file => remote.files.get(file.path)?.sha !== file.gitSha)
      const deletePaths = [...remote.files]
        .filter(([path]) => !nextPaths.has(path))
        .map(([, entry]) => entry.path)

      if (!changedFiles.length && !deletePaths.length) return

      await commitGitHubChanges({
        baseTreeSha: remote.treeSha,
        branch,
        branchExists: remote.branchExists,
        deletePaths,
        files: changedFiles,
        kind: "publisher",
        message: resolveMessage(options, ctx),
        parentSha: remote.refSha,
        repository,
        token,
      })
    },
  }
}
