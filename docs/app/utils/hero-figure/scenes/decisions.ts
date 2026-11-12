// Decisions: a person types what they want in a shop's search box. resolve() turns the sentence into choices from the
// shop's own options: a color, a category, and a sort order. Only listed options can be picked. The product grid
// then filters and sorts with that selection.
import { defineScene, clamp, lerp, snap, rng, fs, icon, h, q, qa, prog, cls, put } from "../engine";

type Group = "color" | "category" | "sort";
type Color = "black" | "white" | "red" | "blue";
/** The options that a query includes ("in") or excludes ("ex") in each group. */
type Selection = Partial<Record<Group, { in?: string[]; ex?: string[] }>>;
interface Query {
  text: string;
  sel: Selection;
}
/** [time, group, option, mode] */
type Pick = [number, Group, string, "in" | "ex"];
interface DecisionsPlan {
  len: number;
  end: number;
  q: Query;
  type0: number;
  type1: number;
  ask: number;
  got: number;
  picks: Pick[];
  apply: number;
  done: number;
  hits: number[];
  order: number[];
}

const GROUPS: [Group, string, string[]][] = [
  ["color", "Color", ["black", "white", "red", "blue"]],
  ["category", "Category", ["running", "hiking", "tennis"]],
  ["sort", "Sort", ["Newest", "Price: low", "Price: high"]],
];
const HUE: Record<Color, string> = { black: "#262626", white: "#fafafa", red: "#dc2626", blue: "#2563eb" };
// [name, color, category, price]. The array order is newest first.
const SHOES: [string, Color, string, number][] = [["Glide", "red", "running", 59], ["Trek", "white", "hiking", 79], ["Ace", "white", "tennis", 70], ["Pace", "red", "running", 45], ["Summit", "black", "hiking", 89], ["Swift", "blue", "running", 65], ["Volley", "blue", "tennis", 68], ["Ridge", "red", "hiking", 95]];
const QUERIES: Query[] = [
  { text: "red running shoes, cheapest first", sel: { color: { in: ["red"] }, category: { in: ["running"] }, sort: { in: ["Price: low"] } } },
  { text: "hiking shoes, not black, newest first", sel: { category: { in: ["hiking"] }, color: { ex: ["black"] }, sort: { in: ["Newest"] } } },
  { text: "blue or white tennis shoes", sel: { color: { in: ["blue", "white"] }, category: { in: ["tennis"] } } },
  { text: "something for running, priciest first", sel: { category: { in: ["running"] }, sort: { in: ["Price: high"] } } },
];

