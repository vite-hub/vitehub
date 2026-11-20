import { expect, it } from "vitest"

import { renderMarkdownTemplate } from "../src/index.ts"
import { inferMarkdownTemplateDataType } from "../src/internal/vite.ts"

it("types every data binding that a template reads", async () => {
  const template = [
    "# Hi {{ data.user.name }}",
    "",
    "[Open](){:href=\"data.url\"}",
    "",
    "<policy :audience=\"data.audience\">Read it.</policy>",
    "",
    ":insert{:markdown=\"data.summary\"}",
    "",
    "```md",
    "{{ data.literal }}",
    "```",
  ].join("\n")

  await expect(inferMarkdownTemplateDataType(template)).resolves.toEqual({
    required: true,
    type: [
      "{",
      "  \"user\": {",
      "    \"name\": string | number | boolean",
      "  }",
      "  \"url\": string | number | boolean",
      "  \"audience\": string | number | boolean",
      "  \"summary\": string",
      "}",
    ].join("\n"),
  })
})

it("makes values of a condition and of its branches optional", async () => {
  const template = [
    "::if{:condition=\"data.plan.trial\"}",
    "Trial ends {{ data.plan.ends }}.",
    "::else-if{:value=\"data.plan.name\" eq=\"pro\"}",
    "Pro",
    "::else",
    "Free",
    "::",
    "::",
    "::",
  ].join("\n")

  await expect(inferMarkdownTemplateDataType(template)).resolves.toEqual({
    required: false,
    type: [
      "{",
      "  \"plan\"?: {",
      "    \"trial\"?: unknown",
      "    \"ends\"?: string | number | boolean | null",
      "    \"name\"?: unknown",
      "  } | null",
      "}",
    ].join("\n"),
  })
})

it("accepts null for an object that a condition checks before its branch reads it", async () => {
  const template = [
    "Hi {{ data.recap.label }}",
    "",
    "::if{:condition=\"data.recap.topRepository\"}",
    "Most active in {{ data.recap.topRepository.name }}.",
    "::",
  ].join("\n")

  await expect(inferMarkdownTemplateDataType(template)).resolves.toEqual({
    required: true,
    type: [
      "{",
      "  \"recap\": {",
      "    \"label\": string | number | boolean",
      "    \"topRepository\"?: {",
      "      \"name\"?: string | number | boolean | null",
      "    } | null",
      "  }",
      "}",
    ].join("\n"),
  })
  await expect(renderMarkdownTemplate(template, { data: { recap: { label: "May", topRepository: null } } })).resolves.toBe("Hi May")
})

it("keeps a value required when the template also reads it outside a branch", async () => {
  const template = "Hi {{ data.name }}\n\n::if{:condition=\"data.name\"}\nAgain {{ data.name }}\n::\n"

  await expect(inferMarkdownTemplateDataType(template)).resolves.toEqual({
    required: true,
    type: "{\n  \"name\": string | number | boolean\n}",
  })
})

it("types a template without bindings as empty data", async () => {
  await expect(inferMarkdownTemplateDataType("# Hello")).resolves.toEqual({ required: false, type: "Record<string, never>" })
})

it("infers bindings in rendered HTML block children", async () => {
  await expect(inferMarkdownTemplateDataType("<div>\nHello {{ data.name }}\n</div>")).resolves.toEqual({
    required: true,
    type: "{\n  \"name\": string | number | boolean\n}",
  })
})

it.each(["code", "pre", "script", "style", "textarea", "kbd", "samp", "var"])("keeps %s HTML block children literal", async (tag) => {
  await expect(inferMarkdownTemplateDataType(`<${tag}>\n{{ data.literal }}\n</${tag}>`)).resolves.toEqual({
    required: false,
    type: "Record<string, never>",
  })
})
