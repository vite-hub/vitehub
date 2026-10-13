import { describe, expect, it } from "vitest"
import { z } from "zod"

import { bundleSandboxDefinition } from "../src/bundle.ts"
import { readValidatedPayload } from "../src/internal/shared/validation.ts"

async function loadBundledValidation(): Promise<typeof readValidatedPayload> {
  const bundle = await bundleSandboxDefinition(
    "export { readValidatedPayload } from '@vite-hub/sandbox'",
    "/fixture/run.sandbox.ts",
    { execution: "definition", includeProject: false },
  )
  const module = await import(`data:text/javascript;base64,${Buffer.from(bundle.modules[bundle.entry]!).toString("base64")}`) as {
    readValidatedPayload: typeof readValidatedPayload
  }
  return module.readValidatedPayload
}

describe.each([
  { name: "host", load: async () => readValidatedPayload },
  { name: "bundle", load: loadBundledValidation },
])("Sandbox validation ($name)", ({ name, load }) => {
  it("accepts an own Standard Schema validator and a validation function", async () => {
    const read = await load()
    await expect(read("payload", {
      "~standard": { validate: async value => ({ value: value.toUpperCase() }) },
    })).resolves.toBe("PAYLOAD")
    await expect(read("payload", value => value.toUpperCase())).resolves.toBe("PAYLOAD")
  })

  it.each([
    { failure: { issues: [] } },
    { failure: { issues: [], value: "must not be returned" } },
    { failure: { issues: [{ message: "Invalid payload" }], value: "must not be returned" } },
  ])("rejects failure result $failure", async ({ failure }) => {
    const read = await load()
    const { issues } = failure
    const validate = { "~standard": { validate: () => failure } }
    await expect(read("payload", validate)).rejects.toMatchObject(
      name === "host" ? { data: { issues } } : { issues },
    )
  })

  it("does not execute a Standard Schema validator inherited from a foreign prototype", async () => {
    const read = await load()
    let calls = 0
    const validate = Object.create({
      "~standard": {
        validate: async () => {
          calls++
          return { value: "accepted" }
        },
      },
    })

    await expect(read("payload", validate as never)).rejects.toBeInstanceOf(Error)
    expect(calls).toBe(0)
  })

  it("accepts an untouched Zod schema with a lazy Standard Schema marker", async () => {
    const read = await load()
    const validate = z.string().transform(value => value.toUpperCase())
    expect(Object.hasOwn(validate, "~standard")).toBe(false)

    await expect(read("payload", validate)).resolves.toBe("PAYLOAD")
    expect(Object.hasOwn(validate, "~standard")).toBe(true)
  })

  it("rejects invalid input through an untouched Zod schema", async () => {
    const read = await load()
    const validate = z.string()
    expect(Object.hasOwn(validate, "~standard")).toBe(false)

    const failure = {
      issues: [expect.objectContaining({ code: "invalid_type" })],
    }
    await expect(read(123, validate)).rejects.toMatchObject(name === "host" ? { data: failure } : failure)
  })
})

it("reports the host validation error code for an inherited marker", async () => {
  const validate = Object.create({
    "~standard": { validate: () => ({ value: "accepted" }) },
  })
  await expect(readValidatedPayload("payload", validate as never)).rejects.toMatchObject({
    code: "SANDBOX_VALIDATION_ERROR",
  })
})
