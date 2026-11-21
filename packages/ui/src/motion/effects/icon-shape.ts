const svgNamespace = "http://www.w3.org/2000/svg";
const geometry = new Map([
  ["path", ["d"]],
  ["line", ["x1", "y1", "x2", "y2"]],
  ["polyline", ["points"]],
  ["polygon", ["points"]],
  ["circle", ["cx", "cy", "r"]],
  ["ellipse", ["cx", "cy", "rx", "ry"]],
  ["rect", ["x", "y", "width", "height", "rx", "ry"]],
]);
const shapeSelector = [...geometry.keys()].join(", ");

/**
 * The shapes of one icon, which an effect changes for a while and then puts back: a check that draws its stroke, a
 * bookmark that wobbles. It reads both ways that our icons render: an inline `<svg>` (`@iconify/vue`, Lucide, kit), and
 * an Iconify CSS icon (`@nuxt/icon` in CSS mode), a `<span>` that draws the SVG of its `--svg` property as a mask.
 */
export interface IconShape {
  /** The shapes of the icon. For a CSS icon they belong to a copy of its SVG, which `commit()` draws. */
  shapes: SVGGeometryElement[];
  /** Sets an attribute of a shape. The first call keeps the value it replaces, for `restore()`. */
  set(shape: SVGGeometryElement, name: string, value: string): void;
  /** Shows the attributes set since the last commit. An inline icon shows them at once. */
  commit(): void;
  /** Puts back every attribute that `set` changed, byte for byte, and the mask of a CSS icon. */
  restore(): void;
  /** Runs `read` while the shapes are in the page, so `getTotalLength()` and `getBBox()` work. */
  measure<T>(read: (shapes: SVGGeometryElement[]) => T): T;
}

/** The icons inside an element: inline `<svg>` elements, and Iconify CSS icons. */
export function findIcons(element: Element): Array<HTMLElement | SVGSVGElement> {
  const icons: Array<HTMLElement | SVGSVGElement> = [];
  for (const node of element.querySelectorAll<HTMLElement | SVGSVGElement>("svg, .iconify")) {
    if (node instanceof SVGSVGElement && node.parentElement?.closest("svg")) continue;
    if (node instanceof SVGSVGElement || cssIconSource(node)) icons.push(node);
  }
  return icons;
}

// The SVG markup of an Iconify CSS icon, from `--svg: url("data:image/svg+xml,...")`.
function cssIconSource(element: Element): string | undefined {
  const value = getComputedStyle(element).getPropertyValue("--svg").trim();
  const url = /^url\(\s*(["']?)(.*)\1\s*\)$/s.exec(value)?.[2];
  if (!url?.startsWith("data:image/svg+xml")) return;
  const comma = url.indexOf(",");
  const data = url.slice(comma + 1);
  try {
    return url.slice(0, comma).endsWith(";base64") ? atob(data) : decodeURIComponent(data);
  }
  catch {
    return undefined;
  }
}

function editor(shapes: SVGGeometryElement[]) {
  const originals = new Map<SVGGeometryElement, Map<string, string | null>>();
  return {
    set(shape: SVGGeometryElement, name: string, value: string) {
      let kept = originals.get(shape);
      if (!kept) originals.set(shape, (kept = new Map()));
      if (!kept.has(name)) kept.set(name, shape.getAttribute(name));
      shape.setAttribute(name, value);
    },
    putBack() {
      for (const [shape, kept] of originals) {
        for (const [name, value] of kept) {
          if (value === null) shape.removeAttribute(name);
          else shape.setAttribute(name, value);
        }
      }
      originals.clear();
    },
    shapes,
  };
}

/** The shapes of an icon from `findIcons`, or undefined when it has none. */
export function iconShape(icon: HTMLElement | SVGSVGElement): IconShape | undefined {
  if (icon instanceof SVGSVGElement) {
    const { set, putBack, shapes } = editor([...icon.querySelectorAll<SVGGeometryElement>(shapeSelector)]);
    if (!shapes.length) return;
    return { shapes, set, commit() {}, restore: putBack, measure: read => read(shapes) };
  }
  const source = cssIconSource(icon);
  if (!source) return;
  const svg = new DOMParser().parseFromString(source, "image/svg+xml").documentElement;
  if (!(svg instanceof SVGSVGElement)) return;
  if (svg.matches("[style], [class], [transform]")) return;
  const copies: SVGGeometryElement[] = [];
  const originals: SVGGeometryElement[] = [];
  for (const child of svg.children) {
    const attributes = geometry.get(child.localName);
    if (!attributes || !(child instanceof SVGGeometryElement) || child.childElementCount || child.matches("[style], [class], [transform]")) return;
    const copy = document.createElementNS(svgNamespace, child.localName);
    if (!(copy instanceof SVGGeometryElement)) return;
    for (const name of attributes) {
      const value = child.getAttribute(name);
      if (value !== null) copy.setAttribute(name, value);
    }
    copies.push(copy);
    originals.push(child);
  }
  if (!copies.length) return;
  const { set, putBack, shapes } = editor(originals);
  const readMask = () => ({ value: icon.style.getPropertyValue("--svg"), priority: icon.style.getPropertyPriority("--svg") });
  const original = readMask();
  let written: ReturnType<typeof readMask> | undefined;
  const matchesMask = (expected: ReturnType<typeof readMask>) => {
    const current = readMask();
    return expected.value === current.value && expected.priority === current.priority;
  };
  return {
    shapes,
    set,
    commit() {
      if (!matchesMask(written ?? original)) return;
      icon.style.setProperty("--svg", `url("data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}")`, original.priority);
      written = readMask();
    },
    restore() {
      putBack();
      if (written && matchesMask(written)) {
        const { value, priority } = original;
        if (value) icon.style.setProperty("--svg", value, priority);
        else icon.style.removeProperty("--svg");
      }
      written = undefined;
    },
    measure(read) {
      const host = document.createElementNS(svgNamespace, "svg");
      host.setAttribute("aria-hidden", "true");
      host.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden";
      host.append(...copies);
      document.body.append(host);
      try {
        return read(copies);
      }
      finally {
        host.remove();
      }
    },
  };
}
