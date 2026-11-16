import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it } from "vitest"
import { githubAppCredentials } from "../src/github-app.ts"

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 12, minute)).toISOString()

describe("GitHub App webhook deliveries", () => {
  it("lists failed deliveries that no attempt delivered, across pages, and redelivers by id", async () => {
    const requests: string[] = []
    const pages: Record<string, unknown[]> = {
      first: [
        { id: 3854367974137798700, guid: "b", event: "check_suite", action: "completed", status_code: 500, delivered_at: at(50) },
        { id: 4, guid: "a", event: "check_suite", action: "completed", status_code: 202, delivered_at: at(40) },
      ],
      next: [
        { id: 3, guid: "a", event: "check_suite", action: "completed", status_code: 500, delivered_at: at(30) },
        { id: 2, guid: "c", event: "pull_request", action: "synchronize", status_code: 502, delivered_at: at(20) },
        { id: 1, guid: "d", event: "push", status_code: 500, delivered_at: at(1) },
      ],
    }
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`)
      if (url.pathname.endsWith("/attempts")) return new Response("{}", { status: 202, headers: { "content-type": "application/json" } })
      const cursor = url.searchParams.get("cursor")
      // Raw text keeps IDs past 2^53 exact, as GitHub sends them.
      return new Response(JSON.stringify(pages[cursor ?? "first"]).replace("3854367974137798700", "3854367974137798657"), { status: 200, headers: {
        "content-type": "application/json",
        ...cursor ? {} : { link: `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next>; rel="next"` },
      } })
    }
    const app = githubAppCredentials({ appId: 1, privateKey, fetch: fetcher, userAgent: "deliveries-test" })
    const failed = await app.failedDeliveries(Date.parse(at(10)))
    expect(failed.map(item => item.id)).toEqual(["2", "3854367974137798657"])
    expect(failed[0]).toMatchObject({ guid: "c", event: "pull_request", action: "synchronize", attempts: 1 })
    await app.redeliver("3854367974137798657")
    expect(requests.at(-1)).toBe("POST /app/hook/deliveries/3854367974137798657/attempts")
  })
})
