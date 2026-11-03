import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { blobDevMaximumListLimit, blobPutRequestBytes } from "./results.ts"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { BlobDevDeleteResult, BlobDevGetResult, BlobDevHeadResult, BlobDevListResult, BlobDevMediaResult, BlobDevPutResult, BlobDevVariantsResult } from "./runtime/operations.ts"

// The runtime module imports the Blob storage of the app, which only exists in the Nitro runtime. The operations load
// it when they run, so the CLI and `vitehub inspect` can list them without it.
const runtime = () => import("./runtime/operations.ts")

const store = v.optional(v.pipe(v.string(), v.check(name => name.trim() !== "", "Name a store.")))
const pathname = v.pipe(v.string(), v.nonEmpty("Give the pathname of a blob."))

function defineBlobOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  // The stores answer for the section. The operations never read the signed-in user.
  return defineOperation({ ...definition, section: "blob", user: false })
}

const list = defineBlobOperation<{ cursor?: string, folded?: boolean, limit?: number, prefix?: string, showVitehub?: boolean, store?: string }, BlobDevListResult>({
  description: "List the blobs of a Blob store, one page at a time.",
  input: v.object({
    cursor: v.optional(v.string()),
    folded: v.optional(v.boolean()),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(blobDevMaximumListLimit))),
    prefix: v.optional(v.string()),
    showVitehub: v.optional(v.boolean()),
    store,
  }),
  kind: "read",
  name: "blob.list",
  run: async input => await (await runtime()).runBlobOperation("list", input) as BlobDevListResult,
})

const head = defineBlobOperation<{ pathname: string, store?: string }, BlobDevHeadResult>({
  cli: { positional: ["pathname"] },
  description: "Show the metadata of one blob.",
  input: v.object({ pathname, store }),
  kind: "read",
  name: "blob.head",
  run: async input => await (await runtime()).runBlobOperation("head", input) as BlobDevHeadResult,
})

const get = defineBlobOperation<{ pathname: string, store?: string }, BlobDevGetResult>({
  cli: { positional: ["pathname"] },
  description: "Download one blob as base64. A blob over 8 MiB is refused.",
  input: v.object({ pathname, store }),
  kind: "read",
  name: "blob.get",
  run: async input => await (await runtime()).runBlobOperation("get", input) as BlobDevGetResult,
})

const put = defineBlobOperation<{ contentType?: string, data: string, overwrite?: boolean, pathname: string, store?: string }, BlobDevPutResult>({
  cli: { positional: ["pathname"] },
  description: "Upload one file, given as base64, as a blob. A file over 8 MiB is refused. `overwrite: false` refuses to replace a blob that exists.",
  input: v.object({ contentType: v.optional(v.string()), data: v.string(), overwrite: v.optional(v.boolean()), pathname, store }),
  kind: "write",
  maxRequestBytes: blobPutRequestBytes,
  name: "blob.put",
  run: async input => await (await runtime()).runBlobOperation("put", input) as BlobDevPutResult,
})

const del = defineBlobOperation<{ pathname: string, store?: string }, BlobDevDeleteResult>({
  cli: { command: "del", positional: ["pathname"] },
  description: "Delete one blob.",
  input: v.object({ pathname, store }),
  kind: "destructive",
  name: "blob.del",
  run: async input => await (await runtime()).runBlobOperation("del", input) as BlobDevDeleteResult,
})

const media = defineBlobOperation<{ pathname: string, store?: string }, BlobDevMediaResult>({
  cli: { positional: ["pathname"] },
  description: "Show the media record of one blob: size, dimensions, hash, alt text, focal point, and crops.",
  input: v.object({ pathname, store }),
  kind: "read",
  name: "blob.media",
  run: async input => await (await runtime()).runBlobOperation("media", input) as BlobDevMediaResult,
})

const variants = defineBlobOperation<{ pathname: string, store?: string }, BlobDevVariantsResult>({
  cli: { positional: ["pathname"] },
  description: "List the cached image variants of one blob and its crop replacements.",
  input: v.object({ pathname, store }),
  kind: "read",
  name: "blob.variants",
  run: async input => await (await runtime()).runBlobOperation("variants", input) as BlobDevVariantsResult,
})

/** The `blob.*` operations: list, head, get, put, del, media, and variants. The Console, `vitehub blob`, and agents run them. */
export const blobOperations: readonly AnyOperation[] = [list, head, get, put, del, media, variants]

export type { BlobDevDeleteResult, BlobDevGetResult, BlobDevHeadResult, BlobDevListResult, BlobDevMediaResult, BlobDevPutResult, BlobDevVariantsResult }

export { createStandaloneOperationHandler } from "@vite-hub/internal/operations-dev"
