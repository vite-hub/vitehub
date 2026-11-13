import { describe, expect, it } from "vitest"

import {
  consoleBodySha256,
  consoleCallerHeader,
  consoleSignatureHeader,
  consoleSignedText,
  createConsoleKeyPair,
  decodeConsoleCaller,
  encodeConsoleCaller,
  readConsolePublicKeys,
  readConsoleSigningKey,
  signConsoleRequest,
  verifyConsoleSignature,
} from "../src/console-signature.ts"

const url = "https://app.example.com/_vitehub/rpc"
const body = "{\"m\":\"project.get\",\"a\":[{}],\"t\":\"q\",\"i\":\"1\"}"
const now = 1_794_400_000_000

describe("Console signatures", () => {
  it("signs the documented text, one field per line", async () => {
    const { privateKey, publicKey } = await createConsoleKeyPair()
    const headers = new Headers(await signConsoleRequest({ body, caller: { via: "cli" }, key: { name: "CI", privateKey }, method: "post", now, url }))
    const digest = await consoleBodySha256(body)
    const caller = headers.get(consoleCallerHeader)!
    expect(caller).toBe(Buffer.from("{\"via\":\"cli\"}").toString("base64url"))
    const signature = headers.get(consoleSignatureHeader)!
    expect(signature).toMatch(new RegExp(`^key=CI, t=1794400000, origin=https://app\\.example\\.com, body=${digest}, v1=[\\w-]{86}$`))
    const text = consoleSignedText({ bodySha256: digest, caller, key: "CI", method: "post", origin: "https://app.example.com", target: "/_vitehub/rpc", timestamp: "1794400000" })
    expect(text).toBe(`vitehub-signature-v1\nPOST\n/_vitehub/rpc\nhttps://app.example.com\n1794400000\nCI\n${digest}\n${caller}`)
    // Anyone with the public key can check the documented text with plain Web Crypto.
    const key = await crypto.subtle.importKey("raw", Buffer.from(publicKey, "base64url"), { name: "Ed25519" }, false, ["verify"])
    const bytes = Buffer.from(signature.slice(signature.indexOf("v1=") + 3), "base64url")
    await expect(crypto.subtle.verify({ name: "Ed25519" }, key, bytes, new TextEncoder().encode(text))).resolves.toBe(true)
  })

  it("hashes the exact bytes: zero bytes for no body", async () => {
    expect(await consoleBodySha256()).toBe(Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array())).toString("base64url"))
    expect(await consoleBodySha256(new TextEncoder().encode(body))).toBe(await consoleBodySha256(body))
  })

  it("verifies a match and returns the caller, the key name, and the signed digest", async () => {
    const { privateKey, publicKey } = await createConsoleKeyPair()
    const caller = { team: { id: "t", role: "owner" }, user: { email: "ada@example.com", id: "u", name: "Ada" }, via: "console" } as const
    const headers = new Headers(await signConsoleRequest({ body, caller, key: { name: "CONSOLE_3F9A12BC", privateKey }, method: "POST", now, url }))
    const keys = readConsolePublicKeys({ OTHER: "x", VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC: ` ${publicKey} ` })
    if (!(keys instanceof Map)) throw new Error(keys.message)
    await expect(verifyConsoleSignature({ headers, keys, method: "POST", now: now + 299_000, origin: "https://app.example.com/base", url })).resolves.toEqual({
      bodySha256: await consoleBodySha256(body),
      caller,
      key: "CONSOLE_3F9A12BC",
      ok: true,
    })
    await expect(verifyConsoleSignature({ headers, keys, method: "POST", now: now + 301_000, origin: "https://app.example.com", url })).resolves.toMatchObject({ code: "CONSOLE_SIGNATURE_STALE", message: expect.stringContaining("5 minutes ago") })
    await expect(verifyConsoleSignature({ headers, keys, method: "PUT", now, origin: "https://app.example.com", url })).resolves.toMatchObject({ code: "CONSOLE_SIGNATURE_INVALID" })
  })

  it.each([
    ["a CLI caller", { via: "cli" }],
    ["a Console caller without a team", { user: { id: "u" }, via: "console" }],
  ])("reads %s", (_name, caller) => {
    expect(decodeConsoleCaller(Buffer.from(JSON.stringify(caller)).toString("base64url"))).toEqual(caller)
  })

  it.each([
    ["a CLI caller with a user", { user: { id: "u" }, via: "cli" }],
    ["a Console caller without a user", { via: "console" }],
    ["an empty user id", { user: { id: "" }, via: "console" }],
    ["an extra field", { admin: true, user: { id: "u" }, via: "console" }],
    ["an unknown via", { via: "agent" }],
    ["a role that is not text", { team: { id: "t", role: 1 }, user: { id: "u" }, via: "console" }],
  ])("refuses %s", (_name, caller) => {
    expect(decodeConsoleCaller(Buffer.from(JSON.stringify(caller)).toString("base64url"))).toBeUndefined()
  })

  it("round-trips a caller", () => {
    const caller = { user: { id: "u", name: "Ada" }, via: "console" } as const
    expect(decodeConsoleCaller(encodeConsoleCaller(caller))).toEqual(caller)
    expect(decodeConsoleCaller("not base64url!")).toBeUndefined()
  })

  it("reads one CLI signing key from the env, and refuses two or a malformed one", async () => {
    const { privateKey } = await createConsoleKeyPair()
    expect(readConsoleSigningKey({})).toBeUndefined()
    expect(readConsoleSigningKey({ VITEHUB_CONSOLE_PRIVATE_KEY_CI: privateKey })).toEqual({ name: "CI", privateKey })
    expect(() => readConsoleSigningKey({ VITEHUB_CONSOLE_PRIVATE_KEY_A: privateKey, VITEHUB_CONSOLE_PRIVATE_KEY_B: privateKey })).toThrow("Set one VITEHUB_CONSOLE_PRIVATE_KEY_<NAME> variable")
    expect(() => readConsoleSigningKey({ VITEHUB_CONSOLE_PRIVATE_KEY_CI: "ab".repeat(32) })).toThrow("43-character private key")
    expect(() => readConsoleSigningKey({ "VITEHUB_CONSOLE_PRIVATE_KEY_ci-key": privateKey })).toThrow("43-character private key")
  })
})
