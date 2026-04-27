export const VITEHUB_VITE_MODE_KEY = "VITEHUB_VITE_MODE"
export const VITEHUB_NITRO_MODE_KEY = "VITEHUB_NITRO_MODE"
export const VITEHUB_HOSTING_KEY = "VITEHUB_HOSTING"

export const VITEHUB_MODES = {
  blob: "blob",
  kv: "kv",
  queue: "queue",
  sandbox: "sandbox",
  workflow: "workflow",
} as const

export type ViteHubMode = typeof VITEHUB_MODES[keyof typeof VITEHUB_MODES]

export function getViteMode(env: NodeJS.ProcessEnv = process.env): ViteHubMode | undefined {
  return env[VITEHUB_VITE_MODE_KEY] as ViteHubMode | undefined
}

export function getNitroMode(env: NodeJS.ProcessEnv = process.env): ViteHubMode | undefined {
  return env[VITEHUB_NITRO_MODE_KEY] as ViteHubMode | undefined
}
