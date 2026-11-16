// Content: a Markdown file with front matter becomes a page that a route reads with content.get(). Then a search
// box types a word, and content.search() returns the pages that have it, with the match marked.
import { defineScene, clamp, snap, rng, fs, icon, h, q, qa, cls, put } from "../engine";

interface Page {
  file: string;
  path: string;
  title: string;
  desc: string;
  body: string;
  md: string;
  q: string;
  /** Search results: a title and a line with the match marked. */
  res: [string, string][];
}
const PAGES: [Page, Page, Page] = [
  {
    file: "deploy.md", path: "/deploy", title: "Deploy to Cloudflare", desc: "Ship the app as a Worker.", body: "Run <code>vitehub deploy</code> and pick a host.", md: "Run `vitehub deploy` and pick a host.",
    q: "worker", res: [["Deploy to Cloudflare", "Ship the app as a <mark>Worker</mark>."], ["Queues", "Each <mark>worker</mark> reads one message."], ["Limits", "A <mark>Worker</mark> has 128 MB of memory."]],
  },
  {
    file: "cache.md", path: "/cache", title: "Cache pages", desc: "Keep a rendered page for a minute.", body: "Set <code>maxAge</code> on a route to cache it.", md: "Set `maxAge` on a route to cache it.",
    q: "cache", res: [["Cache pages", fs("Set maxAge on a route to <mark>cache</mark> it.", "Set maxAge to <mark>cache</mark> it.")], ["Routes", "A route can <mark>cache</mark> its response."], ["Images", fs("Resized images stay in the <mark>cache</mark>.", "Images stay in the <mark>cache</mark>.")]],
  },
  {
    file: "intro.md", path: "/intro", title: "Hello from Content", desc: "Your first page.", body: "This file is in your project.", md: "This file is in your project.",
    q: "project", res: [["Hello from Content", "This file is in your <mark>project</mark>."], ["Install", "Add vite-hub to your <mark>project</mark>."], ["Sources", fs("Read files from your <mark>project</mark> or GitHub.", "Read files from your <mark>project</mark>.")]],
  },
];
/** The Markdown lines of each group that lights up in order: title, description, heading, body. */
const GROUPS = [[1], [2], [4], [6]];

interface ContentPlan {
  len: number;
  end: number;
  pg: Page;
  /** When each line group lights up, then when the last one stops. */
  l: [number, number, number, number, number];
  got: number;
  q0: number;
  q1: number;
  res: number;
  note: number;
}

