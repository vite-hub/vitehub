import type { ViteHubCliContributor } from "@vite-hub/internal/cli"

const usage = "vitehub auth events --url <auth-base-url> [--type <type>] [--user <id>] [--actor <actor>] [--from <ISO>] [--to <ISO>] [--cursor <cursor>] [--limit <1-200>] [--aggregate]"

/** Read the app-owned, session-protected endpoint. No local or remote database credentials are needed. */
export function createAuthCliContributor(options: { fetch?: typeof fetch } = {}): ViteHubCliContributor {
  return { namespaces: [{
    name: "auth", description: "Inspect auth events.", features: [{
      name: "events",
      description: "List auth events or daily aggregates as JSON.",
      usage,
      async run(args, context) {
        try {
          if (args.includes("--help") || args.includes("-h")) {
            context.stdout.write(`${usage}\n\nSet VITEHUB_AUTH_COOKIE to an authorized session cookie. VITEHUB_AUTH_URL supplies the default URL. Output is JSON.\n`)
            return 0
          }
          const query = new URLSearchParams()
          let url = context.env.VITEHUB_AUTH_URL
          const cookie = context.env.VITEHUB_AUTH_COOKIE
          const filters: Record<string, string> = { "--type": "type", "--user": "userId", "--actor": "actor", "--from": "from", "--to": "to", "--cursor": "cursor", "--limit": "limit" }
          for (let index = 0; index < args.length; index++) {
            const arg = args[index]!
            if (arg === "--aggregate") { query.set("aggregate", "true"); continue }
            if (arg === "--json") continue
            if (arg !== "--url" && !Object.hasOwn(filters, arg)) throw new Error(`Unknown auth events option: ${arg}`)
            const value = args[++index]
            if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`)
            if (arg === "--url") url = value
            else query.set(filters[arg]!, value)
          }
          if (!url) throw new Error("Set --url to the Auth base URL, such as http://localhost:5173/api/auth. Set VITEHUB_AUTH_COOKIE to a permitted session cookie.")
          const endpoint = new URL(`${url.replace(/\/$/, "")}/vitehub/events`)
          if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) throw new Error("Auth events requires HTTPS or a loopback HTTP URL.")
          endpoint.search = query.toString()
          const response = await (options.fetch ?? fetch)(endpoint, { redirect: "error", headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30_000) })
          if (!response.ok) throw new Error(`Auth events returned HTTP ${response.status}. Configure events.authorize and use a permitted session.`)
          context.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`)
          return 0
        }
        catch (error) {
          context.stderr.write(`${error instanceof Error ? error.message : "Could not read auth events."}\n`)
          return 1
        }
      },
    }],
  }] }
}
