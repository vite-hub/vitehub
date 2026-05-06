const envByRoot = new Map<string, Record<string, string>>()
let viteLoadEnv: ((mode: string, root: string, prefix: string) => Record<string, string>) | undefined | null

export async function resolveWorkspaceEnv(rootDir: string, name: string): Promise<string | undefined> {
  return (await loadWorkspaceEnv(rootDir))?.[name]
}

export async function loadWorkspaceEnv(rootDir: string): Promise<Record<string, string> | undefined> {
  if (envByRoot.has(rootDir)) return envByRoot.get(rootDir)
  const env = await loadViteEnv(rootDir)
  if (env) envByRoot.set(rootDir, env)
  return env
}

async function loadViteEnv(rootDir: string): Promise<Record<string, string> | undefined> {
  if (viteLoadEnv === null) return
  if (!viteLoadEnv) {
    try {
      viteLoadEnv = (await import("vite")).loadEnv
    }
    catch {
      viteLoadEnv = null
      return
    }
  }
  return viteLoadEnv("", rootDir, "")
}
