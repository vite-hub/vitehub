// Source: three kinds of Source (a project folder, a GitHub repository, your own data) give the same reader. A
// Collection turns the list into a paged route, and useCollection() moves through it with a cursor.
import { defineScene, clamp, snap, rng, pick, fs, icon, h, q, qa, prog, cls, put } from "../engine";

/** An item: its Source index, its title, and its tag. */
type Item = [number, string, string];

/** A request: when it starts, when the page arrives, and its query. */
type Req = [number, number, string];

interface SourcePlan {
  len: number;
  end: number;
  items: Item[];
  c1: string;
  c2: string;
  pulse: [number, number, number];
  p1: number;
  m1: number;
  m2: number;
  endT: number;
}

/** Each Source: its icon, its name, and the code that makes it. */
const SRC: [string, string, string][] = [
  [icon("lucide:folder", 15), "docs/", "glob({ cwd: 'docs' })"],
  [icon("simple-icons:github", 15), "acme/handbook", "github({ repo })"],
  [icon("lucide:blocks", 15), "Your API", "defineSource()"],
];
const SETS: Item[][] = [
  [[0, "Getting started", "guide"], [1, "Code of conduct", "team"], [2, "Spring sale", "news"], [0, "Deploy to a host", "guide"], [2, "New office in Lyon", "news"], [1, "Time off policy", "team"], [0, "Read a file", "guide"], [1, "On-call rotation", "team"], [2, "Price update", "news"]],
  [[1, "Onboarding week", "team"], [0, "Install the CLI", "guide"], [2, "Q3 roadmap", "news"], [0, "Write a route", "guide"], [1, "Expense rules", "team"], [2, "Launch notes", "news"], [2, "Hiring update", "news"], [0, "Use a Source", "guide"], [1, "Security checklist", "team"]],
];
const CURSORS = ["eyJpZCI6Mn0", "eyJpZCI6NX0", "eyJpZCI6OH0", "eyJpZCI6M30", "eyJpZCI6Nn0"];

