import { getHostingProvider } from "@vite-hub/internal/hosting"
import { join, relative } from "pathe"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

import type { ResolvedDBViteConfig } from "../types.ts"

/** The Nitro surface that `migrateOnDeploy` reads and changes. */
export interface MigrateOnDeployNitro {
  hooks: { hook: (name: "build:before", callback: () => void) => void }
  options: { commands?: Record<string, unknown>, dev?: boolean, output: { dir?: string, serverDir: string }, preset?: string }
}

export interface MigrateOnDeployTarget {
  /** The D1 bindings whose migrations the build copies into the server output. */
  bindings: readonly string[]
  config: ResolvedDBViteConfig | undefined
}

/** Fails the build when a database has no native D1 binding. Only Wrangler's apply runs in the deploy command. */
function assertMigrateOnDeploySupported(config: ResolvedDBViteConfig | undefined): void {
  if (!config) return
  for (const name of config.databaseNames) {
    const database = config.databases[name]!
    const problem = database.dialect === "postgresql"
      ? "It is a Postgres database."
      : !database.cloudflare
          ? "It has no D1 binding."
          : database.cloudflare.http ? "It uses Cloudflare D1 over HTTP." : undefined
    if (problem) throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_DEPLOY_UNSUPPORTED({ database: name, problem })
  }
}

/**
 * Puts `wrangler d1 migrations apply <binding> --remote` for each binding before the deploy command. `&&` joins them,
 * so a failed migration stops the commands after it, and the Worker does not deploy.
 */
function withD1MigrationsBeforeDeploy(deploy: string, bindings: readonly string[], config: string): string {
  return [...bindings.map(binding => `npx wrangler d1 migrations apply ${binding} --remote --config ${config}`), deploy].join(" && ")
}

/** The Wrangler config path relative to the output directory, as Nitro's `deploy --prebuilt` rewrite expects it. */
function wranglerConfigArgument(outputDir: string, serverDir: string): string {
  const path = relative(outputDir, join(serverDir, "wrangler.json"))
  return /^[\w./-]+$/.test(path) ? `./${path}` : `./'${path.replaceAll("'", `'\\''`)}'`
}

/**
 * Adds the D1 migrations to the Cloudflare deploy command before Nitro writes it to `nitro.json`. `build:before` runs
 * after every Nitro module set the command, so the order of the modules does not matter. `target` returns `undefined`
 * when `migrateOnDeploy` is off.
 */
export function installMigrateOnDeploy(nitro: MigrateOnDeployNitro, target: () => MigrateOnDeployTarget | undefined): void {
  let written: string | undefined
  nitro.hooks.hook("build:before", () => {
    const { commands, dev, output, preset } = nitro.options
    if (dev || preset === "nitro-prerender") return
    const resolved = target()
    if (!resolved) return
    if (getHostingProvider(preset) !== "cloudflare") {
      throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_DEPLOY_UNSUPPORTED({ problem: `The build targets ${preset ?? "an unknown host"}.` })
    }
    const { bindings, config } = resolved
    assertMigrateOnDeploySupported(config)
    const deploy = commands?.deploy
    if (deploy === written) return
    if (!commands || typeof deploy !== "string" || !output.dir) {
      throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_DEPLOY_UNSUPPORTED({ problem: "Nitro has no deploy command as a shell command." })
    }
    if (!config?.databaseNames.length) return
    // A Nuxt build that learns its Cloudflare preset after `nitro:config` has no D1 output, so it has nothing to apply.
    if (!bindings.length) {
      throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_DEPLOY_UNSUPPORTED({ problem: "The build wrote no D1 migrations into the server output. Set the Cloudflare preset in the Nitro config." })
    }
    written = withD1MigrationsBeforeDeploy(deploy, [...new Set(bindings)], wranglerConfigArgument(output.dir, output.serverDir))
    commands.deploy = written
  })
}
