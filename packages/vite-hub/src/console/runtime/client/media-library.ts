import { callOperationRpc, operationRpcPath } from "@vite-hub/internal/operation-rpc"

import { ConsoleRequestError, requestConsole } from "./request"
import { projectRequest, resolveProjectUrl } from "./project"
import { consoleRpcHeader } from "../rpc"

// These types mirror the media library contract in `server/media.ts`.

export interface ConsoleMediaFocal {
  x: number
  y: number
}

export interface ConsoleMediaCropReplacement {
  contentType: string
  hash: string
  height?: number
  pathname: string
  size: number
  width?: number
}

export interface ConsoleMediaCrop {
  /** Width to height, such as `4:5`. */
  aspect: string
  focal?: ConsoleMediaFocal
  replacement?: ConsoleMediaCropReplacement
}

/** One file of the media library. */
export interface ConsoleMediaFile {
  alt?: string
  caption?: string
  color?: string
  contentType: string
  createdAt: string
  crops?: Record<string, ConsoleMediaCrop>
  focal?: ConsoleMediaFocal
  height?: number
  name: string
  pathname: string
  size: number
  updatedAt: string
  /** The served URL, when `blob.serve` serves the store. */
  url?: string
  width?: number
}

export interface ConsoleMediaAccess {
  /** Move, rename, and delete. */
  manage: boolean
  read: boolean
  /** Upload, create folders, and edit details. */
  write: boolean
}

export interface ConsoleMediaInfo {
  access: ConsoleMediaAccess
  /** The URL a pathname is appended to, such as `/api/_vitehub/blob/`, or null when the store is not served. */
  served: string | null
  store: string
}

export interface ConsoleMediaListing {
  access: ConsoleMediaAccess
  cursor?: string
  folder: string
  folders: string[]
  hasMore: boolean
  items: ConsoleMediaFile[]
  served: string | null
  store: string
  truncated?: boolean
}

export type ConsoleMediaType = "audio" | "document" | "image" | "other" | "video"

/** Every media type, for the type filter. */
export const consoleMediaTypes: readonly ConsoleMediaType[] = ["image", "video", "audio", "document", "other"]

export interface ConsoleMediaListQuery {
  cursor?: string
  folder?: string
  search?: string
  type?: ConsoleMediaType
}

/** A document that uses a file. */
export interface ConsoleMediaReferenceDocument {
  collection: string
  id: string
  refs: Array<"draft" | "published">
  title: string
}

export interface ConsoleMediaBulkResult<T> {
  failed: Array<{ message: string, pathname: string }>
  value: T
}

export interface ConsoleMediaUploadResult {
  duplicate: boolean
  file: ConsoleMediaFile
}

