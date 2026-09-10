import { expectTypeOf, it } from "vitest"

import {
  renderMarkdownTemplate,
  type RenderMarkdownTemplateOptions,
} from "../src/index.ts"
import {
  renderMarkdownTemplateInternal,
  type RenderMarkdownTemplateInternalOptions,
} from "../src/internal/composition.ts"

it("exports the Markdown template contract", () => {
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
