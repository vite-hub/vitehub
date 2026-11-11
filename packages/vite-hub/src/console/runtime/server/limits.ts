/** Request limits and action names that the Console operations declare without loading their handlers. */
export const maximumConsoleRpcRequestBytes: number = 64 * 1_024
/** Bodies carry a whole Markdown document, so they may exceed the ordinary Console request limit. */
export const maximumConsoleDocumentRequestBytes: number = 1024 * 1024
export const maximumConsoleMediaRequestBytes: number = 256 * 1024
/** Largest file the Console uploads in one request. Hosts may lower it, such as Vercel Functions at 4.5 MB. */
export const maximumConsoleMediaUploadBytes: number = 32 * 1024 * 1024
/** A `media.upload` call carries the file as base64, so its body is a third larger than the file. */
export const consoleMediaUploadRequestBytes: number = Math.ceil(maximumConsoleMediaUploadBytes / 3) * 4 + maximumConsoleRpcRequestBytes
const maximumAttachmentBytes = 10 * 1024 * 1024
/** Invocation envelopes also carry image data URLs. */
export const consoleAttachmentRequestBytes: number = Math.ceil(maximumAttachmentBytes * 4 / 3) + 40960

/** The document actions that one Console request may call. It mirrors `ViteHubConsoleDocumentActionName`. */
export const consoleDocumentActionNames = ["get", "list", "overview", "preview", "publish", "raw", "references", "remove", "resolve", "restore", "revisions", "save", "schedule", "search", "session", "sessions", "unschedule"] as const
