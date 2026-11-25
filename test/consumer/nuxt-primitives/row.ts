import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const modes = ["node-build", "node-dev", "cloudflare-build", "cloudflare-dev"] as const
export type Mode = (typeof modes)[number]
export type Target = "node" | "cloudflare"

export interface ProbeContext {
  appDir: string
  mode: Mode
  origin: string
  target: Target
  fetch: (path: string, init?: RequestInit) => Promise<Response>
}

export interface PrepareContext {
  mode: Mode
  appDir: string
  origin: string
  vitehub: (args: string[]) => Promise<void>
  wrangler: (args: string[]) => Promise<void>
}

export class ConfigSource {
  constructor(readonly source: string, readonly imports: readonly string[]) {}
}

export function envDeclaration(source: string) {
  return new ConfigSource(source, [`import { env } from "vite-hub/env"`])
}

export interface PrimitiveRow {
  id: string
  packages: readonly `@vite-hub/${string}`[]
  dependencies?: Readonly<Record<string, string>>
  vitehub?: (target: Target, origin: string) => Record<string, unknown>
  files: Readonly<Record<string, string>>
  prepare?: (context: PrepareContext) => Promise<void>
  probe: (context: ProbeContext) => Promise<void>
  exempt?: Partial<Record<Mode, string>>
}

export async function setServerEnv({ appDir, mode }: Pick<PrepareContext, "appDir" | "mode">, values: Record<string, string>) {
  Object.assign(process.env, values)
  if (mode !== "cloudflare-build") return
  const file = join(appDir, ".output/server/.dev.vars")
  const current = await readFile(file, "utf8").catch(() => "")
  await writeFile(file, `${current}${Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}\n`).join("")}`)
}

export async function expectJson(response: Response, expected: unknown) {
  const body = await response.text()
  if (!response.ok) throw new Error(`${response.url} answered ${response.status}: ${body.slice(0, 2000)}`)
  const value: unknown = JSON.parse(body)
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${response.url} answered ${body}, expected ${JSON.stringify(expected)}`)
  }
}