export interface ConsoleMediaUploadOptions {
  /** Upload the replacement image of this crop of `pathname` instead of a new file. */
  crop?: { name: string, pathname: string }
  /** Asked when the pathname exists. Without it, an upload never replaces a file. */
  confirmReplace?: (pathname: string) => boolean | Promise<boolean>
  folder?: string
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** The media library actions of one document editor section, called through the Console RPC transport. */
export interface ConsoleMediaClient {
  /** Supported mutations, in addition to the user's access. Omitted for a full Content media library. */
  capabilities?: { folders: boolean, move: boolean }
  createFolder(parent: string, name: string): Promise<{ path: string }>
  /** Paths that the library shows but never changes, such as the files that ViteHub keeps for itself. */
  isProtected?(pathname: string): boolean
  get(pathname: string): Promise<ConsoleMediaFile>
  /** The access of the signed-in user and the served URL of the store. */
  info(): Promise<ConsoleMediaInfo>
  list(query?: ConsoleMediaListQuery, signal?: AbortSignal): Promise<ConsoleMediaListing>
  /** Moves files. `to` is the new pathname, so a move into the same folder renames. */
  move(moves: ReadonlyArray<{ from: string, to: string }>): Promise<{ failed: Array<{ message: string, pathname: string }>, moved: ConsoleMediaFile[] }>
  moveFolder(from: string, to: string): Promise<{ moved: number, path: string }>
  remove(pathnames: readonly string[]): Promise<{ failed: Array<{ message: string, pathname: string }>, removed: string[] }>
  removeCropReplacement(pathname: string, crop: string): Promise<ConsoleMediaFile>
  removeFolder(path: string, force?: boolean): Promise<{ removed: number }>
  update(pathname: string, patch: { alt?: string | null, caption?: string | null, crops?: Record<string, { aspect: string, focal?: ConsoleMediaFocal | null } | null>, focal?: ConsoleMediaFocal | null }): Promise<ConsoleMediaFile>
  upload(file: File, options?: ConsoleMediaUploadOptions): Promise<ConsoleMediaUploadResult>
  /** The documents that use each pathname, in collections the user may read. */
  usage(pathnames: readonly string[]): Promise<Record<string, ConsoleMediaReferenceDocument[]>>
}

/** `/_vitehub/api/documents` → `/_vitehub/api/media`. */
export function consoleMediaBase(documentsBase: string): string {
  return documentsBase.replace(/\/documents$/, "/media")
}

/** The part of the browser `XMLHttpRequest` that uploads use. The Console types build without the DOM library. */
interface ConsoleUploadRequest {
  open(method: string, url: string): void
  readonly response: unknown
  responseType: string
  send(body: string): void
  setRequestHeader(name: string, value: string): void
  readonly status: number
  abort(): void
  addEventListener(type: "abort" | "error" | "load", listener: () => void): void
  readonly upload: { addEventListener(type: "progress", listener: (event: { lengthComputable: boolean, loaded: number, total: number }) => void): void }
}

/** Base64 of a file. Chunks keep each `String.fromCharCode()` call below the argument limit of the engine. */
async function fileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/**
 * Sends one `media.upload` call with XMLHttpRequest, which reports upload progress and fetch does not. The file travels
 * as base64 in the JSON body of the Console RPC.
 */
async function uploadRequest(input: Record<string, string>, options: ConsoleMediaUploadOptions): Promise<unknown> {
  const { url, headers } = projectRequest(operationRpcPath, { "content-type": "application/json", [consoleRpcHeader]: "1" })
  const outcome = await callOperationRpc("media.upload", input, body => sendUpload(url, headers, body, options))
  if (outcome.ok) return outcome.value
  // Host middleware answers with the diagnostic body and no birpc reply.
  const failure = outcome.error ?? (outcome.answer.body instanceof Object && !Array.isArray(outcome.answer.body) ? outcome.answer.body : undefined)
  const message: unknown = failure ? Reflect.get(failure, "message") : undefined
  const code: unknown = failure ? Reflect.get(failure, "code") : undefined
  const status = outcome.answer.status >= 200 && outcome.answer.status < 300 ? 502 : outcome.answer.status
  throw new ConsoleRequestError(status || 502, String(message) === message ? message : status === 413 ? "The file is too large for this server." : undefined, String(code) === code ? { code } : {})
}

interface ConsoleUploadAnswer {
  status: number
  body: unknown
}

function sendUpload(url: string, headers: Record<string, string>, body: string, options: ConsoleMediaUploadOptions): Promise<ConsoleUploadAnswer> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("The upload was cancelled.", "AbortError"))
      return
    }
    // SAFETY: The media library runs in the browser, where XMLHttpRequest exists with this shape.
    const XHR = Reflect.get(globalThis, "XMLHttpRequest") as new () => ConsoleUploadRequest
    const request = new XHR()
    request.open("POST", url)
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value)
    request.responseType = "json"
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total)
    })
    request.addEventListener("load", () => {
      resolve({ body: request.response, status: request.status })
    })
    request.addEventListener("error", () => reject(new ConsoleRequestError(0, "The upload could not reach the server.")))
    request.addEventListener("abort", () => reject(new DOMException("The upload was cancelled.", "AbortError")))
    options.signal?.addEventListener("abort", () => request.abort(), { once: true })
    request.send(body)
  })
}

