import {
  assertMethod,
  createError,
  readFormData,
} from "h3"
import { posix as pathPosix } from "node:path"
import { randomUUID } from "node:crypto"
import { ensureBlob } from "./ensure.ts"
import { getContentType } from "./utils.ts"
import type { BlobDriver } from "./drivers/types.ts"
import type {
  BlobBody,
  BlobListOptions,
  BlobObject,
  BlobPutOptions,
  BlobStorage,
  BlobUploadOptions,
} from "./types.ts"
import type { H3Event } from "h3"

function readHeaderValue(event: H3Event, name: string): string | undefined {
  const requestWithNode = event as H3Event & {
    node?: { req?: { headers?: Record<string, string | string[] | undefined> } }
    req?: { headers?: Headers }
  }
  const fromWeb = requestWithNode.req?.headers?.get?.(name)
  if (fromWeb) return fromWeb

  const fromNode = requestWithNode.node?.req?.headers?.[name.toLowerCase()]
  return Array.isArray(fromNode) ? fromNode[0] : fromNode
}

async function readNodeBody(event: H3Event): Promise<Uint8Array | undefined> {
  const requestWithNode = event as H3Event & {
    node?: {
      req?: AsyncIterable<Buffer | Uint8Array | string> & {
        body?: ArrayBuffer | ArrayBufferView | string | null
      }
    }
  }
  const req = requestWithNode.node?.req
  const body = req?.body
  if (body) {
    if (typeof body === "string") return new TextEncoder().encode(body)
    if (body instanceof ArrayBuffer) return new Uint8Array(body)
    if (ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    }
  }

  if (typeof req?.[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = []
    for await (const chunk of req) {
      if (typeof chunk === "string") chunks.push(new TextEncoder().encode(chunk))
      else chunks.push(chunk instanceof Buffer ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : chunk)
    }
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, start: number): number {
  outer: for (let i = start; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function parseMultipartBody(body: Uint8Array, contentType: string): FormData | undefined {
  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1]
  if (!boundary) return

  const form = new FormData()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const firstDelimiter = encoder.encode(`--${boundary}`)
  const partDelimiter = encoder.encode(`\r\n--${boundary}`)
  const headerSeparator = encoder.encode("\r\n\r\n")

  let cursor = indexOfBytes(body, firstDelimiter, 0)
  if (cursor === -1) return
  cursor += firstDelimiter.length

  while (cursor < body.length) {
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2

    const headerEnd = indexOfBytes(body, headerSeparator, cursor)
    if (headerEnd === -1) break

    const rawHeaders = decoder.decode(body.subarray(cursor, headerEnd))
    const valueStart = headerEnd + headerSeparator.length
    let nextBoundary = indexOfBytes(body, partDelimiter, valueStart)
    while (nextBoundary !== -1) {
      const after = nextBoundary + partDelimiter.length
      const first = body[after]
      const second = body[after + 1]
      if ((first === 0x0d && second === 0x0a) || (first === 0x2d && second === 0x2d)) break
      nextBoundary = indexOfBytes(body, partDelimiter, after)
    }
    if (nextBoundary === -1) break

    const value = body.subarray(valueStart, nextBoundary)
    const headers = Object.fromEntries(rawHeaders.split("\r\n").map((line) => {
      const index = line.indexOf(":")
      return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()]
    }))
    const disposition = headers["content-disposition"] || ""
    const name = disposition.match(/name="([^"]+)"/)?.[1]

    if (name) {
      const filename = disposition.match(/filename="([^"]*)"/)?.[1]
      if (filename) {
        form.append(name, new File([new Uint8Array(value)], filename, { type: headers["content-type"] }))
      }
      else {
        form.append(name, decoder.decode(value))
      }
    }

    cursor = nextBoundary + partDelimiter.length
  }

  return form
}

async function readUploadFormData(event: H3Event): Promise<FormData> {
  try {
    return await readFormData(event)
  }
  catch (error) {
    const contentType = readHeaderValue(event, "content-type")
    const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase()
    const rawBody = mediaType === "multipart/form-data" ? await readNodeBody(event) : undefined
    const form = contentType && rawBody ? parseMultipartBody(rawBody, contentType) : undefined
    if (form) return form
    throw error
  }
}

