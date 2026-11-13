import { content } from "#docs/content"
import manifest from "#docs/manifest"
import parser from "#docs/parser"
import { expectTypeOf } from "vitest"

import type { DocsContentRuntime } from "../src/draft.ts"
import type { DocsParserOptions } from "../src/markdown.ts"
import type { DocsManifest } from "../src/types.ts"

expectTypeOf(manifest).toEqualTypeOf<DocsManifest>()
expectTypeOf(content).toEqualTypeOf<DocsContentRuntime | undefined>()
expectTypeOf(parser).toEqualTypeOf<DocsParserOptions>()

// The server handlers read typed modules, not `any`.
// @ts-expect-error A manifest is not a number.
export const manifestValue: number = manifest
// @ts-expect-error The Content runtime is not a number.
export const contentValue: number = content
// @ts-expect-error The parser options are not a number.
export const parserValue: number = parser
