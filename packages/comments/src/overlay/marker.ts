/**
 * The Marker, as in Drop: highlighter strokes over the page, then one screenshot of the screen with the strokes on it,
 * which a new comment carries as its attachment. The strokes draw in their own element, so the page's DOM does not
 * change. They stay on the page, where they were drawn, while the comment is written.
 */

/** The highlighter colors. A stroke is see-through and multiplies, so the words under it stay dark. */
export const markerColors = { yellow: "#facc15", green: "#4ade80", pink: "#f472b6" } as const
export type MarkerColor = keyof typeof markerColors

/** A stroke in viewport pixels. */
export interface MarkerStroke {
  color: string
  points: Array<[number, number]>
}

export interface MarkerBox {
  left: number
  top: number
  width: number
  height: number
}

/** The width of a stroke, in CSS pixels. */
export const markerWidth = 18
const width = markerWidth
const svgNamespace = "http://www.w3.org/2000/svg"

// While it draws, the layer covers the comment UI too (the overlay is 2147482999, and this host comes later in the page),
// so a stroke can start on a pin or an area. The pill and its windows stay over it. Frozen, it goes under the comment UI,
// so the box of the new comment is not inked.
const styles = `:host{position:absolute;left:0;top:0;width:0;height:0;z-index:2147482999}
:host([frozen]){z-index:2147482998}
.layer{position:fixed;inset:0;touch-action:none}
.layer[data-frozen]{position:absolute;pointer-events:none}
svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
path{fill:none;stroke-width:${width}px;stroke-opacity:.4;stroke-linecap:butt;stroke-linejoin:round;mix-blend-mode:multiply}`

const point = ([x, y]: [number, number]) => `${x.toFixed(1)} ${y.toFixed(1)}`

/** A smooth path through the points: quadratic curves through their midpoints. */
export function markerPath(points: ReadonlyArray<[number, number]>): string {
  const [first, ...rest] = points
  if (!first) return ""
  if (rest.length === 0) return `M${point(first)}l0.1 0`
  let path = `M${point(first)}`
  for (let index = 1; index < points.length - 1; index++) {
    const here = points[index]!
    const next = points[index + 1]!
    path += `Q${point(here)} ${point([(here[0] + next[0]) / 2, (here[1] + next[1]) / 2])}`
  }
  return `${path}L${point(points[points.length - 1]!)}`
}

/** The box around the strokes, with half a stroke's width on each side, or `undefined` without strokes. */
export function markerBox(strokes: readonly MarkerStroke[]): MarkerBox | undefined {
  const points = strokes.flatMap(stroke => stroke.points)
  if (points.length === 0) return undefined
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const left = Math.min(...xs) - width / 2
  const top = Math.min(...ys) - width / 2
  return { left, top, width: Math.max(...xs) + width / 2 - left, height: Math.max(...ys) + width / 2 - top }
}

/** A pointer at the tip of the Marker: its size and color, see-through, with a dark ring so it shows on any page. */
function tipCursor(color: string): string {
  const size = width + 4
  const svg = `<svg xmlns="${svgNamespace}" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${width / 2}" fill="${color}" fill-opacity=".4" stroke="#0a0a0a" stroke-opacity=".55"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${size / 2} ${size / 2}, crosshair`
}

export interface MarkerOptions {
  color: () => string
  /** Runs after each stroke and each undo. */
  onChange: () => void
}

export interface MarkerSession {
  strokes: () => readonly MarkerStroke[]
  /** Follows a new color for the tip. */
  recolor: () => void
  undo: () => void
  /** Stops taking strokes and keeps them on the page, where they were drawn, as the page scrolls. */
  freeze: () => void
  remove: () => void
}

/**
 * Covers the screen with a layer that takes highlighter strokes. The page under it gets no pointer events and does not
 * scroll with the wheel or a touch, so the strokes stay on what they mark. Shift keeps a stroke on its line.
 */
