import { describe, expect, it } from "vitest"

import { describeDeploymentPlanOutput } from "../src/build/deployment-plan-output.ts"
import { resolveDeploymentPlan } from "../src/deployment.ts"
import {
  collectViteHubDefinitionInspectors,
  collectViteHubProviderOutputEntries,
  redactInspectionText,
  redactInspectionValue,
  summarizeDefinitions,
} from "../src/inspect.ts"

describe("inspection contributors", () => {
  it("collects object and factory contributors and skips plugins without inspection", async () => {
    const plugins = [
      null,
      { name: "plain" },
      { vitehub: { cli: { namespaces: [] } } },
      { vitehub: { inspect: { definitions: [{ kind: "queue", label: "Queues", list: () => [] }] } } },
      { vitehub: { inspect: async () => ({ definitions: [{ kind: "schedule", label: "Schedules", list: () => [] }] }) } },
      { vitehub: { inspect: () => undefined } },
    ]

    const inspectors = await collectViteHubDefinitionInspectors(plugins)
    expect(inspectors.map(inspector => inspector.kind)).toEqual(["queue", "schedule"])
  })

  it("keeps one inspector per kind and one Provider Output entry per path", async () => {
    const plugins = [
      { vitehub: { inspect: { definitions: [{ kind: "queue", label: "First", list: () => [] }], providerOutput: [{ description: "first", owner: "a", path: "/app/out.json" }] } } },
      { vitehub: { inspect: { definitions: [{ kind: "queue", label: "Second", list: () => [] }], providerOutput: [{ description: "second", owner: "b", path: "/app/out.json" }] } } },
    ]

    expect((await collectViteHubDefinitionInspectors(plugins)).map(inspector => inspector.label)).toEqual(["Second"])
    expect(await collectViteHubProviderOutputEntries(plugins)).toEqual([{ description: "second", owner: "b", path: "/app/out.json" }])
  })

  it("summarizes Definitions relative to the project root", () => {
    expect(summarizeDefinitions("/app", [
      { handler: "/app/server/agents/support.ts", name: "support" },
      { handler: "/app/server/agents/billing.ts", name: "billing", source: "server-agent" },
    ], "agent")).toEqual([
      { fields: [], file: "server/agents/support.ts", name: "support", source: "agent" },
      { fields: [], file: "server/agents/billing.ts", name: "billing", source: "server-agent" },
    ])
  })
})

