import type { BlobOptions } from "@vite-hub/blob"
import type { BlobImageProviderOptions } from "@vite-hub/blob/nuxt-image"

interface NuxtImageProviderDependency {
  "@nuxt/image": {
    defaults: { providers: { vitehub: { options: BlobImageProviderOptions, provider: string } } }
    optional: true
  }
}

function usesNuxtImage(modules: unknown[] | undefined): boolean {
  return (modules ?? []).some(entry => (Array.isArray(entry) ? entry[0] : entry) === "@nuxt/image")
}

/**
 * Registers the `vitehub` Nuxt Image provider when the app enables `@nuxt/image` and serves a Blob Store. Nuxt reads
 * dependency defaults before any module setup, so the order of `modules` does not matter, and an
 * `image.providers.vitehub` entry in the app config wins. Reads `vitehub.blob` from `nuxt.config.ts` only.
 */
export function nuxtImageProviderDependency(options: { app?: { baseURL?: string }, modules?: unknown[], vitehub?: { blob?: boolean | BlobOptions } }): NuxtImageProviderDependency | undefined {
  const blob = options.vitehub?.blob
  if (!blob || blob === true || !blob.serve || !usesNuxtImage(options.modules)) return undefined
  const serve = blob.serve === true ? {} : blob.serve
  // The default of `blob.serve.route`. A value import from `@vite-hub/blob` would load the optional owner in every app.
  const route = `/${(serve.route?.trim() || "/api/_vitehub/blob").replace(/^\/+|\/+$/g, "")}`
  const publicBaseUrl = serve.publicBaseUrl?.trim()
  const mount = publicBaseUrl || options.app?.baseURL || ""
  const baseURL = `${mount.replace(/\/+$/, "")}${route}`
  const sizes = blob.images ? blob.images.sizes : undefined
  return {
    "@nuxt/image": {
      defaults: { providers: { vitehub: { options: { baseURL, ...(sizes ? { imageSizes: sizes } : {}) }, provider: "vite-hub/blob/nuxt-image" } } },
      optional: true,
    },
  }
}
