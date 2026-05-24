export const VITEHUB_VITE_MODE_KEY = "VITEHUB_VITE_MODE"
export const VITEHUB_NITRO_MODE_KEY = "VITEHUB_NITRO_MODE"
export const VITEHUB_HOSTING_KEY = "VITEHUB_HOSTING"

export const VITEHUB_MODES = {
  e2e: "e2e",
  blob: "blob",
  chat: "chat",
  db: "db",
  env: "env",
  kv: "kv",
  queue: "queue",
  schedule: "schedule",
  sandbox: "sandbox",
  workspace: "workspace",
  workflow: "workflow",
} as const

export type ViteHubMode = typeof VITEHUB_MODES[keyof typeof VITEHUB_MODES]

function isViteCli(argv: string[]): boolean {
  return argv.some(arg => /(?:^|[/\\])vite(?:\.[cm]?js)?$/.test(arg) || arg === "vite")
}

function getViteCliMode(argv: string[] = process.argv): ViteHubMode | undefined {
  if (!isViteCli(argv)) {
    return undefined
  }

  const modes = new Set<string>(Object.values(VITEHUB_MODES))
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const mode = arg === "--mode" ? argv[index + 1] : arg.startsWith("--mode=") ? arg.slice("--mode=".length) : undefined
    if (mode && modes.has(mode)) {
      return mode as ViteHubMode
    }
  }
}

export function getViteMode(env: NodeJS.ProcessEnv = process.env): ViteHubMode | undefined {
  return (env[VITEHUB_VITE_MODE_KEY] as ViteHubMode | undefined) ?? getViteCliMode()
}

export function getNitroMode(env: NodeJS.ProcessEnv = process.env): ViteHubMode | undefined {
  return env[VITEHUB_NITRO_MODE_KEY] as ViteHubMode | undefined
}
