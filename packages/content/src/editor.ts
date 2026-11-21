import comarkUi from "comark-ui/html"
import type * as ComarkEditor from "comark-ui/editor"
import type { EditorCodec, EditorCodecOptions } from "comark-ui/editor"
import type { RealtimeEditor } from "@vite-hub/realtime"

import { contentClientDiagnostics } from "./client-diagnostics.ts"

export type { EditorCodecOptions as ContentEditorOptions } from "comark-ui/editor"

/** The Tiptap or ProseMirror package that a failed load of the editor names, when one of them is not installed. */
function missingEditorPackage(error: unknown): string | undefined {
  if (!(error instanceof Error) || Reflect.get(error, "code") !== "ERR_MODULE_NOT_FOUND") return
  return /["'](@tiptap\/[\w.-]+|prosemirror-[\w-]+)["']/u.exec(error.message)?.[1]
}

// Tiptap and ProseMirror are optional peers. Without them, the editor load fails with a code that names the package.
const { ComarkImage, createEditorCodec }: typeof ComarkEditor = await import("comark-ui/editor").catch((error: unknown) => {
  const name = missingEditorPackage(error)
  throw name ? contentClientDiagnostics.CONTENT_EDITOR_PACKAGES_MISSING({ name, cause: error }) : error
})

/** Comark UI's image node, as the Content editor uses it. */
export const ContentImage: typeof ComarkEditor.ComarkImage = ComarkImage

/** Content's codec and schema, ready for a browser editor or a collaborative room. */
export function createContentEditorCodec(options: EditorCodecOptions = {}): EditorCodec {
  return createEditorCodec({ plugins: comarkUi({ annotate: false, diff: false, quiz: false, chips: { download: false }, badge: { download: false }, icon: { fetch: false }, diagrams: { draw: false } }).plugins, ...options })
}

/** The same Content schema and loss check serve the Console and a collaborative room. */
export function contentRealtimeEditor(options: EditorCodecOptions = {}): RealtimeEditor {
  const codec = createContentEditorCodec(options)
  return {
    ...codec,
    async verify(markdown) {
      const result = await codec.verify(markdown)
      if (!result.writable) return {
        writable: false,
        issues: [{ field: "body", message: "The editor cannot keep this Markdown unchanged. Edit this body in Source.", path: ["body"] }],
      }
      const canonical = result.canonical === undefined ? markdown : result.canonical.replace(/\n*$/, markdown.endsWith("\n") ? "\n" : "")
      return canonical === markdown ? { writable: true } : { canonical, writable: true }
    },
  }
}
