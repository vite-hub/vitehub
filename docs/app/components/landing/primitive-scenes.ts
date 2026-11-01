// Pixel scenes of the Server Primitives, for the landing grid, the docs catalog, and the README.
// One pixel is 2 by 2 units of the 58 by 40 view box, so a scene is 29 pixels wide and 20 pixels high.
// Each scene loops one call to its primitive and rests on the result between calls.
// The 2 by 2 pixel token is the same call in every scene. `PrimitiveMotion.vue` holds the motion.

type Cell = readonly [x: number, y: number];

interface ScenePixels {
  readonly class: string;
  readonly cells: readonly Cell[];
}

interface SceneGroup {
  readonly class: string;
  readonly children: readonly SceneNode[];
  /** Fades the group out in pixel steps at the top and bottom edges of the scene. */
  readonly fade?: true;
}

type SceneNode = ScenePixels | SceneGroup;

export interface PrimitiveScene {
  /** Loop length in milliseconds. Long rests keep the grid quiet. */
  readonly cycle: number;
  readonly nodes: readonly SceneNode[];
}

const rect = (x: number, y: number, width: number, height: number): Cell[] => {
  const cells: Cell[] = [];
  for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) cells.push([column, row]);
  return cells;
};

const hline = (x: number, y: number, width: number) => rect(x, y, width, 1);
const vline = (x: number, y: number, height: number) => rect(x, y, 1, height);

/** A one pixel outline. Rounded boxes leave out their corner pixels. */
const box = (x: number, y: number, width: number, height: number, corners: "round" | "square" = "round"): Cell[] => {
  const inset = corners === "round" ? 1 : 0;
  return [
    ...hline(x + inset, y, width - inset * 2),
    ...hline(x + inset, y + height - 1, width - inset * 2),
    ...vline(x, y + 1, height - 2),
    ...vline(x + width - 1, y + 1, height - 2),
  ];
};

/** Every other pixel of a shape, for dashed lines and boundaries. */
const dashed = (cells: readonly Cell[]) => cells.filter(([x, y]) => (x + y) % 2 === 0);