const css = `.vh-hero-decisions svg.icon{position:static;inset:auto;width:auto;height:auto}.vh-hero-decisions svg.icon path{fill:inherit;stroke:inherit;stroke-width:inherit;stroke-dasharray:none;vector-effect:none}
.vh-hero-decisions .d-root{position:absolute;inset:0;display:grid;grid-template-columns:40% 1fr;grid-template-rows:38px 1fr;column-gap:28px;row-gap:16px}
.vh-hero-decisions .d-box{grid-column:1/-1;display:flex;align-items:center;gap:9px;padding:0 6px 0 12px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);font-size:14px;transition:box-shadow 300ms ease;min-width:0}
.vh-hero-decisions .d-box.on{box-shadow:inset 0 0 0 1px var(--fg)}
.vh-hero-decisions .d-box>svg{color:var(--muted)}
.vh-hero-decisions .d-q{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vh-hero-decisions .d-ph{color:var(--dim)}
.vh-hero-decisions .d-caret{display:inline-block;width:1px;height:16px;margin-left:1px;vertical-align:-3px;background:var(--fg);animation:dcblink 900ms steps(1) infinite}
@keyframes dcblink{50%{opacity:0}}
.vh-hero-decisions .d-pill{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:99px;background:var(--fg);color:transparent;font:11px/1 var(--mono);white-space:nowrap;clip-path:inset(calc(50% - 4px) calc(50% - 4px) round 99px);opacity:0;transition:clip-path 550ms cubic-bezier(.65,0,.35,1) 80ms,color 120ms ease-out,background-color 300ms ease,opacity 250ms ease}
.vh-hero-decisions .d-pill.vis{opacity:1}
.vh-hero-decisions .d-pill.open{color:var(--bg);clip-path:inset(0 round 99px);transition:clip-path 650ms cubic-bezier(.65,0,.35,1),color 250ms ease-out 350ms,background-color 300ms ease,opacity 250ms ease}
.vh-hero-decisions .d-pill.ok{background:var(--ok)}
.vh-hero-decisions .d-groups{display:flex;flex-direction:column;justify-content:space-between;min-width:0;padding:2px 0}
.vh-hero-decisions .d-g{display:flex;flex-direction:column;gap:6px}
.vh-hero-decisions .d-gl{font:11px var(--mono);color:var(--muted)}
.vh-hero-decisions .d-opts{display:flex;flex-wrap:wrap;gap:5px}
.vh-hero-decisions .d-o{padding:3px 9px;border-radius:99px;box-shadow:inset 0 0 0 1px var(--line);font-size:12px;color:var(--muted);white-space:nowrap;transition:background-color 300ms ease,color 300ms ease,box-shadow 300ms ease,transform 300ms cubic-bezier(.34,1.56,.64,1)}
.vh-hero-decisions .d-o.in{background:var(--fg);color:var(--bg);box-shadow:none;transform:scale(1.04)}
.vh-hero-decisions .d-o.ex{color:var(--err);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--err) 45%,transparent);text-decoration:line-through}
.vh-hero-decisions .d-grid{position:relative;min-width:0}
.vh-hero-decisions .d-t{position:absolute;left:0;top:0;width:calc((100% - 24px)/4);height:calc((100% - 8px)/2);padding:9px 10px;border-radius:9px;box-shadow:inset 0 0 0 1px var(--line);display:flex;flex-direction:column;justify-content:space-between;will-change:transform;transition:opacity 350ms ease,box-shadow 300ms ease}
.vh-hero-decisions .d-t.off{opacity:.28}
.vh-hero-decisions .d-t.hit{box-shadow:inset 0 0 0 1px var(--fg)}
.vh-hero-decisions .d-sw{width:100%;height:22px;border-radius:6px;background:var(--soft);display:flex;align-items:center;justify-content:center}
.vh-hero-decisions .d-sw i{width:12px;height:12px;border-radius:99px;box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--fg) 25%,transparent)}
.vh-hero-decisions .d-n{font-size:12.5px;font-weight:500;white-space:nowrap}
.vh-hero-decisions .d-c{display:flex;justify-content:space-between;font:11px var(--mono);color:var(--muted)}
.vh-hero-decisions .d-c b{font-weight:500;color:var(--fg);font-variant-numeric:tabular-nums}
@container (max-width:640px){
 .vh-hero-decisions .d-root{column-gap:18px}
 .vh-hero-decisions .d-t{padding:8px 6px}
 .vh-hero-decisions .d-c{gap:4px;font-size:10.5px}
}
@container (max-width:560px){
 .vh-hero-decisions .d-root{grid-template-columns:1fr;grid-template-rows:34px auto 1fr;row-gap:10px}
 .vh-hero-decisions .d-box{font-size:12.5px;padding:0 4px 0 10px}
 .vh-hero-decisions .d-groups{gap:5px}
 .vh-hero-decisions .d-g{flex-direction:row;align-items:center;gap:6px}
 .vh-hero-decisions .d-gl{width:58px;flex-shrink:0;font-size:10px}
 .vh-hero-decisions .d-opts{gap:4px;flex-wrap:nowrap}
 .vh-hero-decisions .d-o{padding:2px 7px;font-size:11px}
 .vh-hero-decisions .d-t{padding:5px 6px;gap:2px}
 .vh-hero-decisions .d-sw{height:14px}.vh-hero-decisions .d-sw i{width:9px;height:9px}
 .vh-hero-decisions .d-n{font-size:11px}
 .vh-hero-decisions .d-c span{display:none}
}`;

