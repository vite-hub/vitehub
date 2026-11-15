import type { ViteHubCliContributor } from "@vite-hub/internal/cli"

import { adminClaimHash, adminClaimVariable, createAdminClaimCode } from "./admin-claim-code.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"

const usage = "vitehub auth events --url <auth-base-url> [--type <type>] [--user <id>] [--actor <actor>] [--from <ISO>] [--to <ISO>] [--cursor <cursor>] [--limit <1-200>] [--aggregate]"

/** Read the app-owned, session-protected endpoint. No local or remote database credentials are needed. */
export function createAuthCliContributor(options: { fetch?: typeof fetch } = {}): ViteHubCliContributor {
  return { namespaces: [{
    name: "auth", description: "Inspect auth events and create an admin claim code.", features: [{
      name: "claim",
      description: "Create a one-time code that gives the admin role to the user who enters it.",
      usage: "vitehub auth claim [--json]",
      async run(args, context) {
        if (args.includes("--help") || args.includes("-h")) {
          context.stdout.write(`vitehub auth claim [--json]\n\nPrints a new code and the ${adminClaimVariable} value to set on the host. The host stores only the SHA-256 of the code.\n`)
          return 0
        }
        const code = createAdminClaimCode()
        const value = await adminClaimHash(code)
        if (args.includes("--json")) {
          context.stdout.write(`${JSON.stringify({ code, variable: adminClaimVariable, value }, null, 2)}\n`)
          return 0
        }
        context.stdout.write([
          `Claim code: ${code}`,
          "This is the only time the code is shown. Keep it private.",
          "",
          "Set this variable on the host, for example as a Worker secret:",
          `${adminClaimVariable}=${value}`,
          "",
          "Then sign in to the app and send the code to POST <auth base>/vitehub/admin-claim as { \"code\": \"...\" }. The first signed-in user who sends it gets the admin role, and the code stops working.",
          "",
        ].join("\n"))
        return 0
      },
    }, {
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
            if (arg !== "--url" && !Object.hasOwn(filters, arg)) throw authErrorDiagnostics.AUTH_EVENTS_OPTION_INVALID({ option: arg, problem: "unknown" })
            const value = args[++index]
            if (!value || value.startsWith("--")) throw authErrorDiagnostics.AUTH_EVENTS_OPTION_INVALID({ option: arg, problem: "value" })
            if (arg === "--url") url = value
            else query.set(filters[arg]!, value)
          }
          if (!url) throw authErrorDiagnostics.AUTH_EVENTS_URL_MISSING()
          const endpoint = new URL(`${url.replace(/\/$/, "")}/vitehub/events`)
          if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) throw authErrorDiagnostics.AUTH_EVENTS_URL_INSECURE()
          endpoint.search = query.toString()
          const response = await (options.fetch ?? fetch)(endpoint, { redirect: "error", headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30_000) })
          if (!response.ok) throw authErrorDiagnostics.AUTH_EVENTS_REQUEST_FAILED({ status: response.status })
          context.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`)
          return 0
        }
        catch (error) {
          const fix = error instanceof Error && "fix" in error && typeof error.fix === "string" ? `\nFix: ${error.fix}` : ""
          context.stderr.write(`${error instanceof Error ? error.message : "Could not read auth events."}${fix}\n`)
          return 1
        }
      },
    }],
  }] }
}
