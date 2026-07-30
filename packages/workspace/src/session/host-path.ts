import { posix } from "node:path"

import { workspaceError } from "../core/errors.ts"
import { normalizeSafeWorkspacePath } from "../core/path.ts"

export function normalizeHostTarget(target = "/workspace") {
  const normalized = posix.resolve("/", target.replace(/\\/g, "/"))
  if (normalized === "/") throw workspaceError("[vitehub] Workspace session target cannot be the host root.")
  return normalized
}

export function toHostPath(root: string, path = "") {
  const normalized = normalizeSafeWorkspacePath(path, { allowEmpty: true })
  return normalized ? posix.join(root, normalized) : root
}

export function toHostCwd(root: string, cwd: string | undefined) {
  if (cwd === undefined) return root
  if (!posix.isAbsolute(cwd)) return toHostPath(root, cwd)
  const normalized = posix.normalize(cwd)
  if (normalized === root || normalized.startsWith(`${root}/`)) return normalized
  if (normalized === "/workspace" || normalized.startsWith("/workspace/"))
    return toHostPath(root, normalized.slice("/workspace".length))
  throw workspaceError(`[vitehub] Workspace exec cwd must stay inside ${root}: ${cwd}.`)
}
