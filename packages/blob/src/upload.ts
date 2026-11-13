import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { createError } from "h3"

import { isPlainObject } from "@vite-hub/internal/object"

import { ensureBlob } from "./ensure.ts"
import { getBlobRequestBodyLimit } from "./internal/host-limits.ts"

import type { Result } from "@vite-hub/runtime"

import type {
  BlobErrorCode,
  BlobMultipartEvent,
  BlobMultipartHandlerOptions,
  BlobMultipartHandlerResult,
  BlobMultipartPart,
  BlobObject,
  BlobStorage,
  BlobUploadEvent,
  BlobUploadOptions,
} from "./types.ts"

type UploadStorage = Pick<BlobStorage, "put">
type MultipartStorage = Pick<BlobStorage, "createMultipartUpload" | "resumeMultipartUpload">

const multipartMethods = {
  abort: "DELETE",
  complete: "POST",
  create: "POST",
  upload: "PUT",
} as const

type MultipartAction = keyof typeof multipartMethods

function badRequest(message: string): Error {
  return createError({ statusCode: 400, message })
}

function isMultipartAction(value: string | undefined): value is MultipartAction {
  return value !== undefined && Object.hasOwn(multipartMethods, value)
}

// Browsers send the bare file name; drop any directory part so the client cannot pick a folder.
// Rename unsupported `%XX` names with a UUID to avoid overwriting their replacement name.
// put() decodes pathnames once, so encode the name.
function uploadedFileName(file: File): string {
  const name = file.name.split(/[\\/]/).pop() || "file"
  const safeName = name.replace(/%(?=[\da-f]{2})/gi, "_")
  if (safeName === name) return encodeURIComponent(name)
  const extension = safeName.lastIndexOf(".")
  const split = extension > 0 ? extension : safeName.length
  return encodeURIComponent(`${safeName.slice(0, split)}-${globalThis.crypto.randomUUID()}${safeName.slice(split)}`)
}

function payloadTooLarge(bytes: number, limit: number): Error {
  return createError({
    statusCode: 413,
    statusMessage: "FUNCTION_PAYLOAD_TOO_LARGE",
    message: `The request body is ${bytes} bytes. A Vercel Function accepts at most ${limit} bytes, and Vercel answers 413 FUNCTION_PAYLOAD_TOO_LARGE. Keep each upload under the limit, for example with \`ensure.maxSize\`.`,
  })
}

/** Reads the request body, and rejects it as Vercel does when it is above the request body limit of the dev server. */
async function readBody(request: Request): Promise<Request> {
  const limit = getBlobRequestBodyLimit()
  if (limit === undefined) return request
  const declared = Number(request.headers.get("content-length"))
  if (declared > limit) throw payloadTooLarge(declared, limit)
  const body = await request.arrayBuffer()
  if (body.byteLength > limit) throw payloadTooLarge(body.byteLength, limit)
  return new Request(request.url, { body, headers: request.headers, method: request.method })
}

async function readForm(input: Request): Promise<FormData> {
  const request = await readBody(input)
  try {
    return await request.formData()
  }
  catch {
    throw badRequest("Expected a multipart/form-data request body.")
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (!text) return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    throw badRequest("Expected a JSON object request body.")
  }
  if (!isPlainObject(value)) throw badRequest("Expected a JSON object request body.")
  return value
}

export function validateMultipartParts(parts: BlobMultipartPart[]): void {
  if (!parts.length) throw badRequest("`parts` must be a non-empty array.")
  const partNumbers = new Set<number>()
  for (const part of parts) {
    if (typeof part.etag !== "string" || !Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > 10_000) {
      throw badRequest("Each part needs a string `etag` and an integer `partNumber`.")
    }
    if (partNumbers.has(part.partNumber)) throw badRequest(`Multipart part number ${part.partNumber} was provided more than once.`)
    partNumbers.add(part.partNumber)
  }
}