/** A straight line between two pixels. */
const line = (x0: number, y0: number, x1: number, y1: number): Cell[] => {
  const cells: Cell[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  for (let x = x0, y = y0; ; ) {
    cells.push([x, y]);
    if (x === x1 && y === y1) return cells;
    const doubled = error * 2;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
  }
};

/** Pixels drawn as text. `#` is a pixel. */
const art = (x: number, y: number, rows: readonly string[]): Cell[] =>
  rows.flatMap((row, dy) => [...row].flatMap((pixel, dx): Cell[] => (pixel === "#" ? [[x + dx, y + dy]] : [])));

const ring5 = [".###.", "#...#", "#...#", "#...#", ".###."];
const ring7 = ["..###..", ".#...#.", "#.....#", "#.....#", "#.....#", ".#...#.", "..###.."];
const ring13 = [
  "....#####....",
  "..##.....##..",
  ".#.........#.",
  ".#.........#.",
  "#...........#",
  "#...........#",
  "#...........#",
  "#...........#",
  "#...........#",
  ".#.........#.",
  ".#.........#.",
  "..##.....##..",
  "....#####....",
];

const px = (className: string, ...shapes: readonly Cell[][]): ScenePixels => ({ class: className, cells: shapes.flat() });
const g = (className: string, ...children: readonly SceneNode[]): SceneGroup => ({ class: className, children });
const token = (className: string, x: number, y: number) => px(`token a ${className}`, rect(x, y, 2, 2));

/** A card hides the cards behind it: its inside takes the tile background. */
const card = (x: number, y: number, width: number, height: number, className = "") =>
  g(className, px("card-fill", rect(x + 1, y + 1, width - 2, height - 2)), px("card", box(x, y, width, height)));

/** Rows of the tree that Workspace and Source share. */
const tree = (rows: readonly number[]) => [
  ...box(0, 2, 4, 3, "square"),
  ...vline(1, 5, Math.max(...rows) - 4),
  ...rows.flatMap((row) => hline(2, row, 2)),
];

export const primitiveScenes: Readonly<Record<string, PrimitiveScene>> = {
  // The Agent tile spans two cells, so the scene uses the wider canvas.
  agent: {
    cycle: 6000,
    nodes: [
      px("line", box(0, 7, 6, 6), box(8, 6, 6, 8, "square"), box(19, 2, 5, 5), box(19, 8, 5, 5), box(19, 14, 5, 5)),
      px("link", hline(6, 10, 2), line(14, 8, 18, 4), hline(14, 10, 5), line(14, 12, 18, 16)),
      px("soft", rect(2, 9, 2, 2)),
      px("ink a ag-run", rect(10, 9, 2, 2)),
      px("soft a ag-tool-1", rect(21, 4, 1, 1)),
      px("soft a ag-tool-2", rect(21, 10, 1, 1)),
      px("soft a ag-tool-3", rect(21, 16, 1, 1)),
      token("ag-call", 5, 9),
      token("ag-call-1", 13, 7),
      token("ag-call-2", 13, 9),
      token("ag-call-3", 13, 11),
    ],
  },

  env: {
    cycle: 5000,
    nodes: [
      px("soft", hline(0, 5, 5), hline(0, 10, 5), hline(0, 15, 5)),
      px("soft a env-value-1", hline(7, 5, 10)),
      px("soft a env-value-2", hline(7, 10, 7)),
      px("soft a env-value-3", hline(7, 15, 12)),
      px("ink a env-check-1", art(20, 4, ["...#", "#.#.", ".#.."])),
      px("ink a env-check-2", art(20, 9, ["...#", "#.#.", ".#.."])),
      px("ink a env-check-3", art(20, 14, ["...#", "#.#.", ".#.."])),
    ],
  },

  ui: {
    cycle: 5000,
    nodes: [
      px("line", box(0, 3, 21, 14), hline(1, 6, 19)),
      px("command", rect(2, 4, 1, 1), rect(4, 4, 1, 1)),
      px("soft", hline(3, 9, 9), hline(3, 11, 6)),
      px("soft a ui-panel", rect(15, 9, 4, 4)),
      token("ui-token", 23, 10),
    ],
  },

  logs: {
    cycle: 5000,
    nodes: [
      px("line", box(0, 3, 23, 14), vline(14, 4, 12)),
      px("line", hline(2, 6, 2), hline(5, 6, 7), hline(2, 9, 2), hline(5, 9, 7), hline(2, 12, 2), hline(5, 12, 7)),
      px("soft", rect(1, 8, 13, 3)),
      px("line", hline(16, 6, 4), hline(16, 8, 3), hline(16, 10, 4), hline(16, 12, 2)),
    ],
  },

  auth: {
    cycle: 5000,
    nodes: [
      px("ink a auth-shackle", art(2, 4, [".####.", "#....#", "#....#", "#....#", "#....#"])),
      px("line", box(0, 9, 10, 8)),
      px("ink", rect(4, 11, 2, 3)),
      px("soft a auth-session", art(15, 11, [".#####.", "#######", ".#####."])),
      token("auth-token", 12, 11),
    ],
  },

  connections: {
    cycle: 6000,
    nodes: [
      px("link", line(7, 8, 15, 4), hline(16, 4, 2), hline(7, 10, 11), line(7, 12, 15, 16), hline(16, 16, 2)),
      px("line", box(0, 7, 7, 7), art(18, 2, ring5), art(18, 8, ring5), art(18, 14, ring5)),
      px("soft", rect(2, 9, 3, 3)),
      px("soft a conn-service-1", rect(20, 4, 1, 1)),
      px("soft a conn-service-2", rect(20, 10, 1, 1)),
      px("soft a conn-service-3", rect(20, 16, 1, 1)),
      token("conn-call-1", 6, 7),
      token("conn-call-2", 6, 9),
      token("conn-call-3", 6, 11),
    ],
  },

  "rate-limit": {
    cycle: 5000,
    nodes: [
      px("budget a rl-budget-3", rect(0, 6, 2, 8)),
      px("budget a rl-budget-2", rect(4, 6, 2, 8)),
      px("budget a rl-budget-1", rect(8, 6, 2, 8)),
      px("line", vline(12, 5, 10)),
      px("ink ghost a rl-gate", vline(12, 5, 10)),
      token("rl-request", 22, 9),
    ],
  },

  kv: {
    cycle: 5400,
    nodes: [
      {
        class: "",
        fade: true,
        // The value widths repeat every three rows, so the strip loops after three entries.
        children: [
          g("a kv-strip", px("soft", ...[1, 2, 3, 4, 5, 6, 7].flatMap((row) => [
            rect(0, row * 4 - 1, 4, 2),
            rect(6, row * 4 - 1, [12, 8, 10][(row - 1) % 3] ?? 12, 2),
          ]))),
        ],
      },
    ],
  },

  database: {
    cycle: 5000,
    nodes: [
      px("line", box(0, 3, 20, 14), hline(1, 6, 18), vline(5, 7, 9)),
      px("band a db-band", rect(1, 7, 18, 3)),
      px("soft", hline(2, 8, 2), hline(2, 11, 2), hline(2, 14, 2), hline(7, 8, 11), hline(7, 14, 12)),
      px("soft a db-match", hline(7, 11, 9)),
      token("db-token", 23, 10),
    ],
  },

  blob: {
    cycle: 5000,
    nodes: [
      // Cards move back one slot per upload. The stack returns to its start on the last frame.
      g(
        "a blob-stack",
        card(4, 3, 8, 10, "a blob-last"),
        card(2, 5, 8, 10),
        card(0, 7, 8, 10),
        g("a blob-front", px("soft", hline(2, 9, 4), hline(2, 11, 3), hline(2, 14, 5)), px("ink a blob-progress", hline(2, 14, 5))),
        g("a blob-next", card(-2, 9, 8, 10), px("soft", hline(0, 11, 4), hline(0, 13, 3), hline(0, 16, 5))),
      ),
    ],
  },

  workspace: {
    cycle: 5000,
    nodes: [
      px("line", tree([8, 11, 14])),
      px("soft", hline(5, 8, 11), hline(5, 11, 8)),
      px("soft a ws-file", hline(5, 14, 13)),
      token("ws-token", 1, 5),
    ],
  },

  source: {
    cycle: 4000,
    nodes: [
      px("line", tree([7, 11, 15])),
      px("soft", hline(5, 7, 6), hline(5, 11, 5)),
      px("line a src-mount", art(5, 14, ["##..", "####", "####"])),
      px("line", dashed(hline(10, 15, 7))),
      px("line", art(18, 6, ["######..", "#....##.", "#....#.#", "#....###", "#......#", "#......#", "#......#", "#......#", "#......#", "#......#", "########"])),
      px("soft", hline(20, 10, 4), hline(20, 12, 3)),
      token("src-flow", 17, 14),
      token("src-flow src-flow-late", 17, 14),
    ],
  },

  content: {
    cycle: 5600,
    nodes: [
      px("line", box(0, 3, 13, 14)),
      px("command", hline(2, 5, 6)),
      px("soft a ct-line-1", hline(2, 8, 9)),
      px("soft a ct-line-2", hline(2, 11, 7)),
      px("soft a ct-line-3", hline(2, 14, 8)),
      g("a ct-lens", px("lens", rect(9, 7, 3, 3)), px("ink", art(8, 6, [".###.", "#...#", "#...#", "#...#", ".###."]), line(12, 10, 13, 11))),
    ],
  },

  queue: {
    cycle: 3600,
    nodes: [
      px("line", hline(0, 10, 20), box(20, 6, 6, 8)),
      px("soft a q-worker", rect(22, 8, 2, 4)),
      g("a q-belt", px("job a q-in", rect(-3, 9, 3, 3)), px("job", rect(3, 9, 3, 3), rect(9, 9, 3, 3)), px("job a q-out", rect(15, 9, 3, 3))),
    ],
  },

  workflow: {
    cycle: 5600,
    nodes: [
      px("line", hline(5, 10, 6), hline(16, 10, 6), art(0, 8, ring5), art(11, 8, ring5), art(22, 8, ring5)),
      px("ink a wf-rail-1", hline(5, 10, 6)),
      px("ink a wf-rail-2", hline(16, 10, 6)),
      px("ink a wf-step-1", rect(2, 10, 1, 1)),
      px("ink a wf-step-2", rect(13, 10, 1, 1)),
      px("ink a wf-step-3", rect(24, 10, 1, 1)),
    ],
  },

  schedule: {
    cycle: 5000,
    nodes: [
      px("line", art(0, 4, ring13), line(7, 11, 8, 12)),
      // The hand turns in four pixel frames: up, right, down, and left.
      px("ink a sch-hand-1", vline(6, 6, 4)),
      px("ink ghost a sch-hand-2", hline(7, 10, 4)),
      px("ink ghost a sch-hand-3", vline(6, 11, 4)),
      px("ink ghost a sch-hand-4", hline(2, 10, 4)),
      px("ink", rect(6, 10, 1, 1)),
      px("ink ghost a sch-ring", art(0, 4, ring13)),
      px("line", hline(15, 10, 12)),
      g("a sch-runs", px("soft a sch-fired", rect(17, 9, 2, 2)), px("soft", rect(21, 9, 2, 2), rect(25, 9, 2, 2)), px("soft a sch-next", rect(29, 9, 2, 2))),
    ],
  },

  sandbox: {
    cycle: 4400,
    nodes: [
      px("line", dashed(box(0, 3, 15, 15))),
      px("ink ghost a sb-wall", vline(14, 4, 13)),
      px("soft a sb-process", rect(6, 9, 3, 3)),
      token("sb-token", 9, 9),
      px("soft", rect(19, 7, 6, 6)),
    ],
  },

  browser: {
    cycle: 5000,
    nodes: [
      px("line", box(0, 3, 24, 14), hline(1, 5, 22)),
      px("command", rect(2, 4, 1, 1), rect(4, 4, 1, 1), rect(6, 4, 1, 1)),
      px("soft", hline(2, 8, 9), hline(2, 10, 6)),
      px("soft a br-button", rect(14, 12, 7, 3)),
      px("pointer a br-cursor", art(6, 12, ["#..", "##.", "###", "##."])),
    ],
  },

  shell: {
    cycle: 4400,
    nodes: [
      px("line", box(0, 3, 26, 14)),
      px("ink", art(2, 6, ["#.", ".#", "#."])),
      px("command a sh-command", hline(6, 7, 10)),
      px("ink a sh-cursor", vline(16, 6, 3)),
      px("soft a sh-output-1", hline(2, 11, 16)),
      px("soft a sh-output-2", hline(2, 13, 11)),
    ],
  },

  email: {
    cycle: 4400,
    nodes: [
      px("line", box(0, 6, 10, 8), line(1, 7, 4, 10), line(5, 10, 8, 7)),
      px("line", dashed(hline(12, 10, 3))),
      px("line", box(17, 7, 9, 7, "square"), hline(17, 11, 3), hline(20, 12, 3), hline(23, 11, 3)),
      px("ink ghost a mail-unread", rect(25, 6, 2, 2)),
      token("mail-token", 9, 9),
    ],
  },

  channels: {
    cycle: 4800,
    nodes: [
      px("line", art(0, 7, ring7), dashed(hline(7, 10, 4)), dashed(hline(14, 10, 5)), box(19, 6, 6, 8)),
      px("soft a ch-message", rect(11, 7, 3, 6)),
      px("soft", hline(21, 9, 2), hline(21, 11, 1)),
      token("ch-token", 2, 9),
    ],
  },

  realtime: {
    cycle: 6000,
    nodes: [
      px("line", box(0, 3, 18, 14)),
      px("soft", hline(2, 6, 13), hline(2, 9, 10), hline(2, 12, 12), hline(2, 15, 7)),
      px("ink a rt-caret-a", vline(15, 5, 3)),
      px("command a rt-caret-b", vline(9, 14, 3)),
      px("ink", rect(21, 6, 2, 2)),
      px("command", rect(21, 9, 2, 2)),
    ],
  },

  gateways: {
    cycle: 5600,
    nodes: [
      px("line", box(0, 3, 5, 5), box(0, 12, 5, 5), box(10, 6, 6, 8, "square"), art(21, 8, ring5)),
      px("link", line(5, 5, 9, 9), line(5, 14, 9, 10), hline(16, 10, 5)),
      px("soft a gw-route", rect(12, 9, 2, 2)),
      px("soft a gw-model", rect(23, 10, 1, 1)),
      token("gw-in-1", 4, 4),
      token("gw-in-2", 4, 14),
      token("gw-out", 15, 9),
    ],
  },

  cms: {
    cycle: 5000,
    nodes: [
      px("line", box(0, 3, 14, 14)),
      px("command", hline(2, 5, 6)),
      px("soft", hline(2, 8, 10), hline(2, 11, 7)),
      px("soft a cms-edit", hline(2, 14, 9)),
      px("line", box(19, 5, 8, 10)),
      px("soft a cms-page", hline(21, 8, 4), hline(21, 10, 3), hline(21, 12, 4)),
      token("cms-token", 14, 9),
    ],
  },

  comments: {
    cycle: 5000,
    nodes: [
      px("line", box(0, 5, 17, 12)),
      px("soft", hline(2, 8, 12), hline(2, 14, 8)),
      px("soft a cm-mark", hline(2, 11, 10)),
      g("a cm-bubble", card(15, 1, 11, 7), px("soft", hline(17, 3, 6), hline(17, 5, 4)), px("card", art(16, 8, ["#.", "##"]))),
    ],
  },
};

/** SVG path data for a set of pixels. Each row of neighboring pixels becomes one rectangle. */
function pixelPath(cells: readonly Cell[]): string {
  const rows = new Map<number, Set<number>>();
  for (const [x, y] of cells) rows.set(y, (rows.get(y) ?? new Set()).add(x));
  let path = "";
  for (const [y, columns] of [...rows].sort(([a], [b]) => a - b)) {
    const sorted = [...columns].sort((a, b) => a - b);
    for (let index = 0; index < sorted.length; index++) {
      const start = sorted[index] ?? 0;
      let end = start;
      while (sorted[index + 1] === end + 1) {
        end++;
        index++;
      }
      const width = (end - start + 1) * 2;
      path += `M${start * 2} ${y * 2}h${width}v2h-${width}z`;
    }
  }
  return path;
}

function renderNode(node: SceneNode, id: string): string {
  const classAttribute = node.class ? ` class="${node.class}"` : "";
  if ("cells" in node) return `<path${classAttribute} d="${pixelPath(node.cells)}"/>`;
  const mask = node.fade ? ` mask="url(#${id}-fade)"` : "";
  return `<g${classAttribute}${mask}>${node.children.map((child) => renderNode(child, id)).join("")}</g>`;
}

// The fade steps one pixel row at a time, so the edge stays on the grid.
const fadeRows = [0.25, 0.5, 0.75];

/** Returns the inner markup of a scene. `id` keeps mask ids unique when several scenes share a page. */
export function renderPrimitiveScene(name: string, id: string): string {
  const scene = primitiveScenes[name];
  if (!scene) return "";
  const nodes = scene.nodes.map((node) => renderNode(node, id)).join("");
  if (!scene.nodes.some((node) => !("cells" in node) && node.fade)) return nodes;
  const bands = fadeRows.map((opacity, index) =>
    `<rect y="${4 + index * 2}" width="58" height="2" fill="#fff" fill-opacity="${opacity}"/><rect y="${34 - index * 2}" width="58" height="2" fill="#fff" fill-opacity="${opacity}"/>`).join("");
  return `<defs><mask id="${id}-fade" maskUnits="userSpaceOnUse" x="-8" y="0" width="74" height="40">${bands}<rect x="-8" y="10" width="74" height="20" fill="#fff"/></mask></defs>${nodes}`;
}
