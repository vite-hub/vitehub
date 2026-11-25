export const modes = ["node-build", "node-dev", "cloudflare-build", "cloudflare-dev"] as const
export type Mode = (typeof modes)[number]
export type Target = "node" | "cloudflare"

export interface ProbeContext {
  mode: Mode
  target: Target
  fetch: (path: string, init?: RequestInit) => Promise<Response>
}

export interface PrepareContext {
  mode: Mode
  appDir: string
  vitehub: (args: string[]) => Promise<void>
  wrangler: (args: string[]) => Promise<void>
}

export interface PrimitiveRow {
  id: string
  packages: readonly `@vite-hub/${string}`[]
  dependencies?: Readonly<Record<string, string>>
  vitehub?: (target: Target) => Record<string, unknown>
  files: Readonly<Record<string, string>>
  prepare?: (context: PrepareContext) => Promise<void>
  probe: (context: ProbeContext) => Promise<void>
  exempt?: Partial<Record<Mode, string>>
}

export interface PendingPrimitive {
  id: string
  pending: string
}

export type PrimitiveEntry = PrimitiveRow | PendingPrimitive

export function pending(owner: string, ids: readonly string[]): PendingPrimitive[] {
  return ids.map(id => ({ id, pending: `pending, owned by ${owner}` }))
}

export function isRow(entry: PrimitiveEntry): entry is PrimitiveRow {
  return "probe" in entry
}

export async function expectJson(response: Response, expected: unknown) {
  const body = await response.text()
  if (!response.ok) throw new Error(`${response.url} answered ${response.status}: ${body.slice(0, 2000)}`)
  const value: unknown = JSON.parse(body)
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${response.url} answered ${body}, expected ${JSON.stringify(expected)}`)
  }
}
