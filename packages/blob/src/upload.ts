import { createError } from "h3"

import { isPlainObject } from "@vite-hub/internal/object"

import { ensureBlob } from "./ensure.ts"

import type {
  BlobMultipartEvent,
  BlobMultipartHandlerOptions,
  BlobMultipartHandlerResult,
  BlobMultipartPart,
  BlobObject,
  BlobResult,
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
  return value !== undefined && value in multipartMethods
}

// Browsers send the bare file name; drop any directory part so the client cannot pick a folder.
function uploadedFileName(file: File): string {
  return file.name.split(/[\\/]/).pop() || "file"
}

async function readForm(event: BlobUploadEvent): Promise<FormData> {
  try {
    return await event.req.formData()
  }
  catch {
    throw badRequest("Expected a multipart/form-data request body.")
  }
}

async function readJson(event: BlobUploadEvent): Promise<Record<string, unknown>> {
  const text = await event.req.text()
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

function readParts(value: unknown): BlobMultipartPart[] {
  if (!Array.isArray(value) || !value.length) throw badRequest("`parts` must be a non-empty array.")
  return value.map((part: unknown) => {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Parts come from the request body and are validated before use.
    if (!isPlainObject(part) || typeof part.etag !== "string" || !Number.isInteger(part.partNumber)) {
      throw badRequest("Each part needs a string `etag` and an integer `partNumber`.")
    }
    return { etag: part.etag, partNumber: Number(part.partNumber) }
  })
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
): Promise<BlobResult<BlobObject[]>> {
  const formKey = options.formKey ?? "files"
  const form = await readForm(event)
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
  return [null, objects]
}

/**
 * Serve one multipart client request. The route must provide `action` and `pathname` params,
 * for example `server/api/files/multipart/[action]/[...pathname].ts`.
 */
export async function handleBlobMultipartUpload(
  storage: MultipartStorage,
  event: BlobMultipartEvent,
  options: BlobMultipartHandlerOptions = {},
): Promise<BlobResult<BlobMultipartHandlerResult>> {
  const { action, pathname } = event.context.params ?? {}
  if (!isMultipartAction(action)) {
    throw badRequest(`Unknown multipart action "${action ?? ""}". Expected create, upload, complete, or abort.`)
  }
  if (!pathname) throw badRequest("Missing `pathname` route param.")
  if (event.req.method !== multipartMethods[action]) {
    throw createError({ statusCode: 405, message: `The ${action} action requires ${multipartMethods[action]}.` })
  }

  if (action === "create") {
    const body = await readJson(event)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The content type comes from the request body.
    const contentType = typeof body.contentType === "string" ? body.contentType : undefined
    const [error, upload] = await storage.createMultipartUpload(pathname, {
      ...options.create,
      contentType: options.create?.contentType ?? contentType,
    })
    if (error) return [error, undefined]
    return [null, { action, pathname: upload.pathname, uploadId: upload.uploadId }]
  }

  const url = new URL(event.req.url)
  const uploadId = requireQuery(url, "uploadId")
  const [resumeError, upload] = await storage.resumeMultipartUpload(pathname, uploadId)
  if (resumeError) return [resumeError, undefined]

  if (action === "upload") {
    const partNumber = Number(requireQuery(url, "partNumber"))
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw badRequest("`partNumber` must be an integer from 1 to 10000.")
    // Read the part into memory: R2 rejects streams without a known length.
    const [error, part] = await upload.uploadPart(partNumber, await event.req.arrayBuffer())
    return error ? [error, undefined] : [null, { action, part }]
  }
  if (action === "complete") {
    const [error, object] = await upload.complete(readParts((await readJson(event)).parts))
    return error ? [error, undefined] : [null, { action, object }]
  }
  const [error] = await upload.abort()
  return error ? [error, undefined] : [null, { action }]
}
