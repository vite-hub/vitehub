import { expect, it } from "vitest"

import { fillTemplateText } from "../src/internal/composition.ts"

it("fills data bindings as plain text", () => {
  expect(fillTemplateText("Welcome {{ data.user.name }}, you have {{data.count}} *new* items", { count: 3, user: { name: "Ada" } }))
    .toBe("Welcome Ada, you have 3 *new* items")
})

it("keeps binding text inside a value as literal text", () => {
  expect(fillTemplateText("Hi {{ data.name }}", { name: "{{ data.secret }} *x*", secret: "leak" })).toBe("Hi {{ data.secret }} *x*")
})

it("uses the binding errors of a template body", () => {
  expect(() => fillTemplateText("Hi {{ data.name }}")).toThrow(expect.objectContaining({ code: "MARKDOWN_TEMPLATE_R0017" }))
  expect(() => fillTemplateText("Hi {{ data.name }}", { name: { first: "Ada" } })).toThrow(expect.objectContaining({ code: "MARKDOWN_TEMPLATE_R0018" }))
  expect(() => fillTemplateText("Hi {{ name }}", { name: "Ada" })).toThrow(expect.objectContaining({ code: "MARKDOWN_TEMPLATE_BINDING_OUTSIDE_DATA" }))
})
