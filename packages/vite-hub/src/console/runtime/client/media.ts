import { inject, provide } from "vue"

import type { InjectionKey } from "vue"

/**
 * Media for the document editor. The body editor asks a picker for images when someone chooses **Image…** in the `/`
 * menu or pastes or drops image files. Provide a picker with `provideConsoleMediaPicker()` above the editor, such as a
 * Blob media library. Without one, the editor asks for a Blob path or URL.
 */
export interface ConsoleMediaRequest {
  /** What the editor inserts. */
  kind: "image"
  /** Files pasted or dropped into the body, in order. Empty when someone chose Image… from the menu. */
  files: readonly File[]
  collection: string
  /** Undefined while the document is new. */
  documentId?: string
}

/** One image to insert. `src` is written to the Markdown as is, such as a Blob pathname or a URL. */
export interface ConsoleMediaItem {
  alt?: string
  src: string
  title?: string
}

export interface ConsoleMediaPicker {
  /** Resolves to the images to insert, in order, or an empty list when the person cancels. */
  pick(request: ConsoleMediaRequest): Promise<ConsoleMediaItem[]>
  /**
   * The URL that displays a stored `src` in the editor, such as a signed Blob URL for a pathname. Return undefined to
   * show the `src` as written. Display only: the Markdown keeps the `src`.
   */
  resolveSrc?(src: string): string | undefined
}

const pickerKey: InjectionKey<ConsoleMediaPicker> = Symbol("vitehub-console-media-picker")

/** Makes `picker` the media picker of every document editor below this component. */
export function provideConsoleMediaPicker(picker: ConsoleMediaPicker): void {
  provide(pickerKey, picker)
}

/** The media picker that a parent provided, or undefined when the editor should use its own. */
export function useConsoleMediaPicker(): ConsoleMediaPicker | undefined {
  return inject(pickerKey, undefined)
}
