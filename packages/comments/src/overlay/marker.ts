/**
 * The Marker, as in Drop: ink over the page with one of four tips (a see-through marker, a pen, an arrow, or a text
 * label), then one screenshot of the screen with the ink on it, which a new comment carries as its attachment. The ink
 * draws in its own element, so the page's DOM does not change. It stays on the page, where it was drawn, while the
 * comment is written.
 */

/** The tips, as Drop has them: each one's key and width in CSS pixels, a stroke's width or a label's font size. */
export const markerTips = {
  marker: { label: "Marker", key: "B", width: 14 },
  pen: { label: "Pen", key: "P", width: 3 },
  arrow: { label: "Arrow", key: "A", width: 3 },
  // 16 at the least, so a phone does not zoom in while the label is typed.
  text: { label: "Text", key: "T", width: 20 },
} as const
export type MarkerTip = keyof typeof markerTips

/** Drop's ink colors. The marker's ink is see-through and multiplies, so the words under it stay dark. */
export const markerColors = { pink: "#ec4899", amber: "#f59e0b", blue: "#2563eb", green: "#16a34a" } as const
export type MarkerColor = keyof typeof markerColors

/** A stroke or a label, in viewport pixels. A stroke without a tip is a marker's. */
export interface MarkerStroke {
  tip?: MarkerTip
  color: string
  points: Array<[number, number]>
  /** An arrow drawn with Shift: its shaft does not bow. */
  straight?: boolean
  /** A label's words. Its one point is the middle of its left edge. */
  text?: string
}

export interface MarkerBox {
  left: number
  top: number
  width: number
  height: number
}

type Point = [number, number]

const svgNamespace = "http://www.w3.org/2000/svg"
const tipOf = (stroke: MarkerStroke): MarkerTip => stroke.tip ?? "marker"
const widthOf = (stroke: MarkerStroke): number => markerTips[tipOf(stroke)].width
/** A label's font. The SVG on the page, the canvas that measures it, and the screenshot use the same one. */
const labelFont = `600 ${markerTips.text.width}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`
const labelShadow = "0 1px 1.5px rgb(0 0 0 / 30%)"

// While it draws, the layer covers the comment UI too (the overlay is 2147482999, and this host comes later in the page),
// so a stroke can start on a pin or an area. The pill and its windows stay over it. Frozen, it goes under the comment UI,
// so the box of the new comment is not inked. Each tip's width is a rule of its class, so no element carries a style.
const styles = `:host{position:absolute;left:0;top:0;width:0;height:0;z-index:2147482999}
:host([frozen]){z-index:2147482998}
.layer{position:fixed;inset:0;touch-action:none}
.layer[data-frozen]{position:absolute;pointer-events:none}
svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
path{fill:none;stroke-linecap:round;stroke-linejoin:round}
path.marker{stroke-width:${markerTips.marker.width}px;stroke-opacity:.4;stroke-linecap:butt;mix-blend-mode:multiply}
path.pen{stroke-width:${markerTips.pen.width}px}
path.arrow{stroke-width:${markerTips.arrow.width}px}
.label{filter:drop-shadow(${labelShadow})}
.label text{font:${labelFont};white-space:pre}
input{position:fixed;z-index:1;box-sizing:border-box;margin:0;border:0;outline:0;font:${labelFont};caret-color:currentColor;box-shadow:${labelShadow},0 0 0 2px rgb(255 255 255 / 90%)}`

const point = ([x, y]: Point) => `${x.toFixed(1)} ${y.toFixed(1)}`