function normalizePathname(pathname: string): string {
  return pathname.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "")
}

function safeDecode(pathname: string): string {
  try { return decodeURIComponent(pathname) }
  catch { return pathname }
}

function resolvePutPathname(pathname: string, options: Pick<BlobPutOptions, "addRandomSuffix" | "prefix">): string {
  const decoded = safeDecode(pathname)
  const parsed = pathPosix.parse(decoded)
  const dir = parsed.dir === "." ? "" : parsed.dir
  const filename = options.addRandomSuffix
    ? `${parsed.name}-${randomUUID().split("-")[0]}${parsed.ext}`
    : `${parsed.name}${parsed.ext}`
  const resolved = pathPosix.join(dir, filename)
  const final = normalizePathname(options.prefix ? pathPosix.join(options.prefix, resolved) : resolved)

  if (options.prefix) {
    const prefix = normalizePathname(options.prefix)
    if (prefix && final !== prefix && !final.startsWith(`${prefix}/`)) {
      throw createError({ message: "Upload pathname escapes configured prefix", statusCode: 400 })
    }
  }

  return final
}

export function createBlobStorage(driver: BlobDriver<unknown>): BlobStorage {
  const blob = {
    driver,
    async list(options?: BlobListOptions) {
      return driver.list({
        limit: 1000,
        ...options,
      })
    },
    async serve(_event: H3Event, pathname: string) {
      const decoded = safeDecode(pathname)
      const arrayBuffer = await driver.getArrayBuffer(decoded)
      if (!arrayBuffer) throw createError({ message: "File not found", statusCode: 404 })

      const metadata = await driver.head(decoded)
      const contentType = metadata?.contentType || getContentType(decoded)
      const headers = new Headers({
        "Content-Length": String(arrayBuffer.byteLength),
        "Content-Type": contentType,
      })
      if (metadata?.httpEtag) headers.set("etag", metadata.httpEtag)

      return new Response(arrayBuffer, { headers })
    },
    async get(pathname: string) {
      return driver.get(safeDecode(pathname))
    },
    async put(pathname: string, body: BlobBody, options: BlobPutOptions = {}) {
      const contentType = options.contentType || (body instanceof Blob ? body.type : undefined) || getContentType(pathname)
      const resolvedPathname = resolvePutPathname(pathname, options)

      return driver.put(resolvedPathname, body, {
        access: options.access,
        contentLength: options.contentLength,
        contentType,
        customMetadata: options.customMetadata,
      })
    },
    async head(pathname: string) {
      const metadata = await driver.head(safeDecode(pathname))
      if (!metadata) throw createError({ message: "Blob not found", statusCode: 404 })
      return metadata
    },
    async del(pathnames: string | string[]) {
      const paths = Array.isArray(pathnames) ? pathnames : [pathnames]
      await driver.delete(paths.map(safeDecode))
    },
    async handleUpload(event: H3Event, options: BlobUploadOptions = {}) {
      assertMethod(event, ["POST", "PUT", "PATCH"])

      const resolvedOptions = {
        formKey: "files",
        multiple: true,
        ...options,
      }
      const form = await readUploadFormData(event)
      const entries = form.getAll(resolvedOptions.formKey)
      if (entries.some(entry => !(entry instanceof File))) {
        throw createError({ message: `Form field "${resolvedOptions.formKey}" must contain files`, statusCode: 400 })
      }
      const files = entries as File[]

      if (!files.length) throw createError({ message: "Missing files", statusCode: 400 })
      if (!resolvedOptions.multiple && files.length > 1) {
        throw createError({ message: "Multiple files are not allowed", statusCode: 400 })
      }

      const objects: BlobObject[] = []
      try {
        if (resolvedOptions.ensure) {
          for (const file of files) ensureBlob(file, resolvedOptions.ensure)
        }

        for (const file of files) objects.push(await blob.put(file.name, file, resolvedOptions.put))
      }
      catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error"
        const statusCode = (error as { statusCode?: number } | null)?.statusCode
        throw createError({
          message: `Storage error: ${message}`,
          statusCode: typeof statusCode === "number" ? statusCode : 500,
        })
      }

      return objects
    },
  } satisfies BlobStorage

  return blob
}
