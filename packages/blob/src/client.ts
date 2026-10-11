// Browser upload helpers. They depend only on `fetch`, so framework bindings stay thin.
import type { BlobMultipartPart, BlobObject } from "./types.ts"

/** A `BlobObject` after JSON serialization: `uploadedAt` is an ISO string. */
export type SerializedBlobObject = Omit<BlobObject, "uploadedAt"> & { uploadedAt: string }

type HeadersInput = ConstructorParameters<typeof Headers>[0]

export interface BlobClientOptions {
  /** `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Headers for every request, such as an authorization header. */
  headers?: HeadersInput
}

export interface UploadFilesOptions extends BlobClientOptions {
  /** Form field that holds the files. Must match `handleUpload({ formKey })`. Defaults to `"files"`. */
  formKey?: string
  /** HTTP method. Defaults to `"POST"`. */
  method?: string
}

/** One file, a list of files such as a `FileList`, or an element with `files` such as an `<input type="file">`. */
export type UploadInput = File | ArrayLike<File> | { files: ArrayLike<File> | null }

export interface MultipartUploadOptions extends BlobClientOptions {
  /** Bytes per part. Defaults to 10 MiB. Vercel Blob and R2 need at least 5 MiB for every part except the last. */
  partSize?: number
  /** Parts sent at the same time. Defaults to 1. */
  concurrency?: number
  /** Called with the upload progress from 0 to 100. */
  onProgress?: (percent: number) => void
}

export interface MultipartUploadTask {
  /** Resolves with the stored object, or `undefined` when the upload was aborted. */
  completed: Promise<SerializedBlobObject | undefined>
  /** Stop sending parts and ask the server to discard the upload. */
  abort: () => Promise<void>
}

const defaultPartSize = 10 * 1024 * 1024

function toFiles(input: UploadInput): File[] {
  if (input instanceof File) return [input]
  if ("files" in input) return Array.from(input.files ?? [])
  return Array.from(input)
}

function mergeHeaders(...sources: HeadersInput[]): Headers {
  const headers = new Headers()
  for (const source of sources) new Headers(source).forEach((value, key) => headers.set(key, value))
  return headers
}

function multipartUrl(baseURL: string, action: string, pathname: string, query: Record<string, string> = {}): string {
  const path = pathname.split("/").map(encodeURIComponent).join("/")
  const search = new URLSearchParams(query).toString()
  return `${baseURL.replace(/\/+$/, "")}/${action}/${path}${search ? `?${search}` : ""}`
}

// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- The matching upload route defines each response shape at its call site.
async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const message = await response.text().catch(() => "")
    throw new Error(`Upload request failed with status ${response.status}${message ? `: ${message}` : ""}`)
  }
  // SAFETY: Callers name the JSON shape that the matching ViteHub upload handler returns.
  return await response.json() as T
}

/**
 * Send files as `multipart/form-data` to a route that returns the result of `blob.handleUpload()`.
 * Resolves with the stored objects in the order of the input files.
 */
export async function uploadFiles(apiBase: string, input: UploadInput, options: UploadFilesOptions = {}): Promise<SerializedBlobObject[]> {
  const files = toFiles(input)
  if (!files.length) return []
  const form = new FormData()
  for (const file of files) form.append(options.formKey ?? "files", file)
  const request = options.fetch ?? globalThis.fetch
  const response = await request(apiBase, { body: form, headers: mergeHeaders(options.headers), method: options.method ?? "POST" })
  return await readJson<SerializedBlobObject[]>(response)
}

/**
 * Create an uploader for a route that returns the result of `blob.handleMultipartUpload()`.
 * The route must answer `<baseURL>/<action>/<pathname>`, for example `server/api/files/multipart/[action]/[...pathname].ts`.
 */
export function createMultipartUploader(baseURL: string, options: MultipartUploadOptions = {}): (file: File, pathname?: string) => MultipartUploadTask {
  const request = options.fetch ?? globalThis.fetch
  const partSize = options.partSize ?? defaultPartSize
  if (!Number.isFinite(partSize) || partSize <= 0) throw new TypeError("partSize must be a finite positive number.")
  const concurrency = options.concurrency ?? 1
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError("concurrency must be a positive integer.")
  const send = (action: string, pathname: string, init: RequestInit, query?: Record<string, string>) =>
    request(multipartUrl(baseURL, action, pathname, query), { ...init, headers: mergeHeaders(options.headers, init.headers) })

  return (file, pathname = file.name) => {
    const controller = new AbortController()
    let upload: { pathname: string, uploadId: string } | undefined
    let aborted = false

    const completed = (async () => {
      upload = await readJson<{ pathname: string, uploadId: string }>(await send("create", pathname, {
        body: JSON.stringify({ contentType: file.type || undefined }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      }))
      const { pathname: uploadPathname, uploadId } = upload
      // Drivers accept at most 10,000 parts. Increase the requested size for very large files.
      const effectivePartSize = Math.max(partSize, Math.ceil(file.size / 10_000))
      const partCount = Math.max(1, Math.ceil(file.size / effectivePartSize))
      const parts: BlobMultipartPart[] = []
      let nextPart = 1
      options.onProgress?.(0)

      const sendParts = async () => {
        while (nextPart <= partCount && !aborted) {
          const partNumber = nextPart++
          const result = await readJson<{ part: BlobMultipartPart }>(await send("upload", uploadPathname, {
            body: file.slice((partNumber - 1) * effectivePartSize, partNumber * effectivePartSize),
            method: "PUT",
            signal: controller.signal,
          }, { partNumber: String(partNumber), uploadId }))
          parts.push(result.part)
          options.onProgress?.(Math.round((parts.length / partCount) * 100))
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, partCount) }, sendParts))
      if (aborted) return undefined

      const result = await readJson<{ object: SerializedBlobObject }>(await send("complete", uploadPathname, {
        body: JSON.stringify({ parts }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      }, { uploadId }))
      return result.object
    })().catch(async (error: unknown) => {
      if (aborted) return undefined
      aborted = true
      controller.abort()
      if (upload) {
        try {
          await readJson(await send("abort", upload.pathname, { method: "DELETE" }, { uploadId: upload.uploadId }))
        }
        catch {
          // Preserve the original upload error. Cleanup is best effort here.
        }
      }
      throw error
    })

    async function abort() {
      if (aborted) return
      aborted = true
      controller.abort()
      if (upload) await readJson(await send("abort", upload.pathname, { method: "DELETE" }, { uploadId: upload.uploadId }))
    }

    return { abort, completed }
  }
}
