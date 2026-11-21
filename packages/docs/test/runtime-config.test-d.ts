import { useRuntimeConfig } from "nitro/runtime-config"
import { useRuntimeConfig as useAppRuntimeConfig } from "nuxt/app"
import { expectTypeOf } from "vitest"

import type { DocsPublicConfig } from "../src/nuxt.ts"

// The server handlers and the app read the docs options with their type, not `any`.
expectTypeOf(useRuntimeConfig().public.docs).toEqualTypeOf<DocsPublicConfig>()
expectTypeOf(useAppRuntimeConfig().public.docs).toEqualTypeOf<DocsPublicConfig>()
expectTypeOf(useRuntimeConfig().public.docs.site.url).toEqualTypeOf<string>()

// @ts-expect-error The site options are not a number.
export const siteValue: number = useRuntimeConfig().public.docs.site
