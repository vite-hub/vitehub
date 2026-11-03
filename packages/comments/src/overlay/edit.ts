import { fieldAttribute } from "../anchor.ts"
import { api } from "./api.ts"

import type { CommentsApiError } from "./api.ts"

export interface InlineEditOptions {
  /** The page whose policy allows this edit. Captured when editing starts, even if the router moves before save. */
  page: () => string
  /** Opens the Content tool of the page tools at a document path. False when there is no such tool. */
  openTool: (path: string) => Promise<boolean>
  /** Where the Content Console is, for the toasts of a saved draft and of a field that is not plain text. */
  contentPath: () => string
  info: (text: string, link: [string, string]) => void
  failed: (error: CommentsApiError) => void
  /** A field got a new draft. The outlines show it. */
  drafted: (field: string) => void
}

/**
 * Edit mode: a click on an element with `data-content-field` edits its text in place. Enter, or leaving the field,
 * saves it as a Content draft. Escape restores the text.
 */
export function createInlineEdit(options: InlineEditOptions) {
  let editing: { element: HTMLElement, field: string, page: string, digest: string, original: string, initial: string } | undefined
  let stop: (() => void) | undefined
  let generation = 0

  async function finish(save: boolean) {
    generation++
    const current = editing
    if (!current) return
    editing = undefined
    stop?.()
    const { element, field, page, digest, original, initial } = current
    element.contentEditable = "inherit"
    element.removeAttribute("data-vitehub-editing")
    const value = (element.textContent ?? "").trim()
    if (!save) {
      element.textContent = original
      return
    }
    if (value === initial.trim()) return
    const [error] = await api.saveField({ field, value, ifDigest: digest }, page)
    if (error) {
      element.textContent = original
      return options.failed(error)
    }
    options.drafted(field)
    options.info("Saved as a draft. Publish it in the Console.", ["Review and publish", options.contentPath()])
  }

  async function start(element: HTMLElement) {
    const finished = finish(true)
    const request = generation
    await finished
    if (request !== generation || !element.isConnected) return
    const field = element.getAttribute(fieldAttribute)
    if (!field) return
    const page = options.page()
    const [error, value] = await api.field(field, page)
    if (request !== generation || !element.isConnected) return
    if (error) return options.failed(error)
    const path = `/content/${encodeURIComponent(value.collection)}/${value.id.split("/").map(encodeURIComponent).join("/")}`
    if (await options.openTool(path) || request !== generation || !element.isConnected) return
    if (!value.editable || value.value === null) {
      options.info("This field is not plain text. Edit it in the Console.", ["Open Content", options.contentPath()])
      return
    }
    editing = { element, field, page, digest: value.digest, original: element.textContent ?? "", initial: value.value }
    element.textContent = value.value
    element.setAttribute("data-vitehub-editing", "")
    element.contentEditable = "plaintext-only"
    if (element.contentEditable !== "plaintext-only") element.contentEditable = "true"
    element.focus()
    const range = document.createRange()
    range.selectNodeContents(element)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        void finish(true)
      }
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        void finish(false)
      }
    }
    const blur = () => void finish(true)
    element.addEventListener("keydown", keydown)
    element.addEventListener("blur", blur, { once: true })
    stop = () => {
      element.removeEventListener("keydown", keydown)
      element.removeEventListener("blur", blur)
    }
  }

  return {
    start,
    finish,
    /** The element whose text is being edited. */
    get element() {
      return editing?.element
    },
  }
}
