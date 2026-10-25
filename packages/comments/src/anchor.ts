import { commentsErrorDiagnostics } from "./errors.ts"
import type { AreaAnchor, CommentAnchor, ElementAnchor, ImageAnchor, TextAnchor } from "./types.ts"

/** A point in client (viewport) coordinates, such as `event.clientX` and `event.clientY`. */
export interface AnchorPoint {
  x: number
  y: number
}

export interface AnchorRect {
  left: number
  top: number
  width: number
  height: number
}

export type AnchorTarget = Element | Range | Selection | AnchorPoint | "page"

export interface CreateAnchorOptions {
  /** Where selectors are looked up. Defaults to the document of the target. */
  root?: ParentNode
  /** For an element target: where the click landed, in client coordinates. Defaults to the middle. */
  point?: AnchorPoint
  /** For an element target: a rectangle in client coordinates. It makes an `area` anchor, or an `image` area on an image. */
  area?: AnchorRect
  /** Skip elements that are not the page, such as the comment layer. */
  ignore?: (element: Element) => boolean
  /** How many characters of text to keep before and after a quote. Default 32. */
  context?: number
}

export interface ResolvedAnchor {
  detached: false
  kind: CommentAnchor["kind"]
  /** The pin position in client coordinates. For a `page` anchor it is `0, 0`. */
  x: number
  y: number
  /** The size of an area or a quote in pixels. `0` for a point. */
  width: number
  height: number
  /** Missing for a `page` anchor. */
  element?: Element
}

export interface DetachedAnchor {
  detached: true
}

export type AnchorPosition = ResolvedAnchor | DetachedAnchor

const defaultContext = 32

const clamp = (value: number): number => Math.min(1000, Math.max(0, value))

function thousandths(value: number, size: number): number {
  return size > 0 ? clamp(Math.round(value / size * 1000)) : 0
}

function ownerDocument(node: Node): Document | null {
  return node.nodeType === 9 ? node as Document : node.ownerDocument
}

function defaultRoot(node: Node): ParentNode {
  const root = node.getRootNode()
  return root.nodeType === 11 ? root as ShadowRoot : ownerDocument(node) ?? document
}

function attr(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`
}

function lookup(root: ParentNode, selector: string): Element[] {
  try {
    return [...root.querySelectorAll(selector)]
  } catch {
    return []
  }
}

function isOnly(root: ParentNode, selector: string, element: Element): boolean {
  const found = lookup(root, selector)
  return found.length === 1 && found[0] === element
}

// Order: `data-comment-id`, `id`, `data-testid`. A value that is not unique in the root does not name the element.
function stableSelector(element: Element, root: ParentNode): string | undefined {
  const candidates: string[] = []
  const commentId = element.getAttribute("data-comment-id")
  if (commentId) candidates.push(`[data-comment-id=${attr(commentId)}]`)
  const id = element.getAttribute("id")
  if (id) candidates.push(/^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id=${attr(id)}]`)
  const testId = element.getAttribute("data-testid")
  if (testId) candidates.push(`[data-testid=${attr(testId)}]`)
  return candidates.find(candidate => isOnly(root, candidate, element))
}

