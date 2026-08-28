let viteLoadEnv: ((mode: string, root: string, prefix: string) => Record<string, string>) | undefined | null
const viteModuleId = "vite"

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
      // Keep the optional build-tool lookup opaque to runtime bundlers. A
      // literal dynamic import makes Rollup pull all of Vite into Workers that
      // merely use a GitHub Workspace source.
      const candidate = (await import(/* @vite-ignore */ viteModuleId)).loadEnv
      if (typeof candidate !== "function") {
        viteLoadEnv = null
        return
      }
      viteLoadEnv = candidate
    }
    catch {
      viteLoadEnv = null
      return
    }
  }
  const loadEnv = viteLoadEnv
  return loadEnv ? loadEnv("", rootDir, "") : undefined
}
