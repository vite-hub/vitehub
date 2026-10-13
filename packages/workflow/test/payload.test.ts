import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"

import { validatePayload } from "../src/runtime/payload.ts"

describe("workflow payload validation", () => {
  it("accepts safeParse schemas", async () => {
    await expect(validatePayload("hello", {
      safeParse: value => ({ success: true, data: String(value) }),
    })).resolves.toBe("hello")
  })

  it("accepts parse schemas", async () => {
    await expect(validatePayload("hello", {
      parse: value => String(value).toUpperCase(),
    })).resolves.toBe("HELLO")
  })

  it("rejects schemas that inherit parser methods", async () => {
    const inherited = {
      safeParse: () => ({ success: true, data: "inherited" }),
      parse: () => "inherited",
    }

    await expect(validatePayload("hello", Object.create(inherited))).rejects.toMatchObject({ code: "WORKFLOW_R0022" })
  })

  it("rejects forged non-class parser prototypes", async () => {
    const prototype = {
      constructor: function FakeSchema() {},
      parse: () => "inherited",
    }
    await expect(validatePayload("hello", Object.create(prototype))).rejects.toMatchObject({ code: "WORKFLOW_R0022" })
  })

  it.each(["parse", "safeParse"])("rejects %s inherited from a foreign Object.prototype", async (method) => {
    const schema: { parse: (value: unknown) => string } = runInNewContext(`
      Object.prototype.${method} = () => {
        throw new Error("Inherited parser must not run")
      }
      ;({})
    `)

    await expect(validatePayload("hello", schema)).rejects.toMatchObject({ code: "WORKFLOW_R0022" })
  })

  it.each(["parse", "safeParse"])("accepts foreign class-backed %s schemas", async (method) => {
    const schema: { parse: (value: unknown) => string } = runInNewContext(`
      class Schema {
        ${method}(value) {
          const data = String(value).toUpperCase()
          return ${method === "safeParse" ? "{ success: true, data }" : "data"}
        }
      }
      class ChildSchema extends Schema {}
      new ChildSchema()
    `)

    await expect(validatePayload("hello", schema)).resolves.toBe("HELLO")
  })

  it("accepts class-backed parser schemas", async () => {
    class ParserSchema {
      parse(value: unknown) {
        return String(value).toUpperCase()
      }
    }

    await expect(validatePayload("hello", new ParserSchema())).resolves.toBe("HELLO")
  })

  it.each(["parse", "safeParse"])("accepts null-parent constructor-backed %s schemas", async (method) => {
    const schema: { parse: (value: unknown) => string } = runInNewContext(`
      class Schema {
        ${method}(value) {
          const data = String(value).toUpperCase()
          return ${method === "safeParse" ? "{ success: true, data }" : "data"}
        }
      }
      Object.setPrototypeOf(Schema.prototype, null)
      new Schema()
    `)

    await expect(validatePayload("hello", schema)).resolves.toBe("HELLO")
  })

  it("accepts parser functions", async () => {
    await expect(validatePayload("hello", value => String(value).length)).resolves.toBe(5)
  })
})
