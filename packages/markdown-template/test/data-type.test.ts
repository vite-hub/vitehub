import { expect, it } from "vitest"

import { renderMarkdownTemplate } from "../src/index.ts"
import { assertNoBindingsInCode, inferMarkdownTemplateDataType } from "../src/internal/vite.ts"

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

const strataTemplate = [
  "Strata could not complete the archaeology run for `{{ repoPath }}`.",
  "",
  "```text",
  "{{ errorMessage }}",
  "```",
  "",
  "[Open the analysis]({{ resultUrl }})",
].join("\n")

it("names the migration for a binding that does not start with data.", async () => {
  for (const template of [strataTemplate, "[Open the analysis](){:href=\"resultUrl\"}", "<img :src=\"url\">", "::if{:condition=\"ready\"}\nReady.\n::"]) {
    await expect(inferMarkdownTemplateDataType(template), template).rejects.toMatchObject({
      code: "MARKDOWN_TEMPLATE_BINDING_OUTSIDE_DATA",
      fix: expect.stringContaining("{{ data.name }}"),
    })
  }
  await expect(renderMarkdownTemplate(strataTemplate, { data: { resultUrl: "https://strata.vitehub.dev/a/1" } })).rejects.toMatchObject({
    code: "MARKDOWN_TEMPLATE_BINDING_OUTSIDE_DATA",
    message: expect.stringContaining("\"resultUrl\""),
  })
  await expect(inferMarkdownTemplateDataType("::if{:condition=\"true\"}\n{{ frontmatter.title }}\n::")).resolves.toEqual({ required: false, type: "Record<string, never>" })
})

it("does not validate roots on attributes that the renderer preserves", async () => {
  const template = "![Logo](/logo.png){:class=\"logo\"}\n\n# Status {:class=\"notice\"}\n\n::notice{:title=\"hello\"}\n::"
  await expect(inferMarkdownTemplateDataType(template)).resolves.toEqual({ required: false, type: "Record<string, never>" })
})

it("rejects a binding inside inline code or a code block, which would stay unfilled", async () => {
  for (const [template, path] of [
    ["`{{ command }}`", "command"],
    ["Strata finished mapping `{{ data.repoPath }}`.", "data.repoPath"],
    ["`{{ data.full name || unknown }}`", "data.full name"],
    ["<div>\nRun `{{ data.command }}`.\n</div>", "data.command"],
    ["```text\n{{ data.errorMessage }}\n```", "data.errorMessage"],
    ["```text\n: {{ data.command }}\n```", "data.command"],
    ["<pre>\n{{ data.log }}\n</pre>", "data.log"],
  ]) {
    await expect(assertNoBindingsInCode(template!), template).rejects.toMatchObject({
      code: "MARKDOWN_TEMPLATE_BINDING_IN_CODE",
      message: expect.stringContaining(`{{ ${path} }}`),
      fix: expect.stringContaining(":insert"),
    })
  }
  await expect(assertNoBindingsInCode("Strata finished mapping **{{ data.repoPath }}**. Run `pnpm build`.")).resolves.toBeUndefined()
  await expect(renderMarkdownTemplate("Write `{{ data.name }}`.", { data: {} })).resolves.toBe("Write `{{ data.name }}`.")
})
