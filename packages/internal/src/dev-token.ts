/** Private dev credentials are scoped to one project, endpoint, and server instance. */
export interface ViteHubDevTokenScope {
  namespace: string
  serverId: string
}

export const viteHubDevTokenHeader = "x-vitehub-dev-token"

export async function viteHubDevTokenFile(rootDir: string, scope: ViteHubDevTokenScope): Promise<string> {
  const [{ createHash }, { tmpdir }, { join, resolve }] = await Promise.all([
    import("node:crypto"), import("node:os"), import("node:path"),
  ])
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  return join(tmpdir(), "vitehub-dev-tokens", hash(scope.namespace), hash(resolve(rootDir)), hash(scope.serverId), "token")
}

/** Tokens this process created, so a second registration with the same server id shares the file instead of failing. */
interface ViteHubDevTokenEntry { count: number, token: Promise<string> }
const devTokenEntriesKey: unique symbol = Symbol.for("vitehub.devTokens")
const devTokenExitKey: unique symbol = Symbol.for("vitehub.devTokens.exit")
// SAFETY: separately bundled copies of this module must share one registry, or each would delete the other's file.
const processScope = globalThis as typeof globalThis & { [devTokenEntriesKey]?: Map<string, ViteHubDevTokenEntry>, [devTokenExitKey]?: true }
const devTokenEntries = (): Map<string, ViteHubDevTokenEntry> => processScope[devTokenEntriesKey] ??= new Map()

// Nuxt 4's second Vite server has no HTTP server to close, so its registration may outlive the first one's.
function removeLeftoverTokensAtExit(): void {
  const fs = globalThis.process?.getBuiltinModule?.("node:fs")
  const path = globalThis.process?.getBuiltinModule?.("node:path")
  if (!fs || !path) return
  for (const file of devTokenEntries().keys()) {
    try {
      fs.rmSync(file, { force: true })
      fs.rmdirSync(path.dirname(file))
    }
    catch {}
  }
}

/**
 * Creates the private token of one dev server. The same project, namespace, and server id in one process share a
 * token, because Nuxt 4 runs a Vite plugin in two Vite servers. The file stays until every registration is removed.
 * A token file that another process created is never reused: it throws `EEXIST`.
 */
export async function createViteHubDevToken(rootDir: string, namespace: string, serverId: string = globalThis.crypto.randomUUID()): Promise<{ serverId: string, token: string }> {
  const file = await viteHubDevTokenFile(rootDir, { namespace, serverId })
  const entries = devTokenEntries()
  // No await between this check and the set, so concurrent callers see one entry.
  const existing = entries.get(file)
  if (existing) {
    existing.count++
    try {
      return { serverId, token: await existing.token }
    }
    catch (error) {
      existing.count--
      throw error
    }
  }
  const entry: ViteHubDevTokenEntry = { count: 1, token: writeViteHubDevToken(file) }
  if (!processScope[devTokenExitKey]) {
    processScope[devTokenExitKey] = true
    globalThis.process?.once?.("exit", removeLeftoverTokensAtExit)
  }
  entries.set(file, entry)
  try {
    return { serverId, token: await entry.token }
  }
  catch (error) {
    if (entries.get(file) === entry) entries.delete(file)
    throw error
  }
}

async function writeViteHubDevToken(file: string): Promise<string> {
  const token = [...globalThis.crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("")
  const [{ mkdir, writeFile }, { dirname }] = await Promise.all([import("node:fs/promises"), import("node:path")])
  await mkdir(dirname(file), { mode: 0o700, recursive: true })
  await writeFile(file, `${token}\n`, { flag: "wx", mode: 0o600 })
  return token
}

export async function readViteHubDevToken(rootDir: string, scope: ViteHubDevTokenScope): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises")
    return (await readFile(await viteHubDevTokenFile(rootDir, scope), "utf8")).trim() || undefined
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

export async function removeViteHubDevToken(rootDir: string, scope: ViteHubDevTokenScope): Promise<void> {
  const [{ rm, rmdir }, { dirname }] = await Promise.all([import("node:fs/promises"), import("node:path")])
  const file = await viteHubDevTokenFile(rootDir, scope)
  const entries = devTokenEntries()
  const entry = entries.get(file)
  if (entry && --entry.count > 0) return
  entries.delete(file)
  await rm(file, { force: true })
  await rmdir(dirname(file)).catch(() => {})
}