export function startMarker(options: MarkerOptions): MarkerSession {
  const host = document.createElement("vitehub-marker")
  // Anchors, page clicks, and the screenshot skip the overlay's own elements by this attribute.
  host.setAttribute("data-comments-ui", "")
  const shadow = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = styles
  const layer = document.createElement("div")
  layer.className = "layer"
  const svg = document.createElementNS(svgNamespace, "svg")
  layer.append(svg)
  shadow.append(style, layer)
  document.documentElement.append(host)

  const strokes: Array<MarkerStroke & { path: SVGPathElement }> = []
  let current: (MarkerStroke & { path: SVGPathElement }) | undefined
  const recolor = () => {
    layer.style.cursor = tipCursor(options.color())
  }
  recolor()
  layer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || layer.hasAttribute("data-frozen")) return
    event.preventDefault()
    layer.setPointerCapture(event.pointerId)
    const path = document.createElementNS(svgNamespace, "path")
    const color = options.color()
    path.setAttribute("stroke", color)
    svg.append(path)
    current = { color, points: [[event.clientX, event.clientY]], path }
    path.setAttribute("d", markerPath(current.points))
  })
  layer.addEventListener("pointermove", (event) => {
    if (!current) return
    const next: [number, number] = [event.clientX, event.clientY]
    const first = current.points[0]!
    if (event.shiftKey) current.points = [first, [next[0], first[1]]]
    else {
      const last = current.points[current.points.length - 1]!
      if (Math.hypot(next[0] - last[0], next[1] - last[1]) > 2) current.points.push(next)
    }
    current.path.setAttribute("d", markerPath(current.points))
  })
  const end = () => {
    if (!current) return
    strokes.push(current)
    current = undefined
    options.onChange()
  }
  layer.addEventListener("pointerup", end)
  layer.addEventListener("pointercancel", end)
  // The strokes are in viewport pixels, so the page must not scroll under them.
  for (const type of ["wheel", "touchmove"]) layer.addEventListener(type, event => event.preventDefault(), { passive: false })

  return {
    strokes: () => strokes.map(({ color, points }) => ({ color, points })),
    recolor,
    undo() {
      strokes.pop()?.path.remove()
      options.onChange()
    },
    freeze() {
      host.setAttribute("frozen", "")
      layer.setAttribute("data-frozen", "")
      Object.assign(layer.style, { left: `${scrollX}px`, top: `${scrollY}px`, width: `${innerWidth}px`, height: `${innerHeight}px`, cursor: "" })
    },
    remove: () => host.remove(),
  }
}

/** The page's own background, so the screenshot is not transparent where the page shows the canvas. */
function pageBackground(): string {
  for (const element of [document.documentElement, document.body]) {
    const color = element ? getComputedStyle(element).backgroundColor : ""
    if (color && color !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(color)) return color
  }
  return "#ffffff"
}

/** Whether an element contains absolute children: positioned, transformed, filtered, or contained. */
function containsAbsolute(style: CSSStyleDeclaration): boolean {
  return style.position !== "static" || style.transform !== "none" || style.filter !== "none" || style.perspective !== "none"
    || /paint|layout|strict|content/.test(style.contain) || /transform|perspective|filter/.test(style.willChange)
}

/**
 * What an absolute element's position counts from in the copy of the page: the nearest ancestor that contains it, or one
 * whose parent is scrolled, since modern-screenshot moves that one with a transform. `undefined` is the picture's top left.
 */
function containerOf(element: Element): Element | undefined {
  for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    if (containsAbsolute(getComputedStyle(node))) return node
    const parent = node.parentElement
    if (parent && (parent.scrollTop || parent.scrollLeft)) return node
  }
  return undefined
}

interface Pin {
  element: HTMLElement
  sticky: boolean
  rect: DOMRect
  /** Where a sticky element would be if it did not stick. */
  from?: DOMRect
  left?: number
  top?: number
}

/**
 * modern-screenshot draws a copy of the page that is not scrolled, moved up by the scroll offset. A sticky header would
 * then sit where the page starts, and a fixed button would scroll away with the content. As in Drop's capture, this
 * records where each fixed and sticky element is on screen, and `apply` puts its copy there: a fixed one becomes
 * absolute at its place, and a sticky one becomes relative, moved from where it would be if it did not stick. Copies
 * reach the hook without their original, so the originals carry an attribute while the picture is taken.
 */
