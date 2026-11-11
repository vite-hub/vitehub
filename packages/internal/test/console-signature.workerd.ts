import { createConsoleKeyPair, readConsolePublicKeys, signConsoleRequest, verifyConsoleSignature } from "../src/console-signature.ts"

describe("Console signatures in workerd", () => {
  it("makes a key pair, signs, and verifies with the Web Crypto Ed25519 of workerd", async () => {
    const url = "https://app.example.com/_vitehub/rpc"
    const body = "{\"m\":\"project.get\",\"a\":[{}],\"t\":\"q\",\"i\":\"1\"}"
    const { privateKey, publicKey } = await createConsoleKeyPair()
    const headers = new Headers(await signConsoleRequest({ body, caller: { via: "cli" }, key: { name: "CI", privateKey }, method: "POST", url }))
    const keys = readConsolePublicKeys({ VITEHUB_CONSOLE_KEY_CI: publicKey })
    if (!(keys instanceof Map)) throw new Error(keys.message)
    await expect(verifyConsoleSignature({ headers, keys, method: "POST", origin: "https://app.example.com", url })).resolves.toMatchObject({ caller: { via: "cli" }, key: "CI", ok: true })
    const other = await createConsoleKeyPair()
    const forged = new Headers(await signConsoleRequest({ body, caller: { via: "cli" }, key: { name: "CI", privateKey: other.privateKey }, method: "POST", url }))
    await expect(verifyConsoleSignature({ headers: forged, keys, method: "POST", origin: "https://app.example.com", url })).resolves.toMatchObject({ code: "CONSOLE_SIGNATURE_INVALID", ok: false })
  })
})
