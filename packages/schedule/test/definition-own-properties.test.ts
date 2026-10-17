import { describe, expect, it } from "vitest"

import { defineSchedule } from "../src/definition.ts"

describe("Schedule definition property ownership", () => {
  it("rejects required fields inherited from a prototype", () => {
    const inherited = Object.create({
      cron: "0 9 * * *",
      handler: () => "inherited",
    })

    expect(() => defineSchedule(inherited)).toThrow(/expects an object with `cron` and `handler`/)
  })

  it("rejects positional options inherited from a prototype", () => {
    const options = Object.create({ manual: true })

    expect(() => defineSchedule("0 9 * * *", () => "ok", options)).toThrow(/inherited.*manual|own property/)
  })

  it("rejects options inherited from a prototype", () => {
    const inherited = Object.assign(Object.create({ manual: true }), {
      cron: "0 9 * * *",
      handler: () => "ok",
    })

    expect(() => defineSchedule(inherited)).toThrow(/inherited.*manual|does not support.*manual/)
  })
})