/** Calls the media library actions of one document editor section. */
export function createConsoleMediaClient(base: string, section: string): ConsoleMediaClient {
  async function call(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const options: Parameters<typeof requestConsole>[1] = { body, method: "POST", query: { action, section } }
    if (signal) options.signal = signal
    return await requestConsole(base, options)
  }
  // SAFETY: The media actions return the mirrored contract of `server/media.ts`. Components render fields as text.
  const typed = <T>(value: Promise<unknown>) => value as Promise<T>
  return {
    createFolder: (parent, name) => typed(call("createFolder", { name, parent })),
    get: pathname => typed(call("get", { pathname })),
    info: () => typed(call("info", {})),
    list: (query = {}, signal) => typed(call("list", { ...query }, signal)),
    move: moves => typed(call("move", { moves: moves.map(({ from, to }) => ({ from, to })) })),
    moveFolder: (from, to) => typed(call("moveFolder", { from, to })),
    remove: pathnames => typed(call("remove", { pathnames: [...pathnames] })),
    removeCropReplacement: (pathname, crop) => typed(call("removeCropReplacement", { crop, pathname })),
    removeFolder: (path, force = false) => typed(call("removeFolder", { force, path })),
    update: (pathname, patch) => typed(call("update", { ...patch, pathname })),
    async upload(file, options = {}) {
      const input: Record<string, string> = { data: await fileBase64(file), filename: file.name || "file", section }
      if (file.type) input.contentType = file.type
      if (options.crop) {
        input.crop = options.crop.name
        input.pathname = options.crop.pathname
      }
      else if (options.folder) input.folder = options.folder
      // SAFETY: The `media.upload` operation returns `{ duplicate, file }`.
      return await uploadRequest(input, options) as ConsoleMediaUploadResult
    },
    async usage(pathnames) {
      const result = await call("usage", { pathnames: [...pathnames] })
      const references = result instanceof Object ? Reflect.get(result, "references") : undefined
      // SAFETY: `references` maps each pathname to the documents of the owner `references` action.
      return (references instanceof Object ? references : {}) as Record<string, ConsoleMediaReferenceDocument[]>
    },
  }
}

// Display helpers

/** The URL that serves a pathname on the project, or undefined when the store is not served. */
export function consoleMediaUrl(served: string | null | undefined, pathname: string): string | undefined {
  if (!served) return undefined
  return resolveProjectUrl(`${served}${pathname.split("/").map(encodeURIComponent).join("/")}`)
}

/** The URL of a media file on the project: its own served URL, or the served URL of its store. */
export function consoleMediaFileUrl(file: Pick<ConsoleMediaFile, "pathname" | "url">, served: string | null | undefined): string | undefined {
  return file.url === undefined ? consoleMediaUrl(served, file.pathname) : resolveProjectUrl(file.url)
}

export interface ConsoleMediaVariant {
  crop?: string
  fit?: "cover" | "inside"
  height?: number
  /** Changes when the file, focal point, or crops change, so the browser does not show a stale variant. */
  version?: string
  width?: number
}

/** A resized variant of a served image, such as `?w=256&h=256&fit=cover`. Other files keep their URL. */
export function consoleMediaVariantUrl(url: string, variant: ConsoleMediaVariant): string {
  const query = new URLSearchParams()
  if (variant.width) query.set("w", String(variant.width))
  if (variant.height) query.set("h", String(variant.height))
  if (variant.fit) query.set("fit", variant.fit)
  if (variant.crop) query.set("crop", variant.crop)
  if (variant.version) query.set("v", variant.version)
  const search = query.toString()
  return search ? `${url}${url.includes("?") ? "&" : "?"}${search}` : url
}

/** Whether the serve route can make variants of this content type. GIF and SVG are served as they are. */
export function consoleMediaTransformable(contentType: string): boolean {
  return /^image\/(?:avif|jpeg|png|webp)$/i.test(contentType.split(";")[0]!.trim())
}

export function consoleMediaType(contentType: string): ConsoleMediaType {
  const type = contentType.split(";")[0]!.trim().toLowerCase()
  if (type.startsWith("image/")) return "image"
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("audio/")) return "audio"
  if (type === "application/pdf" || type.startsWith("text/") || /(?:msword|officedocument|opendocument|rtf|epub)/.test(type)) return "document"
  return "other"
}

export const consoleMediaTypeIcons: Record<ConsoleMediaType, string> = {
  audio: "i-lucide-file-audio",
  document: "i-lucide-file-text",
  image: "i-lucide-file-image",
  other: "i-lucide-file",
  video: "i-lucide-file-video",
}

/** `JPEG`, `PNG`, `PDF`, … from a content type or file name. */
export function consoleMediaFormat(file: Pick<ConsoleMediaFile, "contentType" | "name">): string {
  const subtype = file.contentType.split(";")[0]!.split("/")[1]?.replace(/^x-/, "").replace("svg+xml", "svg") ?? ""
  const extension = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1] ?? ""
  return (subtype && subtype.length <= 5 ? subtype : extension || subtype || "file").toUpperCase()
}