export default defineScene<DecisionsPlan>({
  css,
  key: "decisions",
  name: "Decisions",
  label: "A shop has a search box with filters for color, category, and sort order. A person types a sentence such as red running shoes, cheapest first. The server calls resolve with the text. The answer picks options from the lists only: red, running, and price low to high. The product grid then shows the matching shoes in that order.",
  H: 250,
  steps: [
    "A person types what they want in plain words.",
    "Your route calls resolve(text). The model answers fixed questions about your options.",
    "Each choice is one of your options. The model cannot invent a value.",
    "onSelect applies the selection to your filters. The grid shows the match.",
  ],
  summary: "A sentence becomes choices from the shop's own options, and the product grid filters and sorts with them.",
  plan(k) {
    const r = rng(k + 6006);
    const query = QUERIES[k % QUERIES.length]!;
    const j = () => snap(r() * 300);
    const type0 = 600, type1 = type0 + query.text.length * 55, ask = type1 + 450, got = ask + 1300 + j();
    const picks: Pick[] = [];
    let at = got + 200;
    for (const [g, , opts] of GROUPS) for (const o of opts) {
      const s = query.sel[g];
      if (s?.in?.includes(o)) { picks.push([at, g, o, "in"]); at += 380 }
      if (s?.ex?.includes(o)) { picks.push([at, g, o, "ex"]); at += 380 }
    }
    const apply = at + 500, done = apply + 1100;
    // The grid order after the selection: matches first, sorted, then the rest in their old order.
    const c = query.sel.color, cat = query.sel.category;
    const m = ([, color, category]: (typeof SHOES)[number]) => (!c?.in || c.in.includes(color)) && !(c?.ex ?? []).includes(color) && (!cat?.in || cat.in.includes(category));
    const price = (i: number) => SHOES[i]?.[3] ?? 0;
    const hits = SHOES.map((s, i) => i).filter(i => m(SHOES[i]!));
    const srt = query.sel.sort?.in?.[0];
    if (srt === "Price: low") hits.sort((a, b) => price(a) - price(b));
    if (srt === "Price: high") hits.sort((a, b) => price(b) - price(a));
    const order = [...hits, ...SHOES.map((s, i) => i).filter(i => !hits.includes(i))];
    return { len: done + 2900, end: done + 1300, q: query, type0, type1, ask, got, picks, apply, done, hits, order };
  },
  frame: () => ({ tok: {} }), // the lane checker reads it; the stage draws through render
  render(stage) {
    const root = h(`<div class="d-root">
      <div class="d-box">${icon("lucide:search", 15)}<span class="d-q"></span><span class="d-pill"><span class="d-pl"></span><span class="d-tl"></span></span></div>
      <div class="d-groups">${GROUPS.map(([g, l, o]) => `<div class="d-g"><span class="d-gl">${l}</span><span class="d-opts">${o.map(x => `<span class="d-o" data-g="${g}" data-o="${x}">${x}</span>`).join("")}</span></div>`).join("")}</div>
      <div class="d-grid">${SHOES.map(([n, c, cat, pr]) => `<div class="d-t"><span class="d-sw"><i style="background:${HUE[c]}"></i></span><span class="d-n">${n}</span><span class="d-c"><span>${cat}</span><b>$${pr}</b></span></div>`).join("")}</div>
    </div>`);
    stage.append(root);
    const box = q(root, ".d-box"), qEl = q(root, ".d-q"), pill = q(root, ".d-pill"), pl = q(root, ".d-pl"), tl = q(root, ".d-tl");
    const opts = qa(root, ".d-o"), grid = q(root, ".d-grid"), tiles = qa(root, ".d-t");
    return (t, p, still) => {
      root.style.opacity = still ? "1" : (1 - clamp((t - (p.len - 500)) / 500)).toFixed(3);
      const n = Math.round(clamp((t - p.type0) / (p.type1 - p.type0)) * p.q.text.length);
      put(qEl, t < p.type0 ? `<span class="d-ph">Search shoes</span>` : `${p.q.text.slice(0, n)}${t < p.ask ? `<span class="d-caret"></span>` : ""}`);
      cls(box, "on", t >= p.type0 && t < p.ask);
      cls(pill, "vis", t >= p.ask && t < p.got + 1200);
      cls(pill, "open", t >= p.ask && t < p.got + 600);
      cls(pill, "ok", t >= p.got);
      put(pl, fs("resolve(text)", "resolve"));
      put(tl, t >= p.got ? "✓" : `<span class="spin"></span>`);
      for (const el of opts) {
        const pk = p.picks.find(([at, g, o]) => g === el.dataset.g && o === el.dataset.o && t >= at);
        cls(el, "in", pk?.[3] === "in"); cls(el, "ex", pk?.[3] === "ex");
      }
      // The grid: tiles move from the newest-first order to the selection order.
      const W = grid.clientWidth, H = grid.clientHeight, tw = (W - 24) / 4, th = (H - 8) / 2;
      const u = prog(t, p.apply, p.apply + 900);
      tiles.forEach((el, i) => {
        const to = p.order.indexOf(i);
        const x = lerp(i % 4, to % 4, u) * (tw + 8), y = lerp(Math.floor(i / 4), Math.floor(to / 4), u) * (th + 8);
        el.style.transform = `translate(${x.toFixed(2)}px,${y.toFixed(2)}px)`;
        cls(el, "off", t >= p.apply && !p.hits.includes(i));
        cls(el, "hit", t >= p.apply + 900 && p.hits.includes(i));
      });
      if (t >= p.apply) return 3;
      if (t >= p.got) return 2;
      if (t >= p.ask) return 1;
      return 0;
    };
  },
});
