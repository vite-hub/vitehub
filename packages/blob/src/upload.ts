import { createError } from "h3"

import { isPlainObject } from "@vite-hub/internal/object"

import { ensureBlob, ensureBlobSize, ensureBlobType, ensureMaxBytes } from "./ensure.ts"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"
import { eventRequest } from "./internal/event-request.ts"
import { getBlobRequestBodyLimit } from "./internal/host-limits.ts"
import { decodePathname, normalizeBlobPath } from "./internal/pathname.ts"
import { openUploadTicket, sealUploadTicket } from "./internal/upload-ticket.ts"

import type { Result } from "@vite-hub/runtime"

import type {
  BlobBeforeUploadFile,
  BlobDirectUploadStep,
  BlobErrorCode,
  BlobMultipartEvent,
  BlobMultipartHandlerOptions,
  BlobMultipartHandlerResult,
  BlobMultipartPart,
  BlobObject,
  BlobSignedRequest,
  BlobSize,
  BlobStorage,
  BlobUploadEvent,
  BlobUploadOptions,
} from "./types.ts"

type UploadStorage = Pick<BlobStorage, "delete" | "head" | "put" | "sign">
type MultipartStorage = Pick<BlobStorage, "createMultipartUpload" | "delete" | "head" | "resumeMultipartUpload">

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
function uploadedFileName(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() || "file"
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

// Room for the boundaries and part headers of a one-file `multipart/form-data` body.
const formFramingBytes = 64 * 1024

function declaredLength(request: Request): number | undefined {
  const value = request.headers.get("content-length")
  if (value === null || !/^\d+$/.test(value.trim())) return undefined
  return Number(value)
}

/** Rejects a request whose declared body is above `limit`, before anything reads it. */
function rejectDeclaredLength(request: Request, limit: number | undefined): void {
  const declared = declaredLength(request)
  if (limit === undefined || declared === undefined || declared <= limit) return
  throw createError({
    statusCode: 413,
    message: `The request body is ${declared} bytes, which is more than the ${limit} bytes that \`ensure.maxSize\` allows.`,
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

// A signed PUT must start within this time. Large files on slow links take longer to send, so the ticket for
// `complete` lives longer.
const directSignExpiresIn = 10 * 60
const directTicketExpiresIn = 24 * 60 * 60

function isJsonRequest(request: Request): boolean {
  return /^application\/(?:[\w.+-]+\+)?json\b/i.test(request.headers.get("content-type") ?? "")
}

async function beforeUpload(options: BlobUploadOptions, file: BlobBeforeUploadFile, fallback: string): Promise<string> {
  const result = await options.onBeforeUpload?.(file)
  return result?.pathname ?? fallback
}

/**
 * Store the files of a `multipart/form-data` request with `put()`. With `direct: true`, also answer the JSON `sign`
 * and `complete` steps of a direct upload. Request errors throw H3 400 errors.
 */
export async function handleBlobUpload(
  storage: UploadStorage,
  event: BlobUploadEvent,
  options: BlobUploadOptions = {},
  store = "default",
): Promise<Result<BlobObject[] | BlobDirectUploadStep, BlobErrorCode>> {
  const request = eventRequest(event)
  if (isJsonRequest(request)) {
    if (!options.direct) {
      throw badRequest("This upload route accepts a multipart/form-data request. Pass `direct: true` to `blob.handleUpload()` to accept direct uploads.")
    }
    return handleDirectUploadStep(storage, request, options, store)
  }
  const formKey = options.formKey ?? "files"
  // With one file, the body is the file plus its framing. Without a file count, the total has no bound.
  if (options.ensure && options.multiple === false) {
    const maxBytes = ensureMaxBytes(options.ensure)
    rejectDeclaredLength(request, maxBytes === undefined ? undefined : maxBytes + formFramingBytes)
  }
  const form = await readForm(request)
  const files = form.getAll(formKey).filter((value): value is File => value instanceof File)
  if (!files.length) throw badRequest(`No files in form field "${formKey}".`)
  if (options.multiple === false && files.length > 1) throw badRequest(`Form field "${formKey}" accepts one file.`)
  if (options.ensure) {
    for (const file of files) ensureBlob(file, options.ensure)
  }
  // Run every hook before the first put(), so a rejected file stores nothing.
  const pathnames: string[] = []
  for (const file of files) {
    const name = uploadedFileName(file.name)
    pathnames.push(options.onBeforeUpload
      ? await beforeUpload(options, { contentType: file.type, pathname: decodePathname(name), request, size: file.size }, name)
      : name)
  }

  const objects: BlobObject[] = []
  for (const [index, file] of files.entries()) {
    const [error, object] = await storage.put(pathnames[index]!, file, options.put)
    if (error) return [error, undefined]
    await options.onCompleted?.(object, request)
    objects.push(object)
  }
  return [undefined, objects]
}

/** `handleUpload()` with its overloads. `storage` returns the handle, so a handle can pass itself while it is built. */
export function createUploadHandler(storage: () => UploadStorage, store: string): BlobStorage["handleUpload"] {
  function handleUpload(event: BlobUploadEvent, options?: BlobUploadOptions & { direct?: false }): Promise<Result<BlobObject[], BlobErrorCode>>
  function handleUpload(event: BlobUploadEvent, options: BlobUploadOptions & { direct: true }): Promise<Result<BlobObject[] | BlobDirectUploadStep, BlobErrorCode>>
  function handleUpload(event: BlobUploadEvent, options: BlobUploadOptions): Promise<Result<BlobObject[] | BlobDirectUploadStep, BlobErrorCode>>
  function handleUpload(event: BlobUploadEvent, options: BlobUploadOptions = {}): Promise<Result<BlobObject[] | BlobDirectUploadStep, BlobErrorCode>> {
    return handleBlobUpload(storage(), event, options, store)
  }
  return handleUpload
}

async function handleDirectUploadStep(
  storage: UploadStorage,
  request: Request,
  options: BlobUploadOptions,
  store: string,
): Promise<Result<BlobObject[] | BlobDirectUploadStep, BlobErrorCode>> {
  const body = await readJson(request)
  if (body.action === "sign") return signDirectUpload(storage, request, body, options, store)
  if (body.action === "complete") return completeDirectUpload(storage, request, body, options, store)
  throw badRequest("A direct upload request needs `action`: \"sign\" or \"complete\".")
}

async function signDirectUpload(
  storage: UploadStorage,
  request: Request,
  body: Record<string, unknown>,
  options: BlobUploadOptions,
  store: string,
): Promise<Result<BlobDirectUploadStep, BlobErrorCode>> {
  const { contentType: declaredType, name, size } = body
  if (typeof name !== "string" || typeof declaredType !== "string" || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw badRequest("The `sign` step needs the file `name`, its `contentType`, and its `size` in bytes.")
  }
  const { access, contentLength, customMetadata, ...put } = options.put ?? {}
  if (access !== undefined || contentLength !== undefined || (customMetadata && Object.keys(customMetadata).length)) {
    throw blobErrorDiagnostics.BLOB_R0046({ message: "A direct upload cannot set `put.access`, `put.contentLength`, or `put.customMetadata`." })
  }
  if (options.ensure) {
    ensureBlobType(declaredType, options.ensure)
    ensureBlobSize(size, options.ensure)
  }
  const fileName = decodePathname(uploadedFileName(name))
  const chosen = await beforeUpload(options, { contentType: declaredType, pathname: fileName, request, size }, fileName)
  const pathname = normalizeBlobPath(decodePathname(chosen), put)
  const contentType = put.contentType || declaredType || "application/octet-stream"

  const signed = await signDirectPut(storage, pathname, contentType, options.ensure?.maxSize)
  if (!signed) return [undefined, { action: "form" }]
  const [signError, signedRequest] = signed
  if (signError) return [signError, undefined]
  const ticket = await sealUploadTicket({
    contentType,
    expires: Math.floor(Date.now() / 1000) + directTicketExpiresIn,
    pathname,
    route: new URL(request.url).pathname,
    store,
  })
  return [undefined, { action: "sign", pathname, request: signedRequest, ticket }]
}

// `BLOB_R0025`: the driver cannot sign this request.
function cannotSign(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "BLOB_R0025"
}

/**
 * Signs the PUT of a direct upload. Binds `maxSize` when the driver can, and signs without it when the driver cannot:
 * `complete` checks the size anyway. Returns `undefined` when the store cannot sign an upload, such as Netlify Blobs.
 */
async function signDirectPut(
  storage: UploadStorage,
  pathname: string,
  contentType: string,
  maxSize: BlobSize | undefined,
): Promise<Result<BlobSignedRequest, BlobErrorCode> | undefined> {
  const sign = (bindSize: boolean) => storage.sign(pathname, {
    contentType,
    expiresIn: directSignExpiresIn,
    method: "PUT",
    ...(bindSize && maxSize ? { maxSize } : {}),
  })
  try {
    let result = await sign(true)
    if (maxSize && result[0] && cannotSign(result[0].cause)) result = await sign(false)
    return result[0] && cannotSign(result[0].cause) ? undefined : result
  }
  catch (error) {
    // The driver has no `sign()` at all.
    if (cannotSign(error)) return undefined
    throw error
  }
}

async function completeDirectUpload(
  storage: UploadStorage,
  request: Request,
  body: Record<string, unknown>,
  options: BlobUploadOptions,
  store: string,
): Promise<Result<BlobObject[], BlobErrorCode>> {
  const ticket = typeof body.ticket === "string" ? await openUploadTicket(body.ticket) : undefined
  if (ticket === "expired") throw createError({ statusCode: 403, message: "The direct upload ticket expired. Start the upload again with a new `sign` step." })
  if (!ticket || ticket.store !== store || ticket.route !== new URL(request.url).pathname) {
    throw createError({ statusCode: 403, message: "The `complete` step needs the `ticket` that the `sign` step of this route returned, unchanged." })
  }
  const [headError, object] = await storage.head(ticket.pathname)
  if (headError) return [headError, undefined]
  if (!object) {
    throw badRequest(`The file "${ticket.pathname}" is not in the store. Send the signed PUT request before the \`complete\` step.`)
  }
  // The client sent the bytes straight to storage, so check what the store holds, not what the client declared.
  if (options.ensure) {
    try {
      ensureBlobType(object.contentType ?? "", options.ensure)
      if (object.size !== undefined) ensureBlobSize(object.size, options.ensure)
    }
    catch (error) {
      const [deleteError] = await storage.delete(ticket.pathname)
      if (deleteError) return [deleteError, undefined]
      throw error
    }
  }
  await options.onCompleted?.(object, request)
  return [undefined, [object]]
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
  const request = eventRequest(event)
  if (request.method !== multipartMethods[action]) {
    throw createError({ statusCode: 405, message: `The ${action} action requires ${multipartMethods[action]}.` })
  }
  const ensure = options.ensure
  const maxBytes = ensure ? ensureMaxBytes(ensure) : undefined

  if (action === "create") {
    const body = await readJson(request)
    const contentType = options.create?.contentType ?? (typeof body.contentType === "string" ? body.contentType : undefined)
    if (ensure) {
      ensureBlobType(contentType ?? "", ensure)
      // The client declares the size so a large file fails before its parts are sent. upload and complete enforce it.
      if (typeof body.size === "number") ensureBlobSize(body.size, ensure)
    }
    const [error, upload] = await storage.createMultipartUpload(pathname, { ...options.create, contentType })
    if (error) return [error, undefined]
    return [undefined, { action, pathname: upload.pathname, uploadId: upload.uploadId }]
  }

  const url = new URL(request.url)
  const uploadId = requireQuery(url, "uploadId")
  // Read the part into memory before the upload resumes: R2 rejects streams without a known length, and Vercel
  // rejects a large part before the Function runs.
  if (action === "upload") rejectDeclaredLength(request, maxBytes)
  const partBody = action === "upload" ? await (await readBody(request)).arrayBuffer() : new ArrayBuffer(0)
  if (ensure) ensureBlobSize(partBody.byteLength, ensure)
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
    if (error) return [error, undefined]
    // Validate provider metadata: serialized upload state can be edited by the client.
    if (ensure) {
      let stored = object
      if ((maxBytes !== undefined && stored.size === undefined) || (ensure.types?.length && !stored.contentType)) {
        const [headError, metadata] = await storage.head(object.pathname)
        if (headError) return [headError, undefined]
        if (metadata) stored = metadata
      }
      try {
        ensureBlobType(stored.contentType ?? "", ensure)
        if (stored.size !== undefined) ensureBlobSize(stored.size, ensure)
      }
      catch (error) {
        const [deleteError] = await storage.delete(object.pathname)
        if (deleteError) return [deleteError, undefined]
        throw error
      }
    }
    return [undefined, { action, object }]
  }
  const [error] = await upload.abort()
  return error ? [error, undefined] : [undefined, { action }]
}
