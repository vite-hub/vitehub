import { expectTypeOf, it } from "vitest"

import {
  renderMarkdownTemplate,
  type MarkdownTemplateImport,
  type RenderMarkdownTemplateOptions,
  type ResolveMarkdownTemplateImport,
} from "../src/index.ts"
import {
  renderMarkdownTemplateInternal,
  resolveMarkdownTemplateImports,
  type RenderMarkdownTemplateInternalOptions,
  type ResolveMarkdownTemplateImportsOptions,
} from "../src/internal/composition.ts"

it("exports the Markdown template contract", () => {
  expectTypeOf(renderMarkdownTemplate).parameters.toEqualTypeOf<[
    template: string,
    options?: RenderMarkdownTemplateOptions,
  ]>()
  expectTypeOf(renderMarkdownTemplate).returns.toEqualTypeOf<Promise<string>>()
  expectTypeOf(resolveMarkdownTemplateImports).parameters.toEqualTypeOf<[
    template: string,
    options: ResolveMarkdownTemplateImportsOptions,
  ]>()
  expectTypeOf(resolveMarkdownTemplateImports).returns.toEqualTypeOf<Promise<string>>()
  expectTypeOf(renderMarkdownTemplateInternal).parameters.toEqualTypeOf<[
    template: string,
    options?: RenderMarkdownTemplateInternalOptions,
  ]>()
  expectTypeOf<ResolveMarkdownTemplateImport>().returns.toEqualTypeOf<
    MarkdownTemplateImport | undefined | Promise<MarkdownTemplateImport | undefined>
  >()
})