/** `Oct 14, 2026, 16:53` in the viewer's time zone. */
export function consoleMediaDate(value: string): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return "Unknown"
  return new Intl.DateTimeFormat("en", { day: "numeric", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "short", year: "numeric" }).format(time)
}

/** Parses `4:5`, `16/9`, or `1.91:1` to width divided by height. */
export function consoleAspectRatio(aspect: string): number | undefined {
  const match = /^(\d{1,5}(?:\.\d{1,4})?)\s*[:/x]\s*(\d{1,5}(?:\.\d{1,4})?)$/.exec(aspect.trim())
  if (!match) return undefined
  const ratio = Number(match[1]) / Number(match[2])
  return Number.isFinite(ratio) && ratio >= 0.01 && ratio <= 100 ? ratio : undefined
}

/** Aspect ratios that the focal point previews show, and that a new crop offers first. */
export const consoleMediaAspects: ReadonlyArray<{ aspect: string, label: string }> = [
  { aspect: "1:1", label: "Square" },
  { aspect: "4:5", label: "Portrait" },
  { aspect: "16:9", label: "Wide" },
  { aspect: "1.91:1", label: "Social" },
]

/** CSS `object-position` for a focal point. Pair it with `object-fit: cover`. */
export function consoleFocalPosition(focal: ConsoleMediaFocal | undefined): string {
  const point = focal ?? { x: 0.5, y: 0.5 }
  return `${Math.round(point.x * 10_000) / 100}% ${Math.round(point.y * 10_000) / 100}%`
}

/**
 * CSS `object-position` that shows the same region as the serve route's crop: the largest region with `aspect`,
 * centered on the focal point as far as the edges allow. Pair it with `object-fit: cover`.
 */
export function consoleFocalCropPosition(focal: ConsoleMediaFocal | undefined, source: { height?: number, width?: number }, aspect: number): string {
  const point = focal ?? { x: 0.5, y: 0.5 }
  if (!source.width || !source.height) return consoleFocalPosition(point)
  const width = Math.min(source.width, source.height * aspect)
  const height = Math.min(source.height, width / aspect)
  const axis = (center: number, size: number, total: number) => {
    const free = total - size
    if (free <= 0) return 50
    return Math.min(Math.max((center * total - size / 2) / free, 0), 1) * 100
  }
  return `${Math.round(axis(point.x, width, source.width) * 100) / 100}% ${Math.round(axis(point.y, height, source.height) * 100) / 100}%`
}

/** Crop names use letters, digits, `_`, and `-`: `Mobile hero` becomes `mobile-hero`. */
export function consoleCropName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)
}

/** The folders from the root to `folder`, for breadcrumbs: `a/b` → `["", "a", "a/b"]`. */
export function consoleFolderTrail(folder: string): string[] {
  const parts = folder.split("/").filter(Boolean)
  return ["", ...parts.map((_part, index) => parts.slice(0, index + 1).join("/"))]
}

export function consoleFolderName(folder: string): string {
  return folder ? folder.slice(folder.lastIndexOf("/") + 1) : "All files"
}

/** Whether a Markdown `src` is a Blob pathname rather than a URL, an absolute path, or a data URL. */
export function isConsoleMediaPathname(src: string): boolean {
  return Boolean(src) && !/^(?:[a-z][a-z0-9+.-]*:|\/|#|\.\.?\/)/i.test(src)
}

/** Whether a content type matches one of the accepted patterns, such as `image/*`. */
export function consoleMediaAccepts(accept: readonly string[] | undefined, contentType: string): boolean {
  if (!accept?.length) return true
  const type = contentType.split(";")[0]!.trim().toLowerCase()
  return accept.some(pattern => pattern === type || pattern === "*/*" || (pattern.endsWith("/*") && type.startsWith(pattern.slice(0, -1))))
}

const folderKey = "vitehub:console:media-folder"

/** The folder that uploads from the editor go to: the last folder someone opened in the library. */
export function rememberedConsoleMediaFolder(section: string): string {
  try {
    return globalThis.localStorage?.getItem(`${folderKey}:${section}`) ?? ""
  }
  catch {
    return ""
  }
}

export function rememberConsoleMediaFolder(section: string, folder: string): void {
  try {
    globalThis.localStorage?.setItem(`${folderKey}:${section}`, folder)
  }
  catch {
    // Private windows may refuse storage. The library then uploads to the root.
  }
}