const css = `.vh-hero-content svg.icon{position:static;inset:auto;width:auto;height:auto}.vh-hero-content svg.icon path{fill:inherit;stroke:inherit;stroke-width:inherit;stroke-dasharray:none;vector-effect:none}
.vh-hero-content .t-root{position:absolute;inset:0;display:grid;grid-template-columns:44% 1fr;gap:24px}
.vh-hero-content .t-col{display:flex;flex-direction:column;gap:12px;min-width:0}
.vh-hero-content .t-card{position:relative;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden;display:flex;flex-direction:column;transition:box-shadow 300ms ease}
.vh-hero-content .t-card.on{box-shadow:inset 0 0 0 1px var(--fg)}
.vh-hero-content .t-hd{height:30px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 12px;box-shadow:inset 0 -1px 0 var(--line);font:11px var(--mono);color:var(--muted);white-space:nowrap}
.vh-hero-content .t-hd b{font-weight:400;color:var(--fg);overflow:hidden;text-overflow:ellipsis}
.vh-hero-content .t-hd span{transition:color 300ms ease}.vh-hero-content .t-hd span.ok{color:var(--ok)}
.vh-hero-content .t-md{flex:1;padding:10px 0}
.vh-hero-content .t-ln{display:flex;gap:10px;padding:0 12px;font:12px/24px var(--mono);color:var(--muted);white-space:nowrap;transition:background-color 250ms ease,color 250ms ease}
.vh-hero-content .t-ln i{font-style:normal;color:var(--dim);width:12px;text-align:right;flex-shrink:0}
.vh-hero-content .t-ln span{overflow:hidden;text-overflow:ellipsis}
.vh-hero-content .t-ln.fm{color:var(--fg)}.vh-hero-content .t-ln.fm em{font-style:normal;color:var(--muted)}
.vh-hero-content .t-ln.hl{background:var(--soft);color:var(--fg)}
.vh-hero-content .t-page{flex:none}
.vh-hero-content .t-pg{padding:10px 14px 12px}
.vh-hero-content .t-pt{font-size:17px;font-weight:600;letter-spacing:-.01em;opacity:0;transform:translateY(4px);transition:opacity 300ms ease,transform 400ms var(--out)}
.vh-hero-content .t-pd{margin-top:2px;font-size:12.5px;color:var(--muted);opacity:0;transform:translateY(4px);transition:opacity 300ms ease,transform 400ms var(--out)}
.vh-hero-content .t-pb{margin-top:8px;font-size:12.5px;line-height:1.5;opacity:0;transform:translateY(4px);transition:opacity 300ms ease,transform 400ms var(--out)}
.vh-hero-content .t-pb code{font:11.5px var(--mono);padding:1px 4px;border-radius:4px;background:var(--soft)}
.vh-hero-content .on>.t-pt,.vh-hero-content .t-pd.on,.vh-hero-content .t-pb.on,.vh-hero-content .t-pt.on{opacity:1;transform:none}
.vh-hero-content .t-search{flex:1}
.vh-hero-content .t-box{display:flex;align-items:center;gap:7px;margin:9px 12px 3px;height:28px;padding:0 10px;border-radius:7px;box-shadow:inset 0 0 0 1px var(--line);font-size:13px;color:var(--fg)}
.vh-hero-content .t-box svg{color:var(--muted)}
.vh-hero-content .t-ph{color:var(--dim)}
.vh-hero-content .t-caret{display:inline-block;width:1px;height:14px;margin-left:1px;vertical-align:-2px;background:var(--fg);animation:cntblink 900ms steps(1) infinite}
@keyframes cntblink{50%{opacity:0}}
.vh-hero-content .t-res{padding:0 12px}
.vh-hero-content .t-r{display:flex;gap:8px;align-items:baseline;padding:3px 0;font-size:12px;white-space:nowrap;opacity:0;transform:translateY(4px);transition:opacity 280ms ease,transform 380ms var(--out)}
.vh-hero-content .t-r.on{opacity:1;transform:none}
.vh-hero-content .t-r b{font-weight:500;flex-shrink:0}
.vh-hero-content .t-r span{color:var(--muted);overflow:hidden;text-overflow:ellipsis}
.vh-hero-content mark{background:color-mix(in oklab,var(--warn) 22%,transparent);color:var(--fg);border-radius:3px;padding:0 1px}
@container (max-width:640px){
 .vh-hero-content .t-root{gap:16px}
 .vh-hero-content .t-col{gap:8px}
 .vh-hero-content .t-ln{font-size:11px;gap:8px}
 .vh-hero-content .t-pg{padding:7px 14px 8px}
 .vh-hero-content .t-pb{margin-top:6px}
 .vh-hero-content .t-box{margin:8px 12px 2px;height:26px}
 .vh-hero-content .t-r{padding:2px 0}
 .vh-hero-content .t-ss{display:none}
}
@container (max-width:560px){
 .vh-hero-content .t-root{grid-template-columns:46% 1fr;gap:10px}
 .vh-hero-content .t-ln{font-size:10px;line-height:19px;padding:0 8px;gap:6px}
 .vh-hero-content .t-ln i{display:none}
 .vh-hero-content .t-hd{padding:0 8px;font-size:10px}
 .vh-hero-content .t-hd>span{display:none}
 .vh-hero-content .t-pg{padding:8px 10px}
 .vh-hero-content .t-pt{font-size:14px}.vh-hero-content .t-pd,.vh-hero-content .t-pb{font-size:11.5px}.vh-hero-content .t-pb{display:none}
 .vh-hero-content .t-box{margin:8px 8px 2px;font-size:12px}
 .vh-hero-content .t-res{padding:0 8px}
 .vh-hero-content .t-r{padding:2px 0;font-size:11px}
 .vh-hero-content .t-r b{display:none}
}`;


