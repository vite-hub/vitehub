import { describe, expect, it } from "vitest"

import blobImageProvider from "../../blob/src/nuxt-image.ts"
import { nuxtImageProviderDependency } from "../src/internal/nuxt-image.ts"

const { getImage } = blobImageProvider()

describe("Nuxt Image application mount", () => {
  it.each([
    [{ access: "public" }, "/portal/api/_vitehub/blob"],
    [{ access: "public", route: "/media/" }, "/portal/media"],
    [{ access: "public", publicBaseUrl: "https://cdn.example/", route: "/media/" }, "https://cdn.example/media"],
    [{ access: "public", publicBaseUrl: "/cdn/", route: "/media/" }, "/cdn/media"],
  ] as const)("aligns served image URLs with configuration %j", (serve, baseURL) => {
    const dependency = nuxtImageProviderDependency({
      app: { baseURL: "/portal/" },
      modules: ["@nuxt/image"],
      vitehub: { blob: { driver: "fs", serve } },
    })
    const options = dependency!["@nuxt/image"].defaults.providers.vitehub.options
    expect(options.baseURL).toBe(baseURL)
    expect(getImage("/photos/cat.jpg", { ...options, modifiers: { width: 400 } }).url).toBe(`${baseURL}/photos/cat.jpg?w=640`)
    expect(getImage(`${baseURL}/photos/cat.jpg`, { ...options, modifiers: { width: 400 } }).url).toBe(`${baseURL}/photos/cat.jpg?w=640`)
  })
})
