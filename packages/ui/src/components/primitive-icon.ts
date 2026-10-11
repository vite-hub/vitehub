import { defineComponent, h, type PropType } from "vue";
import { hasRuntimeType } from "../internal/runtime-type.ts";

type Shape = readonly [tag: "circle" | "path" | "rect", attributes: Readonly<Record<string, number | string>>];

interface PrimitiveIconShape {
  /** Static strokes. */
  readonly base: readonly Shape[];
  /** Strokes that move once on hover or keyboard focus. `styles.css` sets the motion of each icon. */
  readonly motion: readonly Shape[];
}

const rect = (x: number, y: number, width: number, height: number, rx = 1.5): Shape => ["rect", { x, y, width, height, rx }];
const path = (d: string): Shape => ["path", { d }];

/** Square 24px icons, one for each Server Primitive and docs area. Strokes use currentColor. */
export const primitiveIcons = {
  agent: {
    base: [rect(4.5, 9, 15, 11, 3), path("M12 6v3"), ["circle", { cx: 12, cy: 5, r: 1 }]],
    motion: [path("M9.5 13.5v2M14.5 13.5v2")],
  },
  auth: {
    base: [rect(5, 10.5, 14, 10, 2), path("M12 14.5v2")],
    motion: [path("M8 10.5v-3a4 4 0 0 1 8 0v3")],
  },
  blob: {
    base: [path("M5 9.5A1.5 1.5 0 0 1 6.5 8H12l4 4v7.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 5 19.5z"), path("M12 8v4h4")],
    motion: [path("M9 5V4.5A1.5 1.5 0 0 1 10.5 3H16l4 4v8.5a1.5 1.5 0 0 1-1.5 1.5H18")],
  },
  browser: {
    base: [rect(3, 4, 18, 16, 2), path("M3 8.5h18M6 6.25h.01M8.5 6.25h.01")],
    motion: [path("m11 12 5.5 2-2.25 1-1 2.25z")],
  },
  channel: {
    base: [path("M5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 4v-4h-1A1.5 1.5 0 0 1 4 14.5v-9A1.5 1.5 0 0 1 5.5 4z")],
    motion: [path("M8 8.5h8M8 12h5")],
  },
  connection: {
    base: [path("M12 16v5")],
    motion: [path("M9 3v4M15 3v4M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0z")],
  },
  content: {
    base: [rect(5, 3, 14, 18, 2), path("M8.5 7.5h7")],
    motion: [path("M8.5 11.5h7M8.5 15.5h4.5")],
  },
  database: {
    base: [path("M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"), path("M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5")],
    motion: [path("M5 6c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5-3.1 2.5-7 2.5S5 7.4 5 6z")],
  },
  development: {
    base: [path("m8.5 7-5 5 5 5M15.5 7l5 5-5 5")],
    motion: [path("m13.5 5-3 14")],
  },
  email: {
    base: [rect(3, 5.5, 18, 13, 2)],
    motion: [path("m3.5 7.5 8.5 6 8.5-6")],
  },
  env: {
    base: [],
    motion: [["circle", { cx: 8, cy: 16, r: 4 }], path("M10.8 13.2 20 4M17 7l2.5 2.5M14.5 9.5l2 2")],
  },
  hosts: {
    base: [path("m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5l8.5 4.5 8.5-4.5")],
    motion: [path("m12 3.5 8.5 4.5-8.5 4.5L3.5 8z")],
  },
  kv: {
    base: [rect(3, 5, 18, 14, 2), path("M9 5v14M3 12h18")],
    motion: [path("M12.5 8.5h5M12.5 15.5h3.5")],
  },
  queue: {
    base: [path("M16.5 12H21m-2-2.5 2 2.5-2 2.5")],
    motion: [rect(3, 9.5, 5, 5, 1), rect(9.5, 9.5, 5, 5, 1)],
  },
  "rate-limit": {
    base: [path("M3.5 15a8.5 8.5 0 0 1 17 0M6 19h12"), ["circle", { cx: 12, cy: 15, r: 1 }]],
    motion: [path("m12 15 3.5-4.5")],
  },
  realtime: {
    base: [["circle", { cx: 12, cy: 12, r: 1.5 }], path("M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7")],
    motion: [path("M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 5.5a9.2 9.2 0 0 1 0 13")],
  },
  reference: {
    base: [path("M12 6.5c-1.5-1.5-4-2-8-2v13c4 0 6.5.5 8 2")],
    motion: [path("M12 6.5c1.5-1.5 4-2 8-2v13c-4 0-6.5.5-8 2V6.5")],
  },
  sandbox: {
    base: [path("M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8M21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H16M8 21H4.5A1.5 1.5 0 0 1 3 19.5V16")],
    motion: [rect(8.5, 8.5, 7, 7, 1)],
  },
  schedule: {
    base: [rect(3.5, 5, 17, 15.5, 2), path("M3.5 10h17M8 3v4M16 3v4")],
    motion: [rect(7, 13, 3, 3, 0.5)],
  },
  shell: {
    base: [rect(3, 4, 18, 16, 2), path("m7 9.5 3 2.5-3 2.5")],
    motion: [path("M12.5 15h4")],
  },
  source: {
    base: [path("M4 14v4.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V14")],
    motion: [path("M12 3v10M8 9.5l4 4 4-4")],
  },
  start: {
    base: [path("M6 21V3.5")],
    motion: [path("M6 4h11l-2.5 4 2.5 4H6")],
  },
  ui: {
    base: [rect(3.5, 3.5, 7, 7), rect(13.5, 3.5, 7, 7), rect(3.5, 13.5, 7, 7)],
    motion: [rect(13.5, 13.5, 7, 7)],
  },
  usage: {
    base: [path("M4 19h16")],
    motion: [rect(6, 10, 3, 6, 0.5), rect(10.5, 5, 3, 11, 0.5), rect(15, 8, 3, 8, 0.5)],
  },
  workflow: {
    base: [rect(3, 3, 6, 6), rect(3, 15, 6, 6), path("M9 6h2.5a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9M12.5 12H15")],
    motion: [rect(15, 9, 6, 6)],
  },
  workspace: {
    base: [path("M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z")],
    motion: [path("M3 11.5h18")],
  },
} as const satisfies Record<string, PrimitiveIconShape>;

export type PrimitiveIconName = keyof typeof primitiveIcons;

export function isPrimitiveIconName(value: unknown): value is PrimitiveIconName {
  return hasRuntimeType(value, "string") && Object.hasOwn(primitiveIcons, value);
}

export const primitiveIconNames: readonly PrimitiveIconName[] = Object.keys(primitiveIcons).filter(isPrimitiveIconName);

const shapes = (list: readonly Shape[]) => list.map(([tag, attributes]) => h(tag, attributes));

export const PrimitiveIcon = defineComponent({
  name: "PrimitiveIcon",
  props: {
    name: {
      required: true,
      // SAFETY: Vue's runtime String constructor is paired with the closed icon name union.
      type: String as PropType<PrimitiveIconName>,
    },
  },
  setup(props) {
    return () => {
      const icon = primitiveIcons[props.name];
      return h("svg", {
        "aria-hidden": "true",
        class: "vh-primitive-icon",
        "data-icon": props.name,
        fill: "none",
        stroke: "currentColor",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "stroke-width": 1.5,
        viewBox: "0 0 24 24",
        xmlns: "http://www.w3.org/2000/svg",
      }, [...shapes(icon.base), h("g", { class: "vh-primitive-icon__motion" }, shapes(icon.motion))]);
    };
  },
});
