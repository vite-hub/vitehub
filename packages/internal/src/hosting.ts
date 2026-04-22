import { readEnv, trimmed } from "./env.ts"

export function normalizeHosting(hosting: string | undefined): string {
  return hosting?.trim().toLowerCase().replaceAll("_", "-") || ""
}

export interface HostingInput {
  env?: Record<string, string | undefined>
  hosting?: string
}

export function resolveHostingFromInput(input: HostingInput = {}): string | undefined {
  const env = input.env || process.env
  return trimmed(input.hosting) ?? readEnv(env, "NITRO_PRESET", "VITEHUB_HOSTING")
}
