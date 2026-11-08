import { defineErrors } from "@vite-hub/runtime"
import { defineDiagnostics } from "nostics"

import type { BlobOperation } from "./types.ts"

interface BlobErrorParams {
  /** A more precise reason, such as the pathname that already exists. */
  detail?: string
  operation: BlobOperation
  store: string
}

// Runtime errors. Blob operations return them as `[error, undefined]`. Each code has a heading on the docs page.
export const blobErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/blob/limits-and-errors",
  codes: {
    BLOB_CONFLICT: {
      why: ({ detail, operation, store }: BlobErrorParams) => detail ?? `The Blob ${operation} operation conflicts with existing objects in the "${store}" store.`,
      fix: "Use a free pathname or an empty folder. `media.move()` replaces an object with `{ overwrite: true }`, and `media.removeFolder()` removes the objects of a folder with `{ force: true }`.",
    },
    BLOB_NOT_FOUND: {
      why: ({ detail, operation, store }: BlobErrorParams) => detail ?? `The Blob ${operation} operation found no object in the "${store}" store.`,
      fix: "Check the pathname and the store. A route that throws this error answers 404.",
    },
    BLOB_OPERATION_FAILED: {
      why: ({ operation, store }: BlobErrorParams) => `The Blob ${operation} operation failed on the "${store}" store.`,
      fix: "Read `error.cause` for the provider error. Retry when the provider is available again.",
    },
    BLOB_PATHNAME_TOO_LONG: {
      why: ({ detail, store }: BlobErrorParams) => detail ?? `The pathname is longer than the "${store}" store accepts.`,
      fix: "Use a shorter pathname. Cloudflare R2 accepts object keys of at most 1,024 bytes in UTF-8, after `prefix` and `addRandomSuffix`.",
    },
  },
})


const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Thrown errors. Each code identifies one ViteHub failure site. Keep published codes stable.
export const blobErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/diagnostics",
  codes: {
    BLOB_R0027: dynamicError,
    BLOB_C0001: dynamicError,
    BLOB_C0002: dynamicError,
    BLOB_C0003: dynamicError,
    BLOB_C0004: dynamicError,
    BLOB_C0005: dynamicError,
    BLOB_C0006: dynamicError,
    BLOB_C0007: dynamicError,
    BLOB_C0008: dynamicError,
    BLOB_C0009: dynamicError,
    BLOB_C0010: dynamicError,
    BLOB_C0011: dynamicError,
    BLOB_C0012: dynamicError,
    BLOB_C0013: dynamicError,
    BLOB_C0014: dynamicError,
    BLOB_C0015: dynamicError,
    BLOB_C0016: dynamicError,
    BLOB_C0017: dynamicError,
    BLOB_C0018: dynamicError,
    BLOB_B0001: dynamicError,
    BLOB_B0002: dynamicError,
    BLOB_B0003: dynamicError,
    BLOB_B0004: dynamicError,
    BLOB_B0005: dynamicError,
    BLOB_B0006: dynamicError,
    BLOB_B0007: dynamicError,
    BLOB_R0001: dynamicError,
    BLOB_R0002: dynamicError,
    BLOB_R0003: dynamicError,
    BLOB_R0004: dynamicError,
    BLOB_R0005: dynamicError,
    BLOB_R0006: dynamicError,
    BLOB_R0007: dynamicError,
    BLOB_R0008: dynamicError,
    BLOB_R0009: dynamicError,
    BLOB_R0010: dynamicError,
    BLOB_R0011: dynamicError,
    BLOB_R0012: dynamicError,
    BLOB_R0013: dynamicError,
    BLOB_R0014: dynamicError,
    BLOB_R0015: dynamicError,
    BLOB_R0017: dynamicError,
    BLOB_R0018: dynamicError,
    BLOB_R0019: dynamicError,
    BLOB_R0020: dynamicError,
    BLOB_R0021: dynamicError,
    BLOB_R0022: dynamicError,
    BLOB_R0023: dynamicError,
    BLOB_R0024: dynamicError,
    BLOB_R0025: dynamicError,
    BLOB_R0026: dynamicError,
    BLOB_R0028: dynamicError,
    BLOB_R0029: dynamicError,
    BLOB_R0030: dynamicError,
    BLOB_R0031: dynamicError,
    BLOB_R0032: dynamicError,
    BLOB_R0033: dynamicError,
    BLOB_R0034: dynamicError,
    BLOB_R0035: dynamicError,
    BLOB_R0036: dynamicError,
    BLOB_R0037: dynamicError,
    BLOB_R0038: dynamicError,
  },
})
