import type { Plugin } from "vite"

/**
 * Nitro's `miniflare` dev runner runs the server in workerd, which does not inherit the shell. It reads only the Wrangler
 * `vars` and the `.dev.vars` or `.env` files. So a ViteHub variable from the shell, such as `VITEHUB_AGENT_STATE_URL`,
 * would be missing there, while the Node runners see it. This passes every `VITEHUB_*` shell variable as a Wrangler var
 * in dev. Wrangler lets a `.env` or `.dev.vars` value win over it. Other runners and builds do not read these vars.
 */
export function miniflareDevEnvPlugin(): Plugin {
  return {
    name: "vite-hub/miniflare-dev-env",
    apply: "serve",
    nitro: {
      setup(nitro) {
        if (!nitro.options.dev) return
        const shell = Object.entries(process.env).filter((entry): entry is [string, string] => entry[0].startsWith("VITEHUB_") && typeof entry[1] === "string")
        if (!shell.length) return
        const cloudflare = nitro.options.cloudflare ??= {}
        const wrangler = cloudflare.wrangler ??= {}
        const environment = cloudflare.wranglerEnv ?? process.env.CLOUDFLARE_ENV
        const target = (environment ? wrangler.env?.[environment] : undefined) ?? wrangler
        target.vars = { ...target.vars, ...Object.fromEntries(shell) }
      },
    },
  }
}