describe("redactInspectionValue", () => {
  it("bounds and serializes structured-clone values", () => {
    const cyclic: Record<string, unknown> = { count: 1n, token: "secret" }
    cyclic.self = cyclic
    const result = redactInspectionValue(cyclic)
    expect(result).toEqual({ count: "1", token: "[redacted]", self: "[circular]" })
    expect(() => JSON.stringify(result)).not.toThrow()
    expect(redactInspectionValue(Array.from({ length: 1000 }, () => "value"))).toHaveLength(100)
  })

  it("redacts secret-like keys, Worker vars, and credential URLs", () => {
    expect(redactInspectionValue({
      d1_databases: [{ binding: "DB", database_id: "db-id" }],
      nested: { apiKey: "k", "Api key": "k", authorization: "Bearer x", password: "p", token: "t" },
      urls: ["https://user:pass@example.com/db", "redis://:password@example.com/0", "https://token@example.com/path", "https://user:@example.com/path", "https://example.com/public"],
      header: "Bearer abc",
      vars: { PUBLIC_FLAG: "on", STRIPE_KEY: "sk_live" },
    })).toEqual({
      d1_databases: [{ binding: "DB", database_id: "db-id" }],
      nested: { apiKey: "[redacted]", "Api key": "[redacted]", authorization: "[redacted]", password: "[redacted]", token: "[redacted]" },
      urls: ["[redacted]", "[redacted]", "[redacted]", "[redacted]", "https://example.com/public"],
      header: "[redacted]",
      vars: { PUBLIC_FLAG: "[redacted]", STRIPE_KEY: "[redacted]" },
    })
  })

  it.each([
    "https://token@example.test/path",
    "https://user:@example.test/path",
    "https://user%3Apassword@example.test/path",
    "https://user%40realm:%70ass%2Fword@example.test/path",
    "https://user%2Ftenant@example.test/path",
  ])("redacts username-only, empty-password, and encoded URL user info in %s", (url) => {
    expect(redactInspectionValue({ url })).toEqual({ url: "[redacted]" })
    expect(redactInspectionText(`Connection ${url} failed`)).toBe("Connection https://[redacted]@example.test/path failed")
  })

  it.each([
    "https://example.test/path@public",
    "https://example.test/path?contact=user@example.test",
    "https://example.test/path#contact=user@example.test",
  ])("preserves public URL path, query, and fragment at signs in %s", (url) => {
    expect(redactInspectionValue({ url })).toEqual({ url })
    expect(redactInspectionText(`Connection ${url} failed`)).toBe(`Connection ${url} failed`)
  })

  it("redacts URL user info through the final raw at sign", () => {
    const url = "postgres://user@example.com:db-password@host/db"
    expect(redactInspectionValue({ url })).toEqual({ url: "[redacted]" })
    expect(redactInspectionText(`Connection ${url} failed`)).toBe("Connection postgres://[redacted]@host/db failed")
    expect(redactInspectionText("https://public.test/path?contact=user@example.test")).toBe("https://public.test/path?contact=user@example.test")
  })

  it.each(["redis://:hunter2@localhost", "https://:hunter2@example.test/path", "postgres://:p@ssword@host/db"])("redacts password-only URL credentials in %s", (url) => {
    expect(redactInspectionValue({ url })).toEqual({ url: "[redacted]" })
    const redacted = redactInspectionText(`Connection ${url} failed`)
    expect(redacted).toBe(`Connection ${url.slice(0, url.indexOf("://") + 3)}[redacted]@${url.slice(url.lastIndexOf("@") + 1)} failed`)
  })

  it("redacts complete compound classified credentials", () => {
    expect(redactInspectionText('Authorization: Digest username="u", response="deadbeef"')).toBe('Authorization: [redacted]')
    expect(redactInspectionText('Cookie: theme=dark; sessionid=abc123')).toBe('Cookie: [redacted]')
  })

  it("keeps non-secret primitives unchanged", () => {
    expect(redactInspectionValue(3)).toBe(3)
    expect(redactInspectionValue(null)).toBe(null)
    expect(redactInspectionValue("queue")).toBe("queue")
  })
})

