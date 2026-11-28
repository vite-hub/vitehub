import { describe, expect, it } from "vitest"
import { vitehub, type ViteHubOptions } from "../src/index.ts"

describe("removed vitehub() options", () => {
  it.each([
    ["preset", "cloudflare", "Rename `preset` to `host`."],
    ["sandbox", true, "Rename `sandbox` to `sandboxTask: true`."],
    ["devtools", false, "Remove `devtools`."],
    ["contentImportBase", "vite-hub/content", "Remove `contentImportBase`."],
  ])("fails on `%s` instead of ignoring it", (key, value, fix) => {
    // SAFETY: the test passes an option that ViteHubOptions no longer declares, as an old config does.
    const options = { host: "node", env: false, [key]: value } as ViteHubOptions
    expect(() => vitehub(options)).toThrow(expect.objectContaining({
      code: "VITE_HUB_B0024",
      message: expect.stringContaining(`\`${key}\` in \`vitehub()\` is no longer a ViteHub option.`),
    }))
    expect(() => vitehub(options)).toThrow(fix)
  })

  it("rejects removed secretsFile while accepting Worker vars", () => {
    expect(() => vitehub({ host: "cloudflare", env: false, cloudflare: { vars: true } })).not.toThrow()
    expect(() => vitehub({ host: "cloudflare", env: false, cloudflare: { secretsFile: ".env" } } as ViteHubOptions)).toThrow("Remove `cloudflare.secretsFile`.")
  })

  it("fails on `observability.logs` with the move to `logs`", () => {
    // SAFETY: the test passes an option that ObservabilityOptions no longer declares, as an old config does.
    const options = { host: "node", env: false, observability: { logs: true } } as ViteHubOptions
    expect(() => vitehub(options)).toThrow(expect.objectContaining({
      code: "VITE_HUB_B0024",
      message: expect.stringContaining("Move it to `vitehub({ logs: ... })`."),
    }))
    expect(() => vitehub({ host: "node", env: false, logs: true })).not.toThrow()
  })

  it("accepts `host`", () => {
    expect(() => vitehub({ host: "cloudflare", env: false })).not.toThrow()
  })

  it("rejects legacy logs.evlog instead of ignoring enabled: false", () => {
    const options = { host: "node", logs: { evlog: { enabled: false } } } as ViteHubOptions
    expect(() => vitehub(options)).toThrow(expect.objectContaining({
      code: "VITE_HUB_B0024",
      message: expect.stringContaining("`observability.evlog`"),
    }))
  })
})

describe("unknown vitehub() options", () => {
  it.each([
    ["rate-limit", "Rename `rate-limit` to `rateLimit`."],
    ["kvv", "Rename `kvv` to `kv`."],
    ["databse", "Rename `databse` to `database`."],
    ["stripe", "Remove `stripe`, or use an option from https://vitehub.dev/docs/reference/config-options."],
  ])("fails on `%s` instead of ignoring it", (key, fix) => {
    // SAFETY: the test passes a key that ViteHubOptions does not declare, as a typo in a config does.
    const options = { host: "node", env: false, [key]: true } as ViteHubOptions
    expect(() => vitehub(options)).toThrow(expect.objectContaining({
      code: "VITE_HUB_UNKNOWN_OPTION",
      message: expect.stringContaining(`\`${key}\` in \`vitehub()\` is not a ViteHub option.`),
      fix,
    }))
  })

  it("accepts an unknown key set to undefined", () => {
    // SAFETY: a config spreads an optional value that is unset.
    expect(() => vitehub({ host: "node", env: false, extra: undefined } as ViteHubOptions)).not.toThrow()
  })
})

describe("vitehub() option values", () => {
  it.each([
    ["blob", 1, "`blob` in `vitehub()` is `1`, but it must be `true`, `false`, or an object of options.", "Set `blob: true` to turn it on with the defaults of the host, pass an object to set its options, or set `blob: false` to turn it off."],
    ["email", "resend", "`email` in `vitehub()` is `\"resend\"`, but it must be `true`, `false`, or an object of options.", "Set `email: true`"],
    ["logs", ["dev"], "`logs` in `vitehub()` is an array, but it must be `true`, `false`, or an object of options.", "set `logs: false` to turn it off."],
    ["env", true, "`env` in `vitehub()` is `true`, but it must be `false` or an object of options.", "Pass an object to set the options of `env`, or set `env: false` to turn it off."],
    ["docker", "yes", "`docker` in `vitehub()` is `\"yes\"`, but it must be `true` or `false`.", "Set `docker: true` or `docker: false`."],
    ["cloudflare", true, "`cloudflare` in `vitehub()` is `true`, but it must be an object of options.", "Pass an object to set the options of `cloudflare`, or remove `cloudflare`."],
    ["name", 1, "`name` in `vitehub()` is `1`, but it must be a string.", "Set `name` to a string, such as `name: \"shop\"`, or remove it."],
    ["publicUrl", { url: "https://shop.example.com" }, "`publicUrl` in `vitehub()` is an object, but it must be a URL string or a function that returns one.", "Set `publicUrl` to the public URL of the app"],
  ])("names the accepted values of `%s` when it is %j", (key, value, why, fix) => {
    // SAFETY: the test passes a value of the wrong type, as a config without type checks does.
    const options = { host: "node", ...(key === "env" ? {} : { env: false }), [key]: value } as ViteHubOptions
    expect(() => vitehub(options)).toThrow(expect.objectContaining({
      code: "VITE_HUB_INVALID_OPTION",
      message: expect.stringContaining(why),
      fix: expect.stringContaining(fix),
    }))
  })

  it.each([
    ["blob", true],
    ["blob", { driver: "fs" }],
    ["blob", false],
    ["docker", false],
    ["name", "shop"],
    ["publicUrl", (agent: string) => `https://${agent}.example.com`],
  ])("accepts `%s: %j`", (key, value) => {
    const options: ViteHubOptions = { host: "node", env: false, [key]: value }
    expect(() => vitehub(options)).not.toThrow()
  })
})
