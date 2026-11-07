import { bundleDiagnostics, cloudflareWorkerSizeLimit } from "./diagnostics.ts"

import type { BundleChainStep, BundleEnvironmentReport, BundleExplanation, BundleFinding, BundleFindingCode, BundleSide, BundleStartupRule } from "./types.ts"

type Explain = (target: string) => BundleExplanation[]

function finding(code: BundleFindingCode, diagnostic: { why: string, fix?: string, docs?: string }, rest: Pick<BundleFinding, "bytes" | "chain" | "severity" | "side">): BundleFinding {
  return {
    code,
    severity: rest.severity,
    side: rest.side,
    why: diagnostic.why,
    fix: diagnostic.fix ?? "",
    docs: diagnostic.docs ?? "",
    bytes: rest.bytes,
    chain: rest.chain,
  }
}

function serverChain(explain: Explain, target: string): BundleChainStep[] {
  return explain(target).find(explanation => explanation.side === "server")?.chain ?? []
}

/** Each rule once, also when several server environments carry it. */
function uniqueRules(reports: readonly BundleEnvironmentReport[]): BundleStartupRule[] {
  const rules = new Map<string, BundleStartupRule>()
  for (const report of reports) {
    for (const rule of report.side === "server" ? report.rules ?? [] : []) rules.set(JSON.stringify(rule), rule)
  }
  return [...rules.values()]
}

/** A package that a feature declared as not needed at startup, and that loads at startup. */
function startupUnused(server: BundleSide, rules: readonly BundleStartupRule[], explain: Explain): BundleFinding[] {
  return rules.flatMap((rule) => {
    const packages = server.groups
      .filter(group => rule.packages.includes(group.name) && group.startupBytes > 0)
      .map(group => ({ name: group.name, bytes: group.startupBytes }))
      .sort((left, right) => right.bytes - left.bytes)
    if (!packages.length) return []
    // The first package of the rule that loads, such as `@libsql/client`, is the one that app code imports.
    const target = rule.packages.find(name => packages.some(item => item.name === name))!
    return [finding("BUNDLE_STARTUP_UNUSED", bundleDiagnostics.BUNDLE_STARTUP_UNUSED({ packages, reason: rule.why, fix: rule.fix, target }), {
      severity: "warning",
      side: "server",
      bytes: packages.reduce((sum, item) => sum + item.bytes, 0),
      chain: serverChain(explain, target),
    })]
  })
}

/** Server output over the size that the host accepts. */
function hostSizeLimit(server: BundleSide, host: string | undefined, explain: Explain): BundleFinding[] {
  if (!host?.startsWith("cloudflare") || server.bytes <= cloudflareWorkerSizeLimit) return []
  const largest = server.groups[0]
  return [finding("BUNDLE_HOST_SIZE_LIMIT", bundleDiagnostics.BUNDLE_HOST_SIZE_LIMIT({ bytes: server.bytes, limit: cloudflareWorkerSizeLimit }), {
    severity: "error",
    side: "server",
    bytes: server.bytes,
    chain: largest ? serverChain(explain, largest.name) : [],
  })]
}

/** The checks that the report of one build proves. Only certain problems, no guesses. */
export function checkBundle(reports: readonly BundleEnvironmentReport[], server: BundleSide | undefined, host: string | undefined, explain: Explain): BundleFinding[] {
  if (!server) return []
  return [
    ...hostSizeLimit(server, host, explain),
    ...startupUnused(server, uniqueRules(reports), explain),
  ]
}
