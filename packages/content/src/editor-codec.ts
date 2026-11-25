import comarkUi from "comark-ui/html"
import type * as ComarkEditor from "comark-ui/editor"
import type { EditorCodec, EditorCodecOptions } from "comark-ui/editor"
import type { RealtimeEditor } from "@vite-hub/realtime"

import { contentClientDiagnostics } from "./client-diagnostics.ts"

type ComarkEditorModule = typeof ComarkEditor

function missingEditorPackage(error: unknown): string | undefined {
  if (!(error instanceof Error) || Reflect.get(error, "code") !== "ERR_MODULE_NOT_FOUND") return
  return /["'](@tiptap\/[\w.-]+|prosemirror-[\w-]+)["']/u.exec(error.message)?.[1]
}

/** Loads Comark UI's editor. Tiptap and ProseMirror are optional peers, so a missing one fails with a code that names it. */
export async function loadComarkEditor(): Promise<ComarkEditorModule> {
  return await import("comark-ui/editor").catch((error: unknown) => {
    const name = missingEditorPackage(error)
    throw name ? contentClientDiagnostics.CONTENT_EDITOR_PACKAGES_MISSING({ name, cause: error }) : error
  })
}

/** Content's codec and schema, built with a loaded Comark UI editor. */
export function contentEditorCodec(editor: ComarkEditorModule, options: EditorCodecOptions = {}): EditorCodec {
  return editor.createEditorCodec({ plugins: comarkUi({ annotate: false, diff: false, quiz: false, chips: { download: false }, badge: { download: false }, icon: { fetch: false }, diagrams: { draw: false } }).plugins, ...options })
}

/** The Realtime editor of Content, built with a loaded Comark UI editor. */
export function contentEditorRealtime(editor: ComarkEditorModule, options: EditorCodecOptions = {}): RealtimeEditor {
  const codec = contentEditorCodec(editor, options)
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