const css = `.vh-hero-source svg.icon{position:static;inset:auto;width:auto;height:auto}.vh-hero-source svg.icon path{fill:inherit;stroke:inherit;stroke-width:inherit;stroke-dasharray:none;vector-effect:none}
.vh-hero-source .s-root{position:absolute;inset:0;display:grid;grid-template-columns:34% 1fr;gap:28px}
.vh-hero-source .s-srcs{display:flex;flex-direction:column;gap:10px;justify-content:center}
.vh-hero-source .s-src{display:grid;grid-template-columns:30px 1fr;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);transition:box-shadow 300ms ease}
.vh-hero-source .s-src.on{box-shadow:inset 0 0 0 1px var(--fg)}
.vh-hero-source .s-ic{width:30px;height:30px;border-radius:8px;background:var(--soft);display:flex;align-items:center;justify-content:center;color:var(--fg)}
.vh-hero-source .s-src b{display:block;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vh-hero-source .s-src code{display:block;font:11px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vh-hero-source .s-list{display:flex;flex-direction:column;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden;min-width:0}
.vh-hero-source .s-hd{position:relative;height:34px;flex-shrink:0;display:flex;align-items:center;gap:8px;padding:0 12px;box-shadow:inset 0 -1px 0 var(--line);font:11px var(--mono);color:var(--muted);white-space:nowrap}
.vh-hero-source .s-hd b{font-weight:400;color:var(--fg)}
.vh-hero-source .s-pill{margin-left:auto;display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:99px;background:var(--fg);color:transparent;font:11px/1 var(--mono);white-space:nowrap;clip-path:inset(calc(50% - 4px) calc(50% - 4px) round 99px);opacity:0;transition:clip-path 550ms cubic-bezier(.65,0,.35,1) 80ms,color 120ms ease-out,background-color 300ms ease,opacity 250ms ease}
.vh-hero-source .s-pill.vis{opacity:1}
.vh-hero-source .s-pill.open{color:var(--bg);clip-path:inset(0 round 99px);transition:clip-path 650ms cubic-bezier(.65,0,.35,1),color 250ms ease-out 350ms,background-color 300ms ease,opacity 250ms ease}
.vh-hero-source .s-pill.ok{background:var(--ok)}
.vh-hero-source .s-pill .spin{display:inline-block}
.vh-hero-source .s-win{position:relative;height:126px;overflow:hidden}
.vh-hero-source .s-rows{will-change:transform}
.vh-hero-source .s-row{height:42px;display:grid;grid-template-columns:16px 1fr auto;align-items:center;gap:10px;padding:0 14px;font-size:13px;box-shadow:inset 0 -1px 0 var(--soft);opacity:0;transform:translateX(-6px);transition:opacity 300ms ease,transform 400ms var(--out)}
.vh-hero-source .s-row.on{opacity:1;transform:none}
.vh-hero-source .s-row>svg{color:var(--muted)}
.vh-hero-source .s-row span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vh-hero-source .s-row i{font:normal 11px var(--mono);color:var(--muted);padding:2px 7px;border-radius:99px;box-shadow:inset 0 0 0 1px var(--line)}
.vh-hero-source .s-ft{flex:1;display:flex;align-items:center;gap:10px;padding:0 12px;box-shadow:inset 0 1px 0 var(--line)}
.vh-hero-source .s-btn{height:28px;display:inline-flex;align-items:center;padding:0 12px;border-radius:7px;background:var(--fg);color:var(--bg);font-size:12px;font-weight:500;white-space:nowrap;transition:transform 150ms var(--out),background-color 300ms,color 300ms,box-shadow 300ms}
.vh-hero-source .s-btn.press{transform:scale(.94)}
.vh-hero-source .s-btn.end{background:none;color:var(--ok);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--ok) 45%,transparent)}
.vh-hero-source .s-st{font:11px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vh-hero-source .s-st b{font-weight:400;color:var(--fg)}
@container (max-width:640px){.vh-hero-source .s-root{grid-template-columns:36% 1fr;gap:20px}}
@container (max-width:560px){
 .vh-hero-source .s-root{grid-template-columns:44px 1fr;gap:10px}
 .vh-hero-source .s-src{grid-template-columns:30px;padding:6px}
 .vh-hero-source .s-src>div:last-child{display:none}
 .vh-hero-source .s-row{padding:0 10px;gap:8px;font-size:12px}
 .vh-hero-source .s-row i{display:none}
 .vh-hero-source .s-hd{padding:0 8px}
 .vh-hero-source .s-ft{padding:0 8px}
}`;

