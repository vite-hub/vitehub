/** Request limits and action names that the Console operations declare without loading their handlers. */
export const maximumConsoleRpcRequestBytes: number = 64 * 1_024
/** Bodies carry a whole Markdown document, so they may exceed the ordinary Console request limit. */
export const maximumConsoleDocumentRequestBytes: number = 1024 * 1024
export const maximumConsoleMediaRequestBytes: number = 256 * 1024
const maximumAttachmentBytes = 10 * 1024 * 1024
/** Invocation envelopes also carry image data URLs. */
export const consoleAttachmentRequestBytes: number = Math.ceil(maximumAttachmentBytes * 4 / 3) + 40960

/** The document actions that one Console request may call. It mirrors `ViteHubConsoleDocumentActionName`. */
export const consoleDocumentActionNames = ["get", "list", "overview", "publish", "raw", "references", "remove", "restore", "revisions", "save", "schedule", "search", "session", "sessions", "unschedule"] as const
