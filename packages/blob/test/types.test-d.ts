import type { UserConfig } from "vite"
import virtualConfig, { blob as virtualBlob, hosting as virtualHosting } from "#vitehub/blob/config"

import { describe, expectTypeOf, it } from "vitest"

import { blob, type BlobModuleOptions, type BlobObject, type BlobResult, type BlobServeAuthorize, type BlobStoreConfig, type ResolvedBlobModuleOptions } from "../src/index.ts"
import { hubBlob } from "../src/vite.ts"

describe("types", () => {
  it("narrows Blob store configs by driver", () => {
    const store = {
      base: ".vitehub/data/blob",
      driver: "fs",
    } satisfies BlobStoreConfig

    expectTypeOf(store.base).toEqualTypeOf<string>()
  })

  it("exposes the resolved module options shape", () => {
    const config = {
      store: {
        binding: "BLOB",
        driver: "cloudflare-r2",
      },
    } satisfies ResolvedBlobModuleOptions

    expectTypeOf(config.store.binding).toEqualTypeOf<string>()
  })

  it("augments vite user config with blob options", () => {
    const config: UserConfig = {
      blob: {
        driver: "fs",
      },
    }

    expectTypeOf(config.blob).toMatchTypeOf<BlobModuleOptions | undefined>()
  })

  it("accepts static headers for generated serving routes", () => {
    const config = {
      driver: "fs",
      serve: {
        headers: {
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      },
    } satisfies BlobModuleOptions

    expectTypeOf(config.serve.headers).toEqualTypeOf<{
      "Cache-Control": string
      "X-Content-Type-Options": string
    }>()
  })

  it("accepts a boolean serve authorization and types the server module callback", () => {
    const config = {
      driver: "fs",
      serve: { authorize: true, route: "/photos" },
    } satisfies BlobModuleOptions
    expectTypeOf(config).toMatchTypeOf<BlobModuleOptions>()

    // @ts-expect-error Vite config cannot carry the callback. Export it from server/blob.ts.
    const callbackConfig: BlobModuleOptions = { driver: "fs", serve: { authorize: () => true } }
    expectTypeOf(callbackConfig).toMatchTypeOf<BlobModuleOptions>()

    const authorize: BlobServeAuthorize = ({ request, user }) =>
      new URL(request.url).pathname.startsWith(`/photos/${user.id}/`)
    expectTypeOf(authorize).parameter(0).toHaveProperty("session").toEqualTypeOf<Record<string, unknown>>()
    expectTypeOf(authorize).returns.toMatchTypeOf<boolean | Response | Promise<boolean | Response>>()
  })

  it("allows MinIO to resolve common Docker env defaults", () => {
    const config: UserConfig = {
      blob: {
        driver: "minio",
      },
    }

    expectTypeOf(config.blob).toMatchTypeOf<BlobModuleOptions | undefined>()
  })

  it("exposes the intended Blob runtime surface", () => {
    expectTypeOf(blob.get).returns.toEqualTypeOf<Promise<BlobResult<Blob | null>>>()
    expectTypeOf(blob.head).returns.toEqualTypeOf<Promise<BlobResult<BlobObject | null>>>()
    expectTypeOf(blob.list).toBeFunction()
    expectTypeOf(blob.put).toBeFunction()
    expectTypeOf(blob.serve).returns.toEqualTypeOf<Promise<BlobResult<ReadableStream | null>>>()
    expectTypeOf(blob.sign("private/audio.mp3", { expiresIn: 900, method: "GET" })).toEqualTypeOf<Promise<BlobResult<{
      headers: Record<string, string>
      method: "GET" | "PUT"
      url: string
    }>>>()
    expectTypeOf(blob.sign("private/audio.mp3", {
      contentType: "audio/mpeg",
      createOnly: true,
      expiresIn: 900,
      method: "PUT",
    })).toMatchTypeOf<Promise<BlobResult<{ url: string }>>>()
  })

  it("narrows Blob results by the error element", async () => {
    const [error, value] = await blob.put("proof.txt", "value")
    if (error) {
      expectTypeOf(error.code).toEqualTypeOf<"BLOB_NOT_FOUND" | "BLOB_OPERATION_FAILED">()
      expectTypeOf(value).toEqualTypeOf<undefined>()
      return
    }
    expectTypeOf(error).toEqualTypeOf<null>()
    expectTypeOf(value.pathname).toEqualTypeOf<string>()
  })

  it("returns a vite plugin with runtime config access", () => {
    const plugin = hubBlob()
    expectTypeOf(plugin.api.getConfig().blob).toMatchTypeOf<false | ResolvedBlobModuleOptions>()
  })

  it("exposes the generated config import types", () => {
    expectTypeOf(virtualHosting).toMatchTypeOf<string | undefined>()
    expectTypeOf(virtualBlob).toMatchTypeOf<false | ResolvedBlobModuleOptions>()
    expectTypeOf(virtualConfig.blob).toMatchTypeOf<false | ResolvedBlobModuleOptions>()
  })
})