export default defineScene<ContentPlan>({
  css,
  key: "content",
  name: "Content",
  label: "A Markdown file in the docs folder has front matter with a title and a description, then a heading and a sentence. Content reads it, and content.get returns the page. Then a search box gets a word, and content.search returns three pages that have it, with the match marked.",
  H: 262,
  steps: p => [
    `docs/${p.pg.file} is a Markdown file with front matter. Content reads it as the page ${p.pg.path}.`,
    `content.get('${p.pg.path}') returns the page: its fields and its body, ready to render.`,
    `content.search(['docs'], '${p.pg.q}') looks for the word in every page.`,
    "Each result shows the match. The full-text search plugin keeps the index in SQLite.",
  ],
  summary: "A Markdown file becomes a page that content.get() returns, and content.search() finds every page with a word.",
  plan(k) {
    const r = rng(k + 7707);
    const pg = PAGES[k % PAGES.length] ?? PAGES[0];
    const j = () => snap(r() * 300);
    const got = 3900 + j(), q0 = got + 1300, q1 = q0 + 160 * pg.q.length + 300, res = q1 + 500, note = res + 1500;
    return { len: note + 3200, end: note + 1500, pg, l: [700, 1300, 1900, 2700, 3300], got, q0, q1, res, note };
  },
  frame: () => ({ tok: {} }), // the lane checker reads it; the stage draws through render
  render(stage) {
    const root = h(`<div class="t-root">
      <div class="t-col"><div class="t-card t-file" style="flex:1"><div class="t-hd"><b class="t-fn"></b><span>Markdown</span></div><div class="t-md"></div></div></div>
      <div class="t-col">
        <div class="t-card t-page"><div class="t-hd"><b class="t-get"></b><span class="t-gs"></span></div><div class="t-pg"><div class="t-pt"></div><div class="t-pd"></div><div class="t-pb"></div></div></div>
        <div class="t-card t-search"><div class="t-hd"><b class="t-sq"></b><span class="t-ss"></span></div><div class="t-box">${icon("lucide:search", 13)}<span class="t-in"></span></div><div class="t-res">${[0, 1, 2].map(() => `<div class="t-r"><b></b><span></span></div>`).join("")}</div></div>
      </div>
    </div>`);
    stage.append(root);
    const $ = (s: string) => q(root, s);
    const md = $(".t-md"), page = $(".t-page"), search = $(".t-search");
    const rows = qa(root, ".t-r").map(el => ({ el, title: q(el, "b"), line: q(el, "span") }));
    const fn = $(".t-fn"), get = $(".t-get"), gs = $(".t-gs"), pt = $(".t-pt"), pd = $(".t-pd"), pb = $(".t-pb");
    const sq = $(".t-sq"), input = $(".t-in"), ss = $(".t-ss");
    let built: Page | null = null;
    let lines: HTMLElement[] = [];
    return (t, p, still) => {
      root.style.opacity = still ? "1" : (1 - clamp((t - (p.len - 500)) / 500)).toFixed(3);
      const P = p.pg;
      if (built !== P) {
        built = P;
        const L = [["---", ""], [`title: <em>${P.title}</em>`, "fm"], [`description: <em>${P.desc}</em>`, "fm"], ["---", ""], [`# ${P.title}`, ""], ["", ""], [P.md, ""]];
        md.innerHTML = L.map(([s, c], i) => `<div class="t-ln ${c}"><i>${i + 1}</i><span>${s || "&nbsp;"}</span></div>`).join("");
        lines = qa(md, ".t-ln");
      }
      // Line groups light up in order: title, description, heading, body.
      const cur = GROUPS.findIndex((_, i) => {
        const a = p.l[i], b = p.l[i + 1];
        return a !== undefined && b !== undefined && t >= a && t < b;
      });
      const lit = GROUPS[cur] ?? [];
      lines.forEach((ln, i) => cls(ln, "hl", lit.includes(i)));
      put(fn, fs(`docs/${P.file}`, P.file));
      put(get, fs(`content.get('${P.path}')`, P.path));
      put(gs, t >= p.got ? "200 ✓" : "");
      cls(gs, "ok", t >= p.got);
      put(pt, P.title); put(pd, P.desc); put(pb, P.body);
      cls(pt, "on", t >= p.l[0] + 150);
      cls(pd, "on", t >= p.l[1] + 150);
      cls(pb, "on", t >= p.l[3] + 150);
      cls(page, "on", t >= p.l[0] && t < p.got + 600);
      // Search.
      put(sq, fs(`content.search(['docs'], '${P.q}')`, "search()"));
      const n = Math.round(clamp((t - p.q0) / (p.q1 - p.q0 - 300)) * P.q.length);
      put(input, t < p.q0 ? `<span class="t-ph">Search the docs</span>` : `${P.q.slice(0, n)}<span class="t-caret"></span>`);
      put(ss, t >= p.res ? "3 results" : "");
      cls(search, "on", t >= p.q0 && t < p.res + 900);
      rows.forEach((row, i) => {
        cls(row.el, "on", t >= p.res + i * 160);
        const [title, line] = P.res[i] ?? ["", ""];
        put(row.title, title); put(row.line, line);
      });
      if (t >= p.note) return 3;
      if (t >= p.q0) return 2;
      if (t >= p.got) return 1;
      return 0;
    };
  },
});
