import { describe, expect, it } from "vitest"

import { renderOAuthPage } from "../src/oauth-page.ts"

describe("renderOAuthPage", () => {
  it("runs only its own script and sends requests only to the Console origin", async () => {
    const page = renderOAuthPage()
    const policy = page.headers.get("content-security-policy") ?? ""
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1]
    expect(nonce).toBeTruthy()
    expect(policy).toContain("connect-src 'self'")
    expect(policy).toContain("frame-ancestors 'none'")
    const html = await page.text()
    expect(html).toContain(`<script nonce="${nonce}">`)
    // Only the parameters that Better Auth signed go back to it, with the passkey and GitHub sign-in and the consent.
    expect(html).toContain('key === "sig" || key === "ba_param" || names.has(key)')
    for (const path of ["/passkey/verify-authentication", "/sign-in/social", "/oauth2/consent", "/oauth2/public-client-prelogin"]) expect(html).toContain(path)
    expect(renderOAuthPage().headers.get("content-security-policy")).not.toBe(policy)
  })
})
