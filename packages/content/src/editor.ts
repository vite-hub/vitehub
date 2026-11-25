import type * as ComarkEditor from "comark-ui/editor"
import type { EditorCodec, EditorCodecOptions } from "comark-ui/editor"
import type { RealtimeEditor } from "@vite-hub/realtime"

import { contentEditorCodec, contentEditorRealtime, loadComarkEditor } from "./editor-codec.ts"

export type { EditorCodecOptions as ContentEditorOptions } from "comark-ui/editor"

const comarkEditor = await loadComarkEditor()

/** Comark UI's image node, as the Content editor uses it. */
export const ContentImage: typeof ComarkEditor.ComarkImage = comarkEditor.ComarkImage

/** Content's codec and schema, ready for a browser editor or a collaborative room. */
export function createContentEditorCodec(options: EditorCodecOptions = {}): EditorCodec {
  return contentEditorCodec(comarkEditor, options)
}

/** The same Content schema and loss check serve the Console and a collaborative room. */
export function contentRealtimeEditor(options: EditorCodecOptions = {}): RealtimeEditor {
  return contentEditorRealtime(comarkEditor, options)
}