/** A smooth path through the points: quadratic curves through their midpoints. */
export function markerPath(points: ReadonlyArray<Point>): string {
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

/** A hand-drawn arrow from `from` to `to`: the shaft bows a little unless it is straight, and the head is two strokes. */
function arrowParts(from: Point, to: Point, straight = false) {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.hypot(dx, dy) || 1
  const bow = straight ? 0 : Math.min(18, length * 0.08)
  const control: Point = [(from[0] + to[0]) / 2 - (dy / length) * bow, (from[1] + to[1]) / 2 + (dx / length) * bow]
  const angle = Math.atan2(to[1] - control[1], to[0] - control[0])
  const head = Math.min(14, length * 0.4) + markerTips.arrow.width
  const side = (turn: number): Point => [to[0] - head * Math.cos(angle + turn), to[1] - head * Math.sin(angle + turn)]
  return { control, left: side(-0.5), right: side(0.5) }
}

/** The path of a marker, pen, or arrow stroke. */
export function strokePath(stroke: MarkerStroke): string {
  if (tipOf(stroke) !== "arrow") return markerPath(stroke.points)
  const from = stroke.points[0]
  const to = stroke.points[stroke.points.length - 1]
  if (!from || !to) return ""
  const { control, left, right } = arrowParts(from, to, stroke.straight)
  return `M${point(from)}Q${point(control)} ${point(to)}M${point(left)}L${point(to)}L${point(right)}`
}

let measurer: CanvasRenderingContext2D | null | undefined
function textWidth(text: string): number {
  measurer ??= document.createElement("canvas").getContext("2d")
  // A document without a canvas, as in tests, gets a close guess.
  if (!measurer) return text.length * markerTips.text.width * 0.55
  measurer.font = labelFont
  return measurer.measureText(text).width
}

/**
 * The pill of a label: its box in viewport pixels, the padding before its words, and its corner radius. Labels are
 * measured on a canvas, so the SVG on the page and the screenshot agree.
 */
export function labelBox(stroke: MarkerStroke): MarkerBox & { padding: number, radius: number } {
  const size = markerTips.text.width
  const padding = Math.round(size * 0.45)
  const height = Math.round(size * 1.5)
  const [x, y] = stroke.points[0] ?? [0, 0]
  return { left: x, top: y - height / 2, width: Math.ceil(textWidth(stroke.text ?? "")) + padding * 2, height, padding, radius: Math.round(size * 0.35) }
}

/** The color of a label's words: near-black or white, whichever reads on its ink. */
export function labelInk(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0a0a0a" : "#ffffff"
}

/** The box around the ink, with half a stroke's width on each side and an arrow's bow and head, or `undefined` without ink. */
export function markerBox(strokes: readonly MarkerStroke[]): MarkerBox | undefined {
  const boxes = strokes.flatMap((stroke): MarkerBox[] => {
    if (tipOf(stroke) === "text") {
      // The label's shadow reaches 2px under it.
      const box = labelBox(stroke)
      return [{ left: box.left, top: box.top, width: box.width, height: box.height + 2 }]
    }
    const half = widthOf(stroke) / 2
    let points: Point[] = stroke.points
    const from = stroke.points[0]
    const to = stroke.points[stroke.points.length - 1]
    if (tipOf(stroke) === "arrow" && from && to) {
      const { control, left, right } = arrowParts(from, to, stroke.straight)
      points = [from, control, to, left, right]
    }
    return points.map(([x, y]) => ({ left: x - half, top: y - half, width: half * 2, height: half * 2 }))
  })
  if (boxes.length === 0) return undefined
  const left = Math.min(...boxes.map(box => box.left))
  const top = Math.min(...boxes.map(box => box.top))
  const right = Math.max(...boxes.map(box => box.left + box.width))
  const bottom = Math.max(...boxes.map(box => box.top + box.height))
  return { left, top, width: right - left, height: bottom - top }
}

/** A pointer at the tip: its size and color, see-through for the marker, with a dark ring so it shows on any page. */
function tipCursor(tip: MarkerTip, color: string): string {
  if (tip === "arrow") return "crosshair"
  if (tip === "text") return "text"
  const width = markerTips[tip].width
  const size = Math.max(8, width + 4)
  const svg = `<svg xmlns="${svgNamespace}" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${Math.max(2, width / 2)}" fill="${color}" fill-opacity="${tip === "marker" ? 0.4 : 0.9}" stroke="#0a0a0a" stroke-opacity=".55"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${size / 2} ${size / 2}, crosshair`
}

function paintLabel(group: SVGGElement, stroke: MarkerStroke) {
  const box = labelBox(stroke)
  const rect = document.createElementNS(svgNamespace, "rect")
  const text = document.createElementNS(svgNamespace, "text")
  for (const [name, value] of Object.entries({ x: box.left, y: box.top, width: box.width, height: box.height, rx: box.radius })) rect.setAttribute(name, String(value))
  rect.setAttribute("fill", stroke.color)
  text.setAttribute("x", String(box.left + box.padding))
  text.setAttribute("y", String(stroke.points[0]![1]))
  text.setAttribute("dominant-baseline", "central")
  text.setAttribute("fill", labelInk(stroke.color))
  text.textContent = stroke.text ?? ""
  group.replaceChildren(rect, text)
}

/** Draws a stroke or a label into the layer's SVG. Colors are presentation attributes, so a page's CSP allows them. */
function drawStroke(stroke: MarkerStroke, svg: SVGSVGElement): SVGElement {
  if (tipOf(stroke) === "text") {
    const group = document.createElementNS(svgNamespace, "g")
    group.setAttribute("class", "label")
    paintLabel(group, stroke)
    svg.append(group)
    return group
  }
  const path = document.createElementNS(svgNamespace, "path")
  path.setAttribute("class", tipOf(stroke))
  path.setAttribute("stroke", stroke.color)
  path.setAttribute("d", strokePath(stroke))
  svg.append(path)
  return path
}

/** Draws the ink on a canvas in viewport pixels, as the layer shows it. */
export function drawInk(context: CanvasRenderingContext2D, strokes: readonly MarkerStroke[]): void {
  for (const stroke of strokes) {
    context.save()
    if (tipOf(stroke) === "text") {
      const box = labelBox(stroke)
      // The shadow is in device pixels, so it follows the canvas's scale.
      const scale = context.getTransform().a
      context.shadowColor = "rgb(0 0 0 / 30%)"
      context.shadowBlur = 1.5 * scale
      context.shadowOffsetY = scale
      context.fillStyle = stroke.color
      context.beginPath()
      context.roundRect(box.left, box.top, box.width, box.height, box.radius)
      context.fill()
      context.shadowColor = "transparent"
      context.font = labelFont
      context.textBaseline = "middle"
      context.fillStyle = labelInk(stroke.color)
      context.fillText(stroke.text ?? "", box.left + box.padding, stroke.points[0]![1])
    }
    else {
      const marker = tipOf(stroke) === "marker"
      context.globalAlpha = marker ? 0.4 : 1
      context.globalCompositeOperation = marker ? "multiply" : "source-over"
      context.strokeStyle = stroke.color
      context.lineWidth = widthOf(stroke)
      context.lineCap = marker ? "butt" : "round"
      context.lineJoin = "round"
      context.stroke(new Path2D(strokePath(stroke)))
    }
    context.restore()
  }
}

export interface MarkerOptions {
  tip: () => MarkerTip
  color: () => string
  /** Runs after each stroke, each label put down or emptied, and each undo. */
  onChange: () => void
  /** Cmd or Ctrl Enter in a label: the label goes down, and this finishes the Marker. */
  onSubmit?: () => void
}

export interface MarkerSession {
  strokes: () => readonly MarkerStroke[]
  /** Follows a new tip or color: the pointer, and the label being typed takes the color. */
  restyle: () => void
  /** Puts down the label being typed, if any. */
  commit: () => void
  undo: () => void
  /** Stops taking ink and keeps it on the page, where it was drawn, as the page scrolls. */
  freeze: () => void
  remove: () => void
}

type Inked = MarkerStroke & { element: SVGElement }

/**
 * Covers the screen with a layer that takes ink. The page under it gets no pointer events and does not scroll with the
 * wheel or a touch, so the ink stays on what it marks. Shift keeps a marker stroke on its line, takes a pen from point
 * to point, and draws an arrow straight. The text tip types a label where it is clicked; with it, a click on a label
 * edits it and a drag moves it.
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

  const strokes: Inked[] = []
  let current: Inked | undefined
  /** A press with the text tip: on a label it may become a move, elsewhere it places a new one. */
  let press: { label?: Inked, from: Point, at?: Point, moved: boolean, color: string } | undefined
  let editor: { input: HTMLInputElement, stroke: MarkerStroke, label?: Inked } | undefined

  const fitEditor = () => {
    if (!editor) return
    const { input, stroke } = editor
    const box = labelBox({ ...stroke, text: input.value || " " })
    const set = (name: string, value: string) => input.style.setProperty(name, value)
    set("left", `${box.left}px`)
    set("top", `${box.top}px`)
    set("width", `${box.width + 2}px`)
    set("height", `${box.height}px`)
    set("padding", `0 ${box.padding}px`)
    set("border-radius", `${box.radius}px`)
    set("background", stroke.color)
    set("color", labelInk(stroke.color))
  }
  /** Puts the label down: a new one joins the ink when it has words, and an emptied one goes. */
  const commit = () => {
    if (!editor) return
    const { input, stroke, label } = editor
    editor = undefined
    const text = input.value.trim()
    input.remove()
    if (!label) {
      if (!text) return
      strokes.push({ ...stroke, text, element: drawStroke({ ...stroke, text }, svg) })
    }
    else if (!text) strokes.splice(strokes.indexOf(label), 1)[0]?.element.remove()
    else {
      label.text = text
      label.color = stroke.color
      paintLabel(label.element as SVGGElement, label)
      label.element.removeAttribute("visibility")
    }
    options.onChange()
  }
  const edit = (stroke: MarkerStroke, label?: Inked) => {
    const input = document.createElement("input")
    input.type = "text"
    input.maxLength = 200
    input.spellcheck = false
    input.value = stroke.text ?? ""
    input.setAttribute("aria-label", "Label")
    input.setAttribute("enterkeyhint", "done")
    editor = { input, stroke: { ...stroke }, label }
    fitEditor()
    label?.element.setAttribute("visibility", "hidden")
    input.addEventListener("input", fitEditor)
    input.addEventListener("blur", commit)
    layer.append(input)
    input.focus({ preventScroll: true })
    if (label) input.select()
  }
  // While a label is typed, its keys are its own: at the window's capture, before the page's shortcuts and the
  // overlay's Marker keys. Enter or Esc puts it down, and Cmd or Ctrl Enter also finishes.
  const labelKey = (event: KeyboardEvent) => {
    if (!editor || event.composedPath()[0] !== editor.input) return
    event.stopPropagation()
    if (event.isComposing) return
    if (event.key === "PageUp" || event.key === "PageDown") event.preventDefault()
    if (event.key !== "Enter" && event.key !== "Escape") return
    event.preventDefault()
    commit()
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) options.onSubmit?.()
  }
  addEventListener("keydown", labelKey, true)

  const labelAt = (x: number, y: number) => strokes.findLast((stroke) => {
    if (tipOf(stroke) !== "text") return false
    const box = labelBox(stroke)
    return x >= box.left - 4 && x <= box.left + box.width + 4 && y >= box.top - 4 && y <= box.top + box.height + 4
  })
  const restyle = () => {
    layer.style.cursor = tipCursor(options.tip(), options.color())
    if (!editor || editor.stroke.color === options.color()) return
    editor.stroke.color = options.color()
    fitEditor()
  }
  restyle()

  layer.addEventListener("pointerdown", (event) => {
    if (editor && event.composedPath().includes(editor.input)) return
    if (event.button !== 0 || layer.hasAttribute("data-frozen")) return
    event.preventDefault()
    // A press away from the label being typed puts it down, and does nothing else.
    if (editor) return commit()
    layer.setPointerCapture(event.pointerId)
    const tip = options.tip()
    const color = options.color()
    if (tip === "text") {
      const label = labelAt(event.clientX, event.clientY)
      press = { label, from: [event.clientX, event.clientY], at: label?.points[0], moved: false, color }
      return
    }
    const stroke = { tip, color, points: [[event.clientX, event.clientY]] as Point[] }
    current = { ...stroke, element: drawStroke(stroke, svg) }
  })
  layer.addEventListener("pointermove", (event) => {
    if (press) {
      const { label, from, at } = press
      if (!label || !at) return
      const dx = event.clientX - from[0]
      const dy = event.clientY - from[1]
      if (!press.moved && Math.hypot(dx, dy) < 3) return
      press.moved = true
      label.points = [[at[0] + dx, at[1] + dy]]
      paintLabel(label.element as SVGGElement, label)
      return
    }
    if (!current) return
    const next: Point = [event.clientX, event.clientY]
    const first = current.points[0]!
    if (current.tip === "arrow" || event.shiftKey) {
      if (event.shiftKey) current.straight = true
      else delete current.straight
      current.points = [first, current.tip === "marker" && event.shiftKey ? [next[0], first[1]] : next]
    }
    else {
      const last = current.points[current.points.length - 1]!
      if (Math.hypot(next[0] - last[0], next[1] - last[1]) > 2) current.points.push(next)
    }
    current.element.setAttribute("d", strokePath(current))
  })
  const end = (event: PointerEvent) => {
    if (press) {
      const { label, from, moved, color } = press
      press = undefined
      if (event.type === "pointercancel") return
      if (label) {
        if (moved) options.onChange()
        else edit(label, label)
        return
      }
      // The caret goes where the press was: a little after the label's left edge, in its middle.
      return edit({ tip: "text", color, points: [[from[0] - Math.round(markerTips.text.width * 0.45), from[1]]], text: "" })
    }
    if (!current) return
    const stroke = current
    current = undefined
    const from = stroke.points[0]!
    const to = stroke.points[stroke.points.length - 1]!
    // An arrow this short is a slip.
    if (stroke.tip === "arrow" && Math.hypot(to[0] - from[0], to[1] - from[1]) < 10) return stroke.element.remove()
    strokes.push(stroke)
    options.onChange()
  }
  layer.addEventListener("pointerup", end)
  layer.addEventListener("pointercancel", end)
  // The ink is in viewport pixels, so the page must not scroll under it.
  for (const type of ["wheel", "touchmove"]) layer.addEventListener(type, event => event.preventDefault(), { passive: false })

  return {
    strokes: () => strokes.map((inked) => {
      const stroke: MarkerStroke = { tip: inked.tip, color: inked.color, points: inked.points.map(([x, y]): Point => [x, y]) }
      if (inked.straight) stroke.straight = true
      if (inked.text !== undefined) stroke.text = inked.text
      return stroke
    }),
    restyle,
    commit,
    undo() {
      commit()
      strokes.pop()?.element.remove()
      options.onChange()
    },
    freeze() {
      commit()
      host.setAttribute("frozen", "")
      layer.setAttribute("data-frozen", "")
      Object.assign(layer.style, { left: `${scrollX}px`, top: `${scrollY}px`, width: `${innerWidth}px`, height: `${innerHeight}px`, cursor: "" })
    },
    remove() {
      removeEventListener("keydown", labelKey, true)
      if (editor) {
        editor.input.removeEventListener("blur", commit)
        editor = undefined
      }
      host.remove()
    },
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
 * modern-screenshot writes each copied element's computed style on it, about 1 KB per element, and Chromium keeps each
 * SVG image that it decodes until the tab closes: on a page of 3,000 rows, 34 MB per picture. As in Drop's capture, each
 * distinct style becomes one `!important` class in a sheet of the SVG, so the picture is the same and the SVG small.
 */
export function shareStyles(svg: SVGSVGElement): void {
  const names = new Map<string, string | undefined>()
  let rules = ""
  for (const node of svg.querySelectorAll<HTMLElement>("[style]")) {
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || node.closest("defs, symbol")) continue
    const text = node.getAttribute("style")!
    let name = names.get(text)
    if (!names.has(text)) {
      let body: string | undefined = ""
      for (let index = 0; index < node.style.length; index++) {
        const property = node.style.item(index)
        const value = node.style.getPropertyValue(property)
        // A longhand that a shorthand with var() sets has no value of its own, so that style stays on the element.
        if (!value) {
          body = undefined
          break
        }
        body += `${property}:${value}!important;`
      }
      name = body === undefined ? undefined : `_s${names.size.toString(36)}`
      names.set(text, name)
      if (name) rules += `.${name}{${body}}\n`
    }
    if (!name) continue
    node.removeAttribute("style")
    node.classList.add(name)
  }
  const first = svg.firstElementChild
  const sheet = first?.localName === "style" ? first : svg.insertBefore(document.createElement("style"), first)
  sheet.append(rules)
}

/**
 * A screenshot of the screen as the person sees it, without `skip` (the comment UI and the page tools), with the ink
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
      onCreateForeignObjectSvg: shareStyles,
      timeout: 3000,
    })
    const context = canvas.getContext("2d")
    if (!context) return undefined
    context.setTransform(scale, 0, 0, scale, 0, 0)
    drawInk(context, strokes)
    return await new Promise<Blob | undefined>(resolve => canvas.toBlob(blob => resolve(blob ?? undefined), "image/webp", 0.85))
  }
  catch {
    return undefined
  }
  finally {
    pins.release()
  }
}
