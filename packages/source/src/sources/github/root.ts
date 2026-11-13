import { normalizeSafeSourcePath } from "../../core/path.ts"

export function normalizeGitHubRoot(path = "") {
  const root = path.replace(/\\/g, "/").split("/").filter(part => part !== ".").join("/")
  return normalizeSafeSourcePath(root, { allowEmpty: true, allowReserved: true }).split("/").filter(Boolean).join("/")
}
