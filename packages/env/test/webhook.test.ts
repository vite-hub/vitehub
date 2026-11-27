import { createHmac } from "node:crypto"

import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runWithCloudflareEnv } from "../src/server.ts"
import { signWebhook, verifyWebhook } from "../src/webhook.ts"

const stripeSecret = "whsec_formula100test"
const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1" } } })

function stripeHeader(payload: string, secret = stripeSecret, time = Math.floor(Date.now() / 1000)): string {
  return `t=${time},v1=${createHmac("sha256", secret).update(`${time}.${payload}`).digest("hex")}`
}

function post(headers: Record<string, string>, payload = body): Request {
  return new Request("https://formula-100.test/api/stripe/webhook", { body: payload, headers, method: "POST" })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("verifyWebhook({ provider: 'stripe' })", () => {
  it("returns the parsed body for a valid signature", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", stripeSecret)
    const [error, event] = await verifyWebhook(post({ "stripe-signature": stripeHeader(body) }), { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET", schema: v.object({ type: v.string() }) })
    expect(error).toBeUndefined()
    expect(event?.type).toBe("checkout.session.completed")
  })

  it("returns ENV_WEBHOOK_SCHEMA_MISMATCH for a signed body that does not match the schema", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", stripeSecret)
    const payload = JSON.stringify({ id: "evt_2", type: 42 })
    const schema = v.object({ id: v.string(), type: v.string() })
    const [error, event] = await verifyWebhook(post({ "stripe-signature": stripeHeader(payload) }, payload), { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET", schema })
    expect(event).toBeUndefined()
    expect(error).toMatchObject({ code: "ENV_WEBHOOK_SCHEMA_MISMATCH", docs: "https://vitehub.dev/docs/env/diagnostics/env_webhook_schema_mismatch" })
    expect(error?.cause).toEqual([expect.objectContaining({ path: [expect.objectContaining({ key: "type" })] })])
  })

  it("returns the schema output, so a transform applies", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", stripeSecret)
    const schema = v.pipe(v.object({ type: v.string() }), v.transform(stripeEvent => stripeEvent.type.split(".")))
    const [error, parts] = await verifyWebhook(post({ "stripe-signature": stripeHeader(body) }), { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET", schema })
    expect(error).toBeUndefined()
    expect(parts).toEqual(["checkout", "session", "completed"])
  })

  it("refuses a changed body, a wrong secret, and a missing header", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", stripeSecret)
    const options = { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET" } as const
    for (const request of [
      post({ "stripe-signature": stripeHeader(body) }, `${body} `),
      post({ "stripe-signature": stripeHeader(body, "whsec_other") }),
      post({}),
    ]) {
      const [error, event] = await verifyWebhook(request, options)
      expect(event).toBeUndefined()
      expect(error).toMatchObject({
        code: "ENV_WEBHOOK_SIGNATURE_INVALID",
        why: "The `stripe-signature` header is missing, or it does not match the body signed with a secret in `STRIPE_WEBHOOK_SECRET`.",
      })
    }
  })

  it("refuses a signature older than the tolerance", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", stripeSecret)
    const old = Math.floor(Date.now() / 1000) - 301
    const [error] = await verifyWebhook(post({ "stripe-signature": stripeHeader(body, stripeSecret, old) }), { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET" })
    expect(error?.code).toBe("ENV_WEBHOOK_SIGNATURE_INVALID")
    const [late] = await verifyWebhook(post({ "stripe-signature": stripeHeader(body, stripeSecret, old) }), { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET", toleranceSeconds: 600 })
    expect(late).toBeUndefined()
  })

  it("accepts each secret of a comma-separated list, for rotation", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", `whsec_old, ${stripeSecret}`)
    for (const secret of ["whsec_old", stripeSecret]) {
      const [error] = await verifyWebhook(post({ "stripe-signature": stripeHeader(body, secret) }), { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET" })
      expect(error, secret).toBeUndefined()
    }
  })

  it("refuses every delivery when the variable has no secret", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", " , ")
    const request = post({ "stripe-signature": stripeHeader(body) })
    const [error] = await verifyWebhook(request, { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET" })
    expect(error).toMatchObject({ code: "ENV_WEBHOOK_SECRET_UNSET", docs: "https://vitehub.dev/docs/env/diagnostics/env_webhook_secret_unset" })
    expect(request.bodyUsed).toBe(false)
  })
})

describe("verifyWebhook({ provider: 'github' })", () => {
  it("checks X-Hub-Signature-256", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "gh-secret")
    const payload = JSON.stringify({ action: "opened", number: 7 })
    const signature = `sha256=${createHmac("sha256", "gh-secret").update(payload).digest("hex")}`
    const [error, delivery] = await verifyWebhook(post({ "x-hub-signature-256": signature }, payload), { provider: "github", secret: "GITHUB_WEBHOOK_SECRET" })
    expect(error).toBeUndefined()
    expect(delivery).toEqual({ action: "opened", number: 7 })
    const [wrong] = await verifyWebhook(post({ "x-hub-signature-256": signature.replace("sha256=", "") }, payload), { provider: "github", secret: "GITHUB_WEBHOOK_SECRET" })
    expect(wrong?.code).toBe("ENV_WEBHOOK_SIGNATURE_INVALID")
  })

  it("reads the payload field of a form delivery, as GitHub sends it with the form content type", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "gh-secret")
    const json = JSON.stringify({ action: "opened", pull_request: { title: "Add rate limits & retries" } })
    const form = new URLSearchParams({ payload: json }).toString()
    const signature = `sha256=${createHmac("sha256", "gh-secret").update(form).digest("hex")}`
    const options = { provider: "github", secret: "GITHUB_WEBHOOK_SECRET" } as const
    const formHeaders = { "content-type": "application/x-www-form-urlencoded", "x-hub-signature-256": signature }
    const [error, delivery] = await verifyWebhook(post(formHeaders, form), { ...options, schema: v.object({ pull_request: v.object({ title: v.string() }) }) })
    expect(error).toBeUndefined()
    expect(delivery?.pull_request.title).toBe("Add rate limits & retries")

    const [tampered] = await verifyWebhook(post(formHeaders, form.replace("opened", "closed")), options)
    expect(tampered?.code).toBe("ENV_WEBHOOK_SIGNATURE_INVALID")

    const empty = "zen=hello"
    const emptySignature = `sha256=${createHmac("sha256", "gh-secret").update(empty).digest("hex")}`
    const [missing] = await verifyWebhook(post({ "content-type": "application/x-www-form-urlencoded", "x-hub-signature-256": emptySignature }, empty), options)
    expect(missing?.code).toBe("ENV_WEBHOOK_BODY_INVALID")
  })
})

describe("verifyWebhook({ provider: 'hmac' })", () => {
  it("checks a hex HMAC with a base64 key, as Airtable sends it", async () => {
    const key = Buffer.from("airtable-mac-secret").toString("base64")
    vi.stubEnv("AIRTABLE_WEBHOOK_SECRET", key)
    const payload = JSON.stringify({ base: { id: "app1" }, webhook: { id: "ach1" } })
    const mac = `hmac-sha256=${createHmac("sha256", Buffer.from(key, "base64")).update(payload).digest("hex")}`
    const options = { provider: "hmac", secret: "AIRTABLE_WEBHOOK_SECRET", header: "X-Airtable-Content-MAC", prefix: "hmac-sha256=", encoding: "hex", secretEncoding: "base64" } as const
    const [error, notification] = await verifyWebhook(post({ "x-airtable-content-mac": mac }, payload), { ...options, schema: v.object({ webhook: v.object({ id: v.string() }) }) })
    expect(error).toBeUndefined()
    expect(notification?.webhook.id).toBe("ach1")
  })

  it("returns ENV_WEBHOOK_BODY_INVALID for a signed body that is not JSON", async () => {
    vi.stubEnv("LULU_WEBHOOK_SECRET", "lulu-secret")
    const payload = "status=SHIPPED"
    const signature = createHmac("sha256", "lulu-secret").update(payload).digest("hex")
    const [error] = await verifyWebhook(post({ "lulu-hmac-sha256": signature }, payload), { provider: "hmac", secret: "LULU_WEBHOOK_SECRET", header: "Lulu-HMAC-SHA256" })
    expect(error?.code).toBe("ENV_WEBHOOK_BODY_INVALID")
    expect(error?.cause).toBeInstanceOf(SyntaxError)
  })
})

describe("verifyWebhook() events", () => {
  it("reads an H3 event and Cloudflare bindings", async () => {
    const bindings = { STRIPE_WEBHOOK_SECRET: stripeSecret }
    await runWithCloudflareEnv(bindings, async () => {
      const event = { context: {}, req: post({ "stripe-signature": stripeHeader(body) }), res: { headers: new Headers() } }
      const [error] = await verifyWebhook(event, { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET" })
      expect(error).toBeUndefined()
    })
  })

  it("reads the bindings of a Standard Context event", async () => {
    const event = {
      "~standard": {
        vendor: "test",
        req: post({ "stripe-signature": stripeHeader(body) }),
        res: { headers: new Headers() },
        runtime: { cloudflare: { env: { STRIPE_WEBHOOK_SECRET: stripeSecret } } },
      },
    }
    const [error] = await verifyWebhook(event, { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET" })
    expect(error).toBeUndefined()
  })
})

describe("signWebhook()", () => {
  it("matches node:crypto for GitHub's x-hub-signature-256", async () => {
    const headers = await signWebhook(body, { provider: "github", secret: "github-secret" })
    expect(headers).toEqual({ "x-hub-signature-256": `sha256=${createHmac("sha256", "github-secret").update(body).digest("hex")}` })
    expect(await signWebhook("Hello, World!", { provider: "github", secret: "It's a Secret to Everybody" })).toEqual({
      "x-hub-signature-256": "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    })
  })

  it("matches node:crypto for stripe-signature with a fixed time", async () => {
    expect(await signWebhook(new TextEncoder().encode(body), { provider: "stripe", secret: stripeSecret, timestamp: 1700000000 })).toEqual({
      "stripe-signature": stripeHeader(body, stripeSecret, 1700000000),
    })
  })

  for (const provider of ["github", "stripe"] as const) {
    it(`round-trips through verifyWebhook({ provider: "${provider}" })`, async () => {
      vi.stubEnv("HOOK_SECRET", "hook-secret")
      const options = { provider, secret: "HOOK_SECRET" }
      const headers = await signWebhook(body, { provider, secret: "hook-secret" })
      const [error, event] = await verifyWebhook(post(headers), { ...options, schema: v.object({ id: v.string() }) })
      expect(error).toBeUndefined()
      expect(event?.id).toBe("evt_1")

      const [tampered] = await verifyWebhook(post(headers, body.replace("evt_1", "evt_2")), options)
      expect(tampered?.code).toBe("ENV_WEBHOOK_SIGNATURE_INVALID")
      const [wrongSecret] = await verifyWebhook(post(await signWebhook(body, { provider, secret: "other-secret" })), options)
      expect(wrongSecret?.code).toBe("ENV_WEBHOOK_SIGNATURE_INVALID")
    })
  }
})