describe("redactInspectionText", () => {
  it.each([
    String.raw`Authorization: "Digest username=\"u\", response=\"deadbeef\""`,
    String.raw`Authorization: 'Digest username=\'u\', response=\'deadbeef\''`,
  ])("redacts escaped quoted Authorization values in %s", (input) => {
    const output = redactInspectionText(input)
    expect(output).toBe("Authorization: [redacted]")
    expect(output).not.toContain("username")
    expect(output).not.toContain("response")
    expect(output).not.toContain("deadbeef")
  })

  it.each(["cookie", "request_cookie", "cookie_header"])("redacts complete cookie assignments for %s", key => {
    expect(redactInspectionText(`${key}=theme=dark; sessionid=abc123`)).toBe(`${key}=[redacted]`)
    expect(redactInspectionText(`${key}: theme=dark; sessionid=abc123`)).toBe(`${key}: [redacted]`)
    expect(redactInspectionText(`${key}="theme=dark; sessionid=abc123"; retry`)).toBe(`${key}=[redacted]; retry`)
    expect(redactInspectionText(`${key}="theme=dark"; sessionid=abc123`)).toBe(`${key}=[redacted]`)
    expect(redactInspectionText(`{"${key}":"theme=dark; sessionid=abc123"}`)).toBe(`{"${key}":[redacted]}`)
    expect(redactInspectionText(`${key}=theme=dark; sessionid=abc123\nRequest failed`)).toBe(`${key}=[redacted]\nRequest failed`)
  })

  it.each(["Cookie", "request_cookie", "cookie_header"])("preserves diagnostic phrases after %s credentials", key => {
    expect(redactInspectionText(`${key}: session=abc; request failed`)).toBe(`${key}: [redacted]; request failed`)
    expect(redactInspectionText(`${key}: theme=dark; sessionid=abc123; retry the request`)).toBe(`${key}: [redacted]; retry the request`)
    expect(redactInspectionText(`${key}: session=abc; path=/private; request failed`)).toBe(`${key}: [redacted]; request failed`)
  })

  it.each(["proxy_authorization", "X-Authorization", "authorization_header", "ProxyAuthorization"])("redacts compound normalized authorization key %s", key => {
    expect(redactInspectionText(`${key}=Basic dXNlcjpwYXNz`)).toBe(`${key}=[redacted]`)
    expect(redactInspectionText(`${key}: Digest username="u", response="deadbeef"`)).toBe(`${key}: [redacted]`)
    expect(redactInspectionText(`${key}=Basic dXNlcjpwYXNz rejected; token=other`)).toBe(`${key}=[redacted] rejected; token=[redacted]`)
  })

  it("redacts escaped quotes inside secret assignments", () => {
    expect(redactInspectionText(String.raw`password="hunter\" 2" failed`)).toBe("password=[redacted] failed")
  })

  it.each([
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: [redacted]'],
    ['Authorization: Bearer abc rejected', 'Authorization: [redacted] rejected'],
    ['password="hunter 2" failed', 'password=[redacted] failed'],
    ["token='secret with spaces'; retry", 'token=[redacted]; retry'],
  ])("redacts the complete credential in %s", (input, expected) => {
    expect(redactInspectionText(input)).toBe(expected)
  })

  it.each(["cookie", "credential", "private_key", "signature", "dsn", "connection_string", "aws_secret_access_key", "access_token", "api key", "private key", "connection string"])("redacts the secret assignment family %s", (key) => {
    expect(redactInspectionText(`request ${key}=session-secret; retry`)).toBe(`request ${key}=[redacted]; retry`)
    expect(redactInspectionText(`request ${key}='secret with spaces'; retry`)).toBe(`request ${key}=[redacted]; retry`)
    expect(redactInspectionText(`{"${key}":"session-secret"}`)).toBe(`{"${key}":[redacted]}`)
  })

  it("redacts credentials inside free text", () => {
    expect(redactInspectionText("GET https://user:hunter2@example.test/db failed, Authorization: Bearer abc.def; api_key=sk_live token: t1 done"))
      .toBe("GET https://[redacted]@example.test/db failed, Authorization: [redacted]; api_key=[redacted] token: [redacted] done")
    expect(redactInspectionText("Target report failed after 3 attempts.")).toBe("Target report failed after 3 attempts.")
  })
})

describe("describeDeploymentPlanOutput", () => {
  it("uses the configured Nitro output directory", () => {
    expect(describeDeploymentPlanOutput(resolveDeploymentPlan("cloudflare"), "/app", "custom").map(entry => entry.path)).toEqual([
      "/app/custom/deployment.json", "/app/custom/server/wrangler.json",
    ])
    expect(describeDeploymentPlanOutput(resolveDeploymentPlan("netlify"), "/app", "/app/custom/functions-internal").map(entry => entry.path)).toEqual([
      "/app/custom/deployment.json", "/app/custom/v1",
    ])
  })
  it.each([
    ["cloudflare", ["/app/.output/deployment.json", "/app/.output/server/wrangler.json"]],
    ["vercel", ["/app/.vercel/output/deployment.json", "/app/.vercel/output/config.json"]],
    ["netlify", ["/app/.netlify/deployment.json", "/app/.netlify/v1"]],
    ["node", ["/app/.output/deployment.json"]],
  ] as const)("lists the %s preset output", (preset, paths) => {
    const entries = describeDeploymentPlanOutput(resolveDeploymentPlan(preset), "/app")
    expect(entries.map(entry => entry.path)).toEqual(paths)
    expect(entries.every(entry => entry.owner === "vite-hub")).toBe(true)
  })
})
