import { expectTypeOf, it } from "vitest"

import { renderMarkdownFile, type RenderMarkdownFileOptions } from "../src/file.ts"

import {
  renderMarkdownTemplate,
  type RenderMarkdownTemplateOptions,
} from "../src/index.ts"
import {
  renderMarkdownTemplateInternal,
  type RenderMarkdownTemplateInternalOptions,
} from "../src/internal/composition.ts"

it("exports the Markdown template contract", () => {
  expectTypeOf(renderMarkdownFile).parameters.toEqualTypeOf<[
    path: string | URL,
    options?: RenderMarkdownFileOptions,
  ]>()
  expectTypeOf(renderMarkdownFile).returns.toEqualTypeOf<Promise<string>>()
  expectTypeOf(renderMarkdownTemplate).parameters.toEqualTypeOf<[
    template: string,
    options?: RenderMarkdownTemplateOptions,
  ]>()
  expectTypeOf(renderMarkdownTemplate).returns.toEqualTypeOf<Promise<string>>()
  expectTypeOf(renderMarkdownTemplateInternal).parameters.toEqualTypeOf<[
    template: string,
    options?: RenderMarkdownTemplateInternalOptions,
  ]>()
  expectTypeOf<keyof RenderMarkdownTemplateOptions>().toEqualTypeOf<"data">()
})
