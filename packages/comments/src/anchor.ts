import type { CommentAnchor } from "./types.ts"

/** The attribute that Content's `contentField()` writes on an element that renders a field. */
export const fieldAttribute = "data-content-field"

const maxDepth = 10

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, character => `\\${character}`)
}

function attributeSelector(name: string, value: string): string {
  return `[${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"]`
}

/**
 * CSS path of an element: tag and `:nth-of-type` per level, at most 10 levels, from the closest ancestor with an id or
 * a Content field. Positional only, so `label` checks that it still finds the same element.
 */
export function selectorOf(element: Element): string {
  const parts: string[] = []
  let current: Element | null = element
  while (current && current !== document.documentElement && parts.length < maxDepth) {
    if (current.id) {
      parts.unshift(`#${cssEscape(current.id)}`)
      return parts.join(" > ")
    }
    const field = current.getAttribute(fieldAttribute)
    if (field) {
      parts.unshift(attributeSelector(fieldAttribute, field))
      return parts.join(" > ")
    }
    const tag = current.tagName.toLowerCase()
    const parent: Element | null = current.parentElement
    if (!parent) {
      parts.unshift(tag)
      break
    }
    const sameTag = [...parent.children].filter(child => child.tagName === current!.tagName)
    parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(current) + 1})` : tag)
    current = parent
  }
  return parts.join(" > ")
}

/** Tag and the first 40 characters of the element text. */
export function labelOf(element: Element): string {
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)
  const tag = element.tagName.toLowerCase()
  return text ? `${tag} ${text}` : tag
}

function thousandths(value: number, size: number): number {
  if (!size) return 0
  return Math.min(1000, Math.max(0, Math.round((value / size) * 1000)))
}

function documentWidth(): number {
  return Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth, 1)
}

/** The closest element with a Content field, from the element itself up. */
export function fieldElementOf(element: Element): Element | undefined {
  return element.closest(`[${fieldAttribute}]`) ?? undefined
}

/** The anchor of a point on an element, in client coordinates. */
export function createAnchor(element: Element, clientX: number, clientY: number): CommentAnchor {
  const box = element.getBoundingClientRect()
  const field = fieldElementOf(element)?.getAttribute(fieldAttribute) ?? undefined
  return {
    ...(field ? { field } : {}),
    selector: selectorOf(element),
    label: labelOf(element),
    x: thousandths(clientX - box.left, box.width),
    y: thousandths(clientY - box.top, box.height),
    page: { x: thousandths(clientX + window.scrollX, documentWidth()), y: Math.max(0, Math.round(clientY + window.scrollY)) },
    viewport: { width: window.innerWidth },
  }
}

function query(selector: string): Element | undefined {
  try {
    return document.querySelector(selector) ?? undefined
  }
  catch {
    return undefined
  }
}

function sameLabel(element: Element, label: string): boolean {
  return labelOf(element) === label
}

/** An element of the same tag whose label matches, for anchors whose CSS path moved. */
function findByLabel(label: string): Element | undefined {
  const tag = label.split(" ", 1)[0]
  if (!tag || tag === label) return
  try {
    for (const candidate of document.querySelectorAll(tag)) {
      if (sameLabel(candidate, label)) return candidate
    }
  }
  catch {}
}

export type PlacedAnchor =
  /** On the anchored element. */
  | { state: "exact", element: Element, x: number, y: number }
  /** At the page point, because the element is gone. The overlay shows the pin as approximate. */
  | { state: "moved", x: number, y: number }
  /** The element exists but has no box, such as inside a closed menu. */
  | { state: "hidden", element: Element }

/**
 * Where an anchor is now, in client coordinates: the Content field, then the CSS path if its label still matches,
 * then any element of that tag with the same label, then the page point.
 */
export function placeAnchor(anchor: CommentAnchor): PlacedAnchor {
  let element: Element | undefined
  if (anchor.field) {
    element = query(attributeSelector(fieldAttribute, anchor.field))
    // A field rendered more than once: prefer the path, which names the copy.
    const byPath = query(anchor.selector)
    if (element && byPath && fieldElementOf(byPath)?.getAttribute(fieldAttribute) === anchor.field) element = byPath
  }
  if (!element) {
    const byPath = query(anchor.selector)
    if (byPath && sameLabel(byPath, anchor.label)) element = byPath
  }
  element ??= findByLabel(anchor.label)
  if (element) {
    const box = element.getBoundingClientRect()
    if (!box.width && !box.height) return { state: "hidden", element }
    return { state: "exact", element, x: box.left + (anchor.x / 1000) * box.width, y: box.top + (anchor.y / 1000) * box.height }
  }
  return {
    state: "moved",
    x: (anchor.page.x / 1000) * documentWidth() - window.scrollX,
    y: anchor.page.y - window.scrollY,
  }
}
