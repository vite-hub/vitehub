import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export const repoRoot = resolve(import.meta.dirname, "..", "..")

const PROVIDERS = ["cloudflare", "vercel"] as const
type OutputProvider = typeof PROVIDERS[number]

// VITEHUB_OUTPUT_PROVIDER narrows direct Vitest runs to one provider's suite.
// Unset means both providers' outputs are required - missing output fails, never skips.
export function providerEnabled(provider: OutputProvider): boolean {
  const selected = process.env.VITEHUB_OUTPUT_PROVIDER
  if (!selected) return true
  if (!PROVIDERS.includes(selected as OutputProvider)) {
    throw new Error(`[vitehub] Invalid VITEHUB_OUTPUT_PROVIDER "${selected}". Expected ${PROVIDERS.join(" | ")}.`)
  }
  return selected === provider
}

export function readOutputFile(relativePath: string, buildHint: string): string {
  const path = resolve(repoRoot, relativePath)
  if (!existsSync(path)) {
    throw new Error(`[vitehub] Missing Provider Output at ${relativePath}. Build it first: ${buildHint}`)
  }
  return readFileSync(path, "utf8")
}

export function outputFileExists(relativePath: string): boolean {
  return existsSync(resolve(repoRoot, relativePath))
}

export const buildHints = {
  cloudflare: "vp run playground:vite:build:local --provider cloudflare",
  vercel: "vp run playground:vite:build:local --provider vercel",
} satisfies Record<OutputProvider, string>