function segment(element: Element): string {
  const tag = element.localName
  const parent = element.parentElement
  if (!parent) return tag
  const same = [...parent.children].filter(child => child.localName === tag)
  return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(element) + 1})` : tag
}

/**
 * The shortest selector that names the element: a stable attribute, else a path from the nearest stable
 * ancestor or from the top of the page, cut as soon as it is unique.
 */
export function selectorFor(element: Element, root: ParentNode = defaultRoot(element)): string {
  const own = stableSelector(element, root)
  if (own) return own
  const parts: string[] = []
  let node: Element | null = element
  while (node && node !== root) {
    const stable = node === element ? undefined : stableSelector(node, root)
    parts.unshift(stable ?? segment(node))
    const path = parts.join(" > ")
    if (stable || isOnly(root, path, element)) return path
    node = node.parentElement
  }
  return parts.join(" > ")
}

function boxOf(element: Element): AnchorRect {
  const { left, top, width, height } = element.getBoundingClientRect()
  return { left, top, width, height }
}

function pointTarget(point: AnchorPoint, options: CreateAnchorOptions): Element | undefined {
  const node: Node | undefined = options.root
  const scope: DocumentOrShadowRoot = node?.nodeType === 11 ? node as ShadowRoot : (node && ownerDocument(node)) || document
  const stack = typeof scope.elementsFromPoint === "function"
    ? scope.elementsFromPoint(point.x, point.y)
    : [scope.elementFromPoint(point.x, point.y)]
  return stack.find((element): element is Element => element !== null && !options.ignore?.(element))
}

function textNodes(node: Node, into: Text[] = []): Text[] {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) into.push(child as Text)
    else if (child.nodeType === 1) textNodes(child, into)
  }
  return into
}

const FOLLOWING = 4

// The offset of a (node, offset) boundary in the concatenated text of `element`.
function textOffset(element: Element, container: Node, offset: number): number {
  let total = 0
  // A boundary in an element sits before the child at `offset`, or at the end of the element.
  const next = container.nodeType === 3 ? undefined : container.childNodes[offset]
  for (const node of textNodes(element)) {
    if (container.nodeType === 3) {
      if (node === container) return total + offset
    } else if (next ? node === next || next.compareDocumentPosition(node) & FOLLOWING : !container.contains(node) && container.compareDocumentPosition(node) & FOLLOWING) {
      break
    }
    total += node.data.length
  }
  return total
}

function rangeOf(target: Range | Selection): Range | undefined {
  if ("rangeCount" in target) return target.rangeCount > 0 && !target.isCollapsed ? target.getRangeAt(0) : undefined
  return target.collapsed ? undefined : target
}

function elementOfNode(node: Node): Element | null {
  return node.nodeType === 1 ? node as Element : node.parentElement
}

function textAnchor(target: Range | Selection, options: CreateAnchorOptions): TextAnchor {
  const range = rangeOf(target)
  const exact = range?.toString() ?? ""
  const container = range && elementOfNode(range.commonAncestorContainer)
  if (!range || !container || exact === "") throw commentsErrorDiagnostics.COMMENTS_R0001({ target: "an empty selection" })
  const element = ignoreUp(container, options) ?? container
  const start = textOffset(element, range.startContainer, range.startOffset)
  const text = textNodes(element).map(node => node.data).join("")
  const context = options.context ?? defaultContext
  return {
    kind: "text",
    selector: selectorFor(element, options.root ?? defaultRoot(element)),
    exact,
    prefix: text.slice(Math.max(0, start - context), start),
    suffix: text.slice(start + exact.length, start + exact.length + context),
  }
}

function ignoreUp(element: Element, options: CreateAnchorOptions): Element | undefined {
  let node: Element | null = element
  while (node && options.ignore?.(node)) node = node.parentElement
  return node ?? undefined
}

function isImage(element: Element): boolean {
  return element.localName === "img"
}

function boxAnchor(element: Element, options: CreateAnchorOptions, point: AnchorPoint | undefined): ElementAnchor | AreaAnchor | ImageAnchor {
  const box = boxOf(element)
  const selector = selectorFor(element, options.root ?? defaultRoot(element))
  const kind = isImage(element) ? "image" : undefined
  if (options.area) {
    const x = thousandths(options.area.left - box.left, box.width)
    const y = thousandths(options.area.top - box.top, box.height)
    const area = {
      selector,
      x,
      y,
      width: Math.min(thousandths(options.area.width, box.width), 1000 - x),
      height: Math.min(thousandths(options.area.height, box.height), 1000 - y),
    }
    if (area.width > 0 && area.height > 0) return kind ? { kind, ...area } : { kind: "area", ...area }
  }
  const x = point ? thousandths(point.x - box.left, box.width) : 500
  const y = point ? thousandths(point.y - box.top, box.height) : 500
  return kind ? { kind, selector, x, y } : { kind: "element", selector, x, y }
}

/**
 * Describes a spot of the page so it can be found again: an element with an offset, a text quote, an area,
 * a point on an image, or the whole page. Selectors and offsets survive layout changes, because offsets are
 * thousandths of the element box.
 */
export function createAnchor(target: AnchorTarget, options: CreateAnchorOptions = {}): CommentAnchor {
  if (target === "page") return { kind: "page" }
  // An SVG element has `x` and `y` too, so test for a node first.
  if ("nodeType" in target) return boxAnchor(target, options, options.point)
  if ("rangeCount" in target || "startContainer" in target) return textAnchor(target, options)
  const element = pointTarget(target, options)
  if (!element) throw commentsErrorDiagnostics.COMMENTS_R0001({ target: `the point ${Math.round(target.x)}, ${Math.round(target.y)}` })
  return boxAnchor(element, options, target)
}

// Chooses among equal quotes by how well the text around them matches the stored prefix and suffix.
function findQuote(text: string, anchor: TextAnchor): number {
  let best = -1
  let bestScore = -1
  for (let at = text.indexOf(anchor.exact); at !== -1; at = text.indexOf(anchor.exact, at + 1)) {
    const before = text.slice(0, at)
    const after = text.slice(at + anchor.exact.length)
    let score = 0
    while (score < anchor.prefix.length && before.at(-1 - score) === anchor.prefix.at(-1 - score)) score++
    let tail = 0
    while (tail < anchor.suffix.length && after[tail] === anchor.suffix[tail]) tail++
    score += tail
    if (score > bestScore) {
      best = at
      bestScore = score
    }
  }
  return best
}

function boundary(nodes: Text[], offset: number, end: boolean): { node: Text, offset: number } | undefined {
  let total = 0
  for (const node of nodes) {
    const next = total + node.data.length
    if (end ? offset > total && offset <= next : offset >= total && offset < next) return { node, offset: offset - total }
    total = next
  }
  const last = nodes.at(-1)
  return last && offset === total ? { node: last, offset: last.data.length } : undefined
}

function visible(rect: AnchorRect): boolean {
  return rect.width > 0 || rect.height > 0
}

function resolveText(anchor: TextAnchor, element: Element): ResolvedAnchor | undefined {
  const nodes = textNodes(element)
  const text = nodes.map(node => node.data).join("")
  const start = findQuote(text, anchor)
  if (start === -1) return undefined
  const from = boundary(nodes, start, false)
  const to = boundary(nodes, start + anchor.exact.length, true)
  const own = boxOf(element)
  let rect = own
  let first = own
  if (from && to) {
    const doc = ownerDocument(element) ?? document
    const range = doc.createRange()
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    if (typeof range.getBoundingClientRect === "function") {
      const { left, top, width, height } = range.getBoundingClientRect()
      if (visible({ left, top, width, height })) rect = { left, top, width, height }
    }
    const line = typeof range.getClientRects === "function" ? range.getClientRects()[0] : undefined
    first = line && visible(line) ? { left: line.left, top: line.top, width: line.width, height: line.height } : rect
  }
  if (!visible(rect)) return undefined
  return { detached: false, kind: "text", x: first.left, y: first.top, width: rect.width, height: rect.height, element }
}

/**
 * Finds an anchor on the page again. It returns the pin position in client coordinates, or `{ detached: true }`
 * when the element is gone, hidden, or no longer holds the quote.
 */
export function resolveAnchor(anchor: CommentAnchor, root: ParentNode = document): AnchorPosition {
  if (anchor.kind === "page") return { detached: false, kind: "page", x: 0, y: 0, width: 0, height: 0 }
  const element = lookup(root, anchor.selector)[0]
  if (!element) return { detached: true }
  if (anchor.kind === "text") return resolveText(anchor, element) ?? { detached: true }
  const box = boxOf(element)
  if (!visible(box)) return { detached: true }
  const width = "width" in anchor && anchor.width ? anchor.width / 1000 * box.width : 0
  const height = "height" in anchor && anchor.height ? anchor.height / 1000 * box.height : 0
  return {
    detached: false,
    kind: anchor.kind,
    x: box.left + anchor.x / 1000 * box.width,
    y: box.top + anchor.y / 1000 * box.height,
    width,
    height,
    element,
  }
}
