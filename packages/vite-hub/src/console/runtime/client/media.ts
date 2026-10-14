import { inject, provide } from "vue"

import type { InjectionKey } from "vue"

/**
 * Media for the document editor. The editor asks a picker for media when someone chooses **Image…** in the `/` menu,
 * pastes or drops image files into the body, or chooses a file for a Blob reference field such as `image()`. Provide a
 * picker with `provideConsoleMediaPicker()` above the editor, such as the Content media library. Without one, the body
 * asks for a Blob path or URL and reference fields stay read-only.
 */
export interface ConsoleMediaRequest {
  /** `image` for the body and `image()` fields, `file` for `file()` fields. */
  kind: "file" | "image"
  /**
   * Files pasted or dropped into the body, in order. Empty when someone chose Image… or a field. A picker stores them and
   * resolves without asking.
   */
  files: readonly File[]
  /** The collection of the document, when the request comes from a document. */
  collection?: string
  /** Undefined while the document is new. */
  documentId?: string
  /** Allow more than one item, as the body does. A reference field holds one file. Defaults to `false`. */
  multiple?: boolean
  /** Accepted content types of a reference field, such as `["image/*"]`. */
  accept?: readonly string[]
}

/** The stored form of a picked file, as a Blob reference field keeps it. */
export interface ConsoleMediaReference {
  contentType?: string
  pathname: string
  size?: number
}

/** One picked item. `src` goes into the Markdown as is, such as a Blob pathname or a URL. */
export interface ConsoleMediaItem {
  alt?: string
  /** The Blob object, when the item is a stored file. Reference fields store it. */
  reference?: ConsoleMediaReference
  src: string
  title?: string
}

/** What a picker knows about a stored file, for a field preview. */
export interface ConsoleMediaDetails {
  alt?: string
  /** Average color as `#rrggbb`, for a placeholder. */
  color?: string
  /** Focal point, from 0 to 1 on each axis, so a square thumbnail keeps the subject in frame. */
  focal?: { x: number, y: number }
  height?: number
  /** A URL that displays the file, sized for a thumbnail when the picker can. */
  thumbnail?: string
  width?: number
}

export interface ConsoleMediaPicker {
  /** Resolves to the items to insert, in order, or an empty list when the person cancels. */
  pick(request: ConsoleMediaRequest): Promise<ConsoleMediaItem[]>
  /**
   * The URL that displays a stored `src` in the editor, such as the served URL of a Blob pathname. Return undefined to
   * show the `src` as written. Display only: the Markdown keeps the `src`.
   */
  resolveSrc?(src: string): string | undefined
  /** Reads what a field preview shows of a stored file. Undefined when the file no longer exists. */
  describe?(reference: ConsoleMediaReference): Promise<ConsoleMediaDetails | undefined>
  /** Changes the alt text stored with a file. Every document that uses the file shows the new text. */
  updateAlt?(reference: ConsoleMediaReference, alt: string): Promise<void>
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
