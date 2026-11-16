import { defineDiagnostics } from "nostics"

// Errors of the browser-safe modules: `@vite-hub/blob/client`, reference schemas, and the media helpers.
// Their own catalog keeps the server catalog out of browser bundles.
export const blobBrowserDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/blob/diagnostics",
  codes: {
    BLOB_IMAGE_VARIANT_INVALID: {
      why: ({ expected, parameter }: { expected: string, parameter: string }) => `Image variant \`${parameter}\` must be ${expected}.`,
      fix: "Change the query of the image URL: `w` and `h` from 1 to 10000, `q` from 1 to 100, `fit` as `cover` or `inside`, `fmt` as `webp`, `jpeg`, `png`, or `avif`, and `crop` as a crop name. `imageVariantUrl()` writes a valid query.",
    },
    BLOB_REFERENCE_OPTION_INVALID: {
      why: ({ kind, option, value }: { kind: string, option: "accept" | "maxSize" | "store", value: string }) => option === "accept"
        ? `[vitehub] ${kind}() accept entry "${value}" is not a MIME type or pattern such as "image/png" or "image/*".`
        : option === "maxSize"
          ? `[vitehub] ${kind}() maxSize "${value}" is not a size such as "512KB" or "8MB".`
          : `[vitehub] ${kind}() store must be a non-empty Blob Store name.`,
      fix: "Pass `accept` as MIME types or patterns such as `\"image/png\"` or `\"image/*\"`, `maxSize` as a size such as `\"8MB\"`, and `store` as a non-empty Blob Store name to `image()` or `file()`.",
    },
    BLOB_REFERENCE_SCHEMA_TARGET_UNSUPPORTED: {
      why: ({ target }: { target: string }) => `[vitehub] Blob reference schemas emit draft-07, draft-2020-12, or openapi-3.0 JSON Schema, not "${target}".`,
      fix: "Pass `target: \"draft-07\"`, `\"draft-2020-12\"`, or `\"openapi-3.0\"` to `[\"~standard\"].jsonSchema.input()` or `.output()` of the `image()` or `file()` schema.",
    },
    BLOB_RESPONSIVE_IMAGE_URL_MISSING: {
      why: "[vitehub] responsiveImage() needs the served URL of the image. Read the record from the served Blob Store or pass `url`.",
      fix: "Pass `url` to `responsiveImage()`, or pass a media record from the Blob Store that `blob.serve` serves, because that record has a `url`.",
    },
    BLOB_UPLOAD_OPTION_INVALID: {
      why: ({ option }: { option: "concurrency" | "partSize" }) => option === "partSize" ? "partSize must be a finite positive number." : "concurrency must be a positive integer.",
      fix: "Pass `partSize` as a positive number of bytes and `concurrency` as a positive integer to `createMultipartUploader()`, or omit them.",
    },
    BLOB_UPLOAD_REQUEST_FAILED: {
      why: ({ body, status }: { body: string, status: number }) => `Upload request failed with status ${status}${body ? `: ${body}` : ""}`,
      fix: "Read the status and the server text in the message. Check the upload route and its limits, such as `accept` and `maxSize` in `blob.handleUpload()`, then retry.",
    },
    BLOB_UPLOAD_RESPONSE_INVALID: {
      why: ({ partMismatch }: { partMismatch?: boolean }) => partMismatch
        ? "Upload request returned a part number that does not match the requested part."
        : "Upload request returned malformed JSON.",
      fix: "Return the result of `blob.handleUpload()` or `blob.handleMultipartUpload()` from the upload route without changes, and point `uploadFiles()` or `createMultipartUploader()` at that route.",
    },
  },
})