function pinScreen(skip: (node: Node) => boolean) {
  const attribute = "data-vitehub-pin"
  const pins: Pin[] = []
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof HTMLElement) || skip(node)) continue
    const style = getComputedStyle(node)
    if ((style.position !== "fixed" && style.position !== "sticky") || style.visibility === "hidden") continue
    const rect = node.getBoundingClientRect()
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue
    pins.push({ element: node, sticky: style.position === "sticky", rect })
  }
  // Where each sticky element would be: set static, measured, and put back before the browser paints.
  for (const pin of pins.filter(pin => pin.sticky)) {
    const saved = pin.element.getAttribute("style")
    pin.element.style.setProperty("position", "static", "important")
    pin.from = pin.element.getBoundingClientRect()
    pin.element.style.removeProperty("position")
    if (pin.element.getAttribute("style") !== saved) {
      if (saved === null) pin.element.removeAttribute("style")
      else pin.element.setAttribute("style", saved)
    }
  }
  pins.forEach((pin, index) => {
    if (!pin.sticky) {
      const box = containerOf(pin.element)
      const at = box?.getBoundingClientRect()
      const parent = pin.element.parentElement
      pin.left = pin.rect.left - (box && at ? at.left + box.clientLeft : 0) + (parent?.scrollLeft ?? 0)
      pin.top = pin.rect.top - (box && at ? at.top + box.clientTop : 0) + (parent?.scrollTop ?? 0)
    }
    pin.element.setAttribute(attribute, String(index))
  })
  return {
    apply(copy: Node) {
      if (!(copy instanceof HTMLElement) || !copy.hasAttribute(attribute)) return
      const pin = pins[Number(copy.getAttribute(attribute))]
      copy.removeAttribute(attribute)
      if (!pin) return
      const set = (name: string, value: string) => copy.style.setProperty(name, value, "important")
      for (const name of ["inset", "right", "bottom", "margin-block-start", "margin-block-end", "margin-inline-start", "margin-inline-end"]) copy.style.removeProperty(name)
      if (pin.sticky && pin.from) {
        set("position", "relative")
        set("left", `${pin.rect.left - pin.from.left}px`)
        set("top", `${pin.rect.top - pin.from.top}px`)
        return
      }
      set("position", "absolute")
      set("left", `${pin.left}px`)
      set("top", `${pin.top}px`)
      set("width", `${pin.rect.width}px`)
      set("height", `${pin.rect.height}px`)
      set("margin", "0")
      set("box-sizing", "border-box")
      // Its rect already includes any translate, as in a centered toast.
      for (const name of ["transform", "translate", "rotate", "scale"]) set(name, "none")
    },
    release() {
      for (const pin of pins) pin.element.removeAttribute(attribute)
    },
  }
}

/**
 * A screenshot of the screen as the person sees it, without `skip` (the comment UI and the page tools), with the strokes
 * drawn on it. Fixed and sticky parts of the page stay where they are on screen. modern-screenshot loads on the first
 * use, in a chunk of its own. Resolves with `undefined` when the page cannot be drawn, for example when an image of
 * another origin blocks the canvas.
 */
export async function captureMarked(strokes: readonly MarkerStroke[], skip: (node: Node) => boolean): Promise<Blob | undefined> {
  const pins = pinScreen(skip)
  try {
    const { domToCanvas } = await import("modern-screenshot")
    const scale = Math.min(devicePixelRatio || 1, 2)
    const canvas = await domToCanvas(document.documentElement, {
      width: innerWidth,
      height: innerHeight,
      scale,
      backgroundColor: pageBackground(),
      filter: node => !skip(node),
      features: { restoreScrollPosition: true },
      onCloneEachNode: copy => pins.apply(copy),
      timeout: 3000,
    })
    const context = canvas.getContext("2d")
    if (!context) return undefined
    context.setTransform(scale, 0, 0, scale, 0, 0)
    context.globalAlpha = 0.4
    context.globalCompositeOperation = "multiply"
    context.lineWidth = width
    context.lineCap = "butt"
    context.lineJoin = "round"
    for (const stroke of strokes) {
      context.strokeStyle = stroke.color
      context.stroke(new Path2D(markerPath(stroke.points)))
    }
    return await new Promise<Blob | undefined>(resolve => canvas.toBlob(blob => resolve(blob ?? undefined), "image/webp", 0.85))
  }
  catch {
    return undefined
  }
  finally {
    pins.release()
  }
}