export default defineScene<SourcePlan>({
  css,
  key: "source",
  name: "Source",
  label: "Three Sources: a docs folder in the project, a GitHub repository, and your own API. A Collection serves their items at /api/articles, three at a time. The page loads the first three. Load more sends the next cursor and adds three more. The last page has no next cursor, so hasMore is false.",
  H: 230,
  steps: [
    "A Source reads files or records: a project folder, a GitHub repository, or your own data.",
    "A file in server/collections serves the items as a route, one page at a time.",
    "loadMore() sends the cursor of the last page, and the next items arrive.",
    "The last page has no next cursor, so hasMore is false.",
  ],
  summary: "Items from a project folder, GitHub, and your own data, served by a Collection one page at a time with a cursor.",
  plan(k) {
    const r = rng(k + 3301);
    const items = SETS[k % SETS.length]!;
    const c1 = pick(r, CURSORS), c2 = pick(r, CURSORS.filter(c => c !== c1));
    const j = () => snap(r() * 300);
    const pulse: [number, number, number] = [300, 800, 1300], p1 = 1900, m1 = p1 + 2000 + j(), m2 = m1 + 2800 + j(), end = m2 + 1900;
    return { len: end + 2700, end: end + 1300, items, c1, c2, pulse, p1, m1, m2, endT: end };
  },
  render(stage) {
    const root = h(`<div class="s-root">
      <div class="s-srcs">${SRC.map(([ic, n, c]) => `<div class="s-src"><span class="s-ic">${ic}</span><div><b>${n}</b><code>${c}</code></div></div>`).join("")}</div>
      <div class="s-list">
        <div class="s-hd">GET <b>/api/articles</b><span class="s-pill"><span class="s-pl"></span><span class="s-tl"></span></span></div>
        <div class="s-win"><div class="s-rows">${Array.from({ length: 9 }, () => `<div class="s-row"><svg class="icon"></svg><span></span><i></i></div>`).join("")}</div></div>
        <div class="s-ft"><span class="s-btn"></span><span class="s-st"></span></div>
      </div>
    </div>`);
    stage.append(root);
    const $ = (s: string) => q(root, s);
    const srcs = qa(root, ".s-src"), rowsEl = $(".s-rows"), rows = qa(root, ".s-row");
    const pill = $(".s-pill"), pl = $(".s-pl"), tl = $(".s-tl"), btn = $(".s-btn"), st = $(".s-st");
    let built: Item[] | null = null;
    return (t, p, still) => {
      root.style.opacity = still ? "1" : (1 - clamp((t - (p.len - 500)) / 500)).toFixed(3);
      if (built !== p.items) {
        built = p.items;
        rows.forEach((row, i) => {
          const [s, title, tag] = p.items[i]!;
          q(row, "svg").outerHTML = SRC[s]![0];
          q(row, "span").textContent = title;
          q(row, "i").textContent = tag;
        });
      }
      // Page loads: the first page, then two more after Load more.
      const loads = [p.p1, p.m1 + 900, p.m2 + 900];
      const loadAt = (i: number) => loads[Math.floor(i / 3)]! + (i % 3) * 140;
      const pages = loads.filter(x => t >= x).length;
      rows.forEach((row, i) => cls(row, "on", t >= loadAt(i)));
      // Scroll to the newest page.
      const rh = rows[0]?.offsetHeight || 42;
      const sc = prog(t, p.m1 + 700, p.m1 + 1300) + prog(t, p.m2 + 700, p.m2 + 1300);
      rowsEl.style.transform = `translateY(${(-sc * 3 * rh).toFixed(2)}px)`;
      // A source tile lights while its items arrive, or while its reader pulses at the start.
      srcs.forEach((el, s) => {
        const pulse = p.pulse[s] ?? -1e9;
        let on = t >= pulse && t < pulse + 600;
        p.items.forEach(([src], i) => { const at = loadAt(i); if (src === s && t >= at && t < at + 500) on = true });
        cls(el, "on", on);
      });
      // The request pill: the cursor goes out, the page comes back.
      const reqs: Req[] = [[p.p1 - 700, p.p1, "?limit=3"], [p.m1, p.m1 + 900, `?cursor=${p.c1}`], [p.m2, p.m2 + 900, `?cursor=${p.c2}`]];
      let req: Req | null = null;
      for (const q of reqs) if (t >= q[0] && t < q[1] + 700) req = q;
      cls(pill, "vis", !!req);
      cls(pill, "open", !!req && t < req[1] + 300);
      cls(pill, "ok", !!req && t >= req[1]);
      if (req) { put(pl, fs(req[2], req === reqs[0] ? "?limit=3" : "?cursor=…")); put(tl, t >= req[1] ? "✓" : `<span class="spin"></span>`) }
      // The footer.
      const last = pages >= 3 && t >= p.endT;
      cls(btn, "press", (t >= p.m1 - 150 && t < p.m1) || (t >= p.m2 - 150 && t < p.m2));
      cls(btn, "end", last);
      put(btn, last ? "All loaded" : "Load more");
      const next = pages === 1 ? p.c1 : pages === 2 ? p.c2 : null;
      put(st, pages === 0 ? "items: 0" : last || pages === 3 ? `items: <b>9</b> · hasMore: <b>false</b>` : fs(`items: <b>${pages * 3}</b> · nextCursor: <b>${next}</b>`, `items: <b>${pages * 3}</b> · hasMore`));
      if (last) return 3;
      if (t >= p.m1) return 2;
      if (t >= p.p1 - 700) return 1;
      return 0;
    };
  },
});
