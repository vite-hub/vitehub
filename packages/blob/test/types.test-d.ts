import { expectTypeOf } from "vitest"
import { blob, ensureBlob } from "../src/index.ts"
import type {
  BlobEnsureOptions,
  BlobListOptions,
  BlobObject,
  BlobPutOptions,
  BlobStorage,
  CloudflareR2BlobConfig,
  VercelBlobConfig,
} from "../src/index.ts"

expectTypeOf(blob).toEqualTypeOf<BlobStorage>()
expectTypeOf(ensureBlob).parameter(1).toEqualTypeOf<BlobEnsureOptions | undefined>()
expectTypeOf<CloudflareR2BlobConfig>().toMatchTypeOf<{ driver: "cloudflare-r2" }>()
expectTypeOf<VercelBlobConfig>().toMatchTypeOf<{ access?: "public", driver: "vercel-blob" }>()
expectTypeOf<BlobListOptions>().toMatchTypeOf<{ prefix?: string }>()
expectTypeOf<BlobPutOptions>().toMatchTypeOf<{ contentType?: string }>()
expectTypeOf<BlobObject>().toMatchTypeOf<{ pathname: string }>()
