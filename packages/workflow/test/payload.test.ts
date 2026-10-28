import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"

import { readRequestPayload, readValidatedPayload, validatePayload } from "../src/runtime/payload.ts"

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

describe("workflow request payloads", () => {
  it.each(["application/json", "Application/JSON", "APPLICATION/JSON; charset=utf-8", "application/json ; charset=utf-8"])("parses the JSON media type %s", async (contentType) => {
    const request = new Request("https://example.com/workflow", {
      method: "POST",
      headers: { "content-type": contentType },
      body: JSON.stringify({ email: "ada@example.com" }),
    })
    await expect(readRequestPayload(request)).resolves.toEqual({ email: "ada@example.com" })
  })

  it.each(["text/plain", "application/jsonp", 'text/plain; note="application/json"'])("reads %s as text", async (contentType) => {
    const request = new Request("https://example.com/workflow", {
      method: "POST",
      headers: { "content-type": contentType },
      body: "plain payload",
    })
    await expect(readRequestPayload(request)).resolves.toBe("plain payload")
  })

  it("passes parsed JSON to the validator for mixed-case media types", async () => {
    const request = new Request("https://example.com/workflow", {
      method: "POST",
      headers: { "content-type": "Application/JSON; charset=UTF-8" },
      body: JSON.stringify({ email: "ada@example.com" }),
    })
    await expect(readValidatedPayload(request, (value) => {
      if (!value || typeof value !== "object" || !("email" in value) || typeof value.email !== "string") {
        throw new Error("Expected an email payload")
      }
      return value.email
    })).resolves.toBe("ada@example.com")
  })
})
