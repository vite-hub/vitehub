import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { SandboxSession } from "@vite-hub/sandbox"

import type { CodexWorkspaceWriteAccess } from "../types.ts"

const homeCaches = [".local/share/pnpm", ".cache/pnpm", ".cache/node/corepack", ".npm"]
const sandboxCachesScript = `for d in "\${npm_config_store_dir:-}" "\${npm_config_cache_dir:-}"${homeCaches.map(path => ` "$HOME/${path}"`).join("")}; do case "$d" in /*) mkdir -p "$d" 2>/dev/null && printf '%s\\n' "$d";; esac; done; true`

/** Package manager caches on this host, as the provider environment names them. */
async function hostPackageCaches(environment: Readonly<Record<string, string | undefined>>): Promise<string[]> {
  const home = environment.HOME || homedir()
  const roots = [environment.npm_config_store_dir, environment.npm_config_cache_dir, ...homeCaches.map(path => join(home, path))]
    .filter((path): path is string => typeof path === "string" && isAbsolute(path))
  const created = await Promise.all(roots.map(path => mkdir(path, { recursive: true }).then(() => path, () => undefined)))
  return created.filter((path): path is string => path !== undefined)
}

/** Package manager caches inside a Sandbox. The host's cache paths do not exist there. */
async function sandboxPackageCaches(session: SandboxSession, signal?: AbortSignal): Promise<string[]> {
  const result = await session.exec("sh", ["-c", sandboxCachesScript], { signal })
  return result.ok ? result.stdout.split("\n").filter(path => path.startsWith("/")) : []
}

/**
 * Codex `workspaceWrite` sandbox policy with the access that `driver.workspaceWrite` adds.
 * Returns undefined when it adds nothing, so the runtime mode keeps its default sandbox.
 */
export async function codexWorkspaceWritePolicy(
  access: CodexWorkspaceWriteAccess | undefined,
  where: { environment: Readonly<Record<string, string | undefined>> } | { sandbox: SandboxSession, signal?: AbortSignal },
): Promise<{ type: "workspaceWrite", networkAccess: boolean, writableRoots: string[] } | undefined> {
  if (!access?.network && !access?.packageCaches) return
  const writableRoots = !access.packageCaches
    ? []
    : "sandbox" in where
      ? await sandboxPackageCaches(where.sandbox, where.signal)
      : await hostPackageCaches(where.environment)
  return { type: "workspaceWrite", networkAccess: access.network === true, writableRoots: [...new Set(writableRoots)] }
}
