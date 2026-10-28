import { createEditorCodec } from "comark-ui/editor"
import comarkUi from "comark-ui/html"
import type { EditorCodecOptions } from "comark-ui/editor"
import type { RealtimeEditor } from "@vite-hub/realtime"

/** The same Comark UI schema and loss check serve the Console and a collaborative room. */
export function contentRealtimeEditor(options: EditorCodecOptions = {}): RealtimeEditor {
  const codec = createEditorCodec({ plugins: comarkUi({ chips: { download: false }, badge: { download: false }, icon: { fetch: false }, diagrams: { draw: false } }).plugins, ...options })
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
