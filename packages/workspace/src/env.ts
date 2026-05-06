let viteLoadEnv: ((mode: string, root: string, prefix: string) => Record<string, string>) | undefined | null

export async function resolveWorkspaceEnv(rootDir: string, name: string): Promise<string | undefined> {
  return (await loadWorkspaceEnv(rootDir))?.[name]
}

export async function loadWorkspaceEnv(rootDir: string): Promise<Record<string, string> | undefined> {
  return await loadViteEnv(rootDir)
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