function readParts(value: unknown): BlobMultipartPart[] {
  if (!Array.isArray(value) || !value.length) throw badRequest("`parts` must be a non-empty array.")
  const parts = value.map((part: unknown) => {
    if (!isPlainObject(part) || typeof part.etag !== "string" || typeof part.partNumber !== "number" || !Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > 10_000) {
      throw badRequest("Each part needs a string `etag` and an integer `partNumber`.")
    }
    return { etag: part.etag, partNumber: part.partNumber as number }
  })
  validateMultipartParts(parts)
  return parts
}

function requireQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)
  if (!value) throw badRequest(`Missing \`${name}\` query parameter.`)
  return value
}

/** Store the files of a `multipart/form-data` request with `put()`. Request errors throw H3 400 errors. */
export async function handleBlobUpload(
  storage: UploadStorage,
  event: BlobUploadEvent,
  options: BlobUploadOptions = {},
): Promise<Result<BlobObject[], BlobErrorCode>> {
  const formKey = options.formKey ?? "files"
  const form = await readForm(getStandardContext(event).req)
  const files = form.getAll(formKey).filter((value): value is File => value instanceof File)
  if (!files.length) throw badRequest(`No files in form field "${formKey}".`)
  if (options.multiple === false && files.length > 1) throw badRequest(`Form field "${formKey}" accepts one file.`)
  if (options.ensure) {
    for (const file of files) ensureBlob(file, options.ensure)
  }

  const objects: BlobObject[] = []
  for (const file of files) {
    const [error, object] = await storage.put(uploadedFileName(file), file, options.put)
    if (error) return [error, undefined]
    objects.push(object)
  }
  return [undefined, objects]
}

/**
 * Serve one multipart client request. The route must provide `action` and `pathname` params,
 * for example `server/api/files/multipart/[action]/[...pathname].ts`.
 */
export async function handleBlobMultipartUpload(
  storage: MultipartStorage,
  event: BlobMultipartEvent,
  options: BlobMultipartHandlerOptions = {},
): Promise<Result<BlobMultipartHandlerResult, BlobErrorCode>> {
  const { action, pathname } = event.context.params ?? {}
  if (!isMultipartAction(action)) {
    throw badRequest(`Unknown multipart action "${action ?? ""}". Expected create, upload, complete, or abort.`)
  }
  if (!pathname) throw badRequest("Missing `pathname` route param.")
  const request = getStandardContext(event).req
  if (request.method !== multipartMethods[action]) {
    throw createError({ statusCode: 405, message: `The ${action} action requires ${multipartMethods[action]}.` })
  }

  if (action === "create") {
    const body = await readJson(request)
    const contentType = typeof body.contentType === "string" ? body.contentType : undefined
    const [error, upload] = await storage.createMultipartUpload(pathname, {
      ...options.create,
      contentType: options.create?.contentType ?? contentType,
    })
    if (error) return [error, undefined]
    return [undefined, { action, pathname: upload.pathname, uploadId: upload.uploadId }]
  }

  const url = new URL(request.url)
  const uploadId = requireQuery(url, "uploadId")
  // Read the part into memory before the upload resumes: R2 rejects streams without a known length, and Vercel
  // rejects a large part before the Function runs.
  const partBody = action === "upload" ? await (await readBody(request)).arrayBuffer() : new ArrayBuffer(0)
  let completionParts: BlobMultipartPart[] | undefined
  let completionBody: Record<string, unknown> | undefined
  if (action === "complete") {
    completionBody = await readJson(request)
    if (Object.hasOwn(completionBody, "parts")) completionParts = readParts(completionBody.parts)
  }
  const [resumeError, upload] = await storage.resumeMultipartUpload(pathname, uploadId)
  if (resumeError) return [resumeError, undefined]

  if (action === "upload") {
    const partNumber = Number(requireQuery(url, "partNumber"))
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw badRequest("`partNumber` must be an integer from 1 to 10000.")
    const [error, part] = await upload.uploadPart(partNumber, partBody)
    return error ? [error, undefined] : [undefined, { action, part }]
  }
  if (action === "complete") {
    const [error, object] = await upload.complete(completionParts ?? readParts(completionBody?.parts))
    return error ? [error, undefined] : [undefined, { action, object }]
  }
  const [error] = await upload.abort()
  return error ? [error, undefined] : [undefined, { action }]
}
