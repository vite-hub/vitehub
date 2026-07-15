import { expectTypeOf, it } from "vitest"

import {
  renderMarkdownTemplate,
  type MarkdownTemplateImport,
  type RenderMarkdownTemplateOptions,
  type ResolveMarkdownTemplateImport,
} from "../src/index.ts"

it("exports the Markdown template contract", () => {
  expectTypeOf(renderMarkdownTemplate).parameters.toEqualTypeOf<[
    template: string,
    options?: RenderMarkdownTemplateOptions,
  ]>()
  expectTypeOf(renderMarkdownTemplate).returns.toEqualTypeOf<Promise<string>>()
  expectTypeOf<ResolveMarkdownTemplateImport>().returns.toEqualTypeOf<
    MarkdownTemplateImport | undefined | Promise<MarkdownTemplateImport | undefined>
  >()
})
