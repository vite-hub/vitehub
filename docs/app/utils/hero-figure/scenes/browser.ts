// Browser: a cloud browser window on top, the steps of server/browsers/search.ts below it as log rows. Each step
// writes a row as it runs: open a session, go to the page, fill the search field, click the button, count the results.
// A cursor moves in the page. The count comes back to the server, and ViteHub closes the session.
import { defineScene, ease, clamp, lerp, rng, pick, fs, val, TL, icon, h, q, qa, cls, put, type Point, type Timed, type TimelinePlan } from "../engine";

/** A search text and the results the page shows for it. */
type Query = [string, string[]];
const QUERIES: [Query, Query, Query] = [
  ["billing", ["Billing overview", "Billing API", "Invoices and receipts"]],
  ["webhooks", ["Webhooks", "Verify a webhook"]],
  ["deploy", ["Deploy to Cloudflare", "Deploy to Vercel", "Preview deploys", "Roll back a deploy"]],
];

interface Times {
  open: number;
  win: number;
  openOk: number;
  goto: number;
  load: number;
  gotoOk: number;
  fill: number;
  at: number;
  type: number;
  fillOk: number;
  click: number;
  press: number;
  res: number;
  clickOk: number;
  count: number;
  countOk: number;
  ret: number;
  close: number;
}
type BrowserPlan = TimelinePlan<{ q: string; items: string[]; at: Times; id: string; step: Timed<number>[] }>;
/** A log row: start time, end time, tag, and message. */
type Row = [number, number, string, string];

const css = `.vh-hero-browser svg.icon{position:static;inset:auto;width:12px;height:12px}
.vh-hero-browser svg.icon path{fill:inherit;stroke:inherit;stroke-dasharray:none;vector-effect:none}.vh-hero-browser svg.icon path[stroke]{fill:none;stroke:currentColor}
.vh-hero-browser .bw{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px}
.vh-hero-browser .bw-win{position:relative;height:124px;flex:none;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden;transition:opacity 600ms ease,transform 500ms var(--out)}
.vh-hero-browser .bw-win.off{opacity:0;transform:scale(.98)}
.vh-hero-browser .bw-win.closed{opacity:.35}
.vh-hero-browser .bw-top{display:flex;align-items:center;gap:10px;height:28px;padding:0 10px;box-shadow:inset 0 -1px 0 var(--line)}
.vh-hero-browser .bw-dots{display:flex;gap:5px}.vh-hero-browser .bw-dots i{width:8px;height:8px;border-radius:99px;box-shadow:inset 0 0 0 1px var(--line)}
.vh-hero-browser .bw-url{flex:1;display:flex;align-items:center;gap:6px;height:19px;padding:0 9px;border-radius:6px;background:var(--soft);font:11px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden}
.vh-hero-browser .bw-url b{font-weight:400;color:var(--fg)}
.vh-hero-browser .bw-prov{display:flex;align-items:center;gap:6px;font:11px var(--mono);color:var(--dim);white-space:nowrap}
.vh-hero-browser .bw-page{position:relative;padding:9px 12px 0;transition:opacity 400ms ease}
.vh-hero-browser .bw-page.off{opacity:0}
.vh-hero-browser .bw-sr{display:flex;align-items:center;gap:8px}
.vh-hero-browser .bw-h{flex:none;margin-right:6px;font:600 13px var(--font-sans);color:var(--fg)}
.vh-hero-browser .bw-in{flex:1;min-width:0;height:26px;padding:0 9px;border-radius:6px;box-shadow:inset 0 0 0 1px var(--line);font:12px/26px var(--font-sans);color:var(--fg);white-space:nowrap;overflow:hidden;transition:box-shadow 250ms ease}
.vh-hero-browser .bw-in.focus{box-shadow:inset 0 0 0 1px var(--fg)}
.vh-hero-browser .bw-in.ph{color:var(--dim)}
.vh-hero-browser .bw-btn{flex:none;height:26px;padding:0 12px;border-radius:6px;background:var(--fg);color:var(--bg);font:500 12px/26px var(--font-sans);transition:transform 150ms ease}
.vh-hero-browser .bw-btn.press{transform:scale(.94)}
.vh-hero-browser .bw-res{position:relative;display:grid;grid-template-columns:1fr 1fr;column-gap:28px;row-gap:3px;margin-top:8px}
.vh-hero-browser .bw-li{display:flex;align-items:center;gap:7px;min-width:0;height:21px;padding:0 7px;margin:0 -7px;border-radius:6px;font:12px var(--font-sans);color:var(--muted);opacity:0;transform:translateY(4px);transition:opacity 300ms var(--out),transform 300ms var(--out),box-shadow 250ms ease,color 250ms ease}
.vh-hero-browser .bw-li>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vh-hero-browser .bw-li.on{opacity:1;transform:none}
.vh-hero-browser .bw-li.hit{box-shadow:inset 0 0 0 1px var(--fg);color:var(--fg)}
.vh-hero-browser .bw-li::before{content:"";flex:none;width:5px;height:5px;border-radius:99px;background:var(--dim)}
.vh-hero-browser .bw-li em{margin-left:auto;font:11px var(--mono);font-style:normal;color:var(--fg);opacity:0;transition:opacity 200ms ease}
.vh-hero-browser .bw-li.hit em,.vh-hero-browser .bw-li.n em{opacity:1}
.vh-hero-browser .bw-cur{position:absolute;left:0;top:0;color:var(--fg);transform:translate(calc(var(--cx)*1px),calc(var(--cy)*1px));opacity:var(--ca,0);transition:opacity 250ms ease;z-index:2}
.vh-hero-browser .bw-cur svg.icon{width:17px;height:17px}
.vh-hero-browser .bw-cur svg.icon path{fill:var(--bg)}
.vh-hero-browser .bw-ring{position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:99px;box-shadow:0 0 0 1.5px var(--fg);opacity:0;transform:scale(.4)}
.vh-hero-browser .bw-ring.on{animation:bw-click 450ms var(--out)}
@keyframes bw-click{0%{opacity:.8;transform:scale(.4)}100%{opacity:0;transform:scale(1.4)}}
.vh-hero-browser .bw-log{position:relative;height:126px}
.vh-hero-browser .bw-row{position:absolute;left:0;right:0;top:0;display:grid;grid-template-columns:64px 46px 1fr 52px;align-items:center;gap:6px;height:21px;padding:0 8px;border-radius:6px;font:11.5px var(--mono);color:var(--muted);white-space:nowrap;transform:translateY(calc(var(--i)*21px + 6px));opacity:0;transition:transform 400ms var(--out),opacity 300ms ease,background-color 300ms ease,color 300ms ease}
.vh-hero-browser .bw-row.on{opacity:1;transform:translateY(calc(var(--i)*21px))}
.vh-hero-browser .bw-row.cur{background:var(--soft)}
.vh-hero-browser .bw-row .t{color:var(--dim)}
.vh-hero-browser .bw-row .g{font-size:10.5px;color:var(--muted)}
.vh-hero-browser .bw-row .m{color:var(--fg);overflow:hidden;text-overflow:ellipsis}
.vh-hero-browser .bw-row .d{display:flex;justify-content:flex-end;color:var(--dim)}
.vh-hero-browser .bw-row .sp{display:inline-block;width:9px;height:9px;border:1.5px solid var(--line);border-top-color:var(--fg);border-radius:99px;animation:vh-fig-s 700ms linear infinite}
.vh-hero-browser .bw-row.ok .g,.vh-hero-browser .bw-row.ok .m,.vh-hero-browser .bw-row.ok .d{color:var(--ok)}
.vh-hero-browser.fading .bw-win,.vh-hero-browser.fading .bw-row{opacity:0!important;transition:opacity 400ms}
@container (max-width:560px){
  .vh-hero-browser .bw-top{gap:6px;padding:0 7px}
  .vh-hero-browser .bw-dots{display:none}
  .vh-hero-browser .bw-url{font-size:10px;padding:0 6px}
  .vh-hero-browser .bw-prov span{display:none}
  .vh-hero-browser .bw-page{padding:9px 10px 0}
  .vh-hero-browser .bw-h{display:none}
  .vh-hero-browser .bw-btn{padding:0 9px;font-size:11.5px}
  .vh-hero-browser .bw-in,.vh-hero-browser .bw-li{font-size:11.5px}
  .vh-hero-browser .bw-res{column-gap:22px}
  .vh-hero-browser .bw-row{grid-template-columns:40px 1fr 44px;font-size:10.5px;padding:0 6px}
  .vh-hero-browser .bw-row .t{display:none}
}`;


export default defineScene<BrowserPlan>({
  css,
  key: "browser",
  name: "Browser",
  label: "A browser window, and below it a log of the steps of server/browsers/search.ts. browser.open starts a page session. The script goes to a docs site, fills the search field, clicks the button, and counts the results. A cursor moves in the page as each step runs. The count comes back to the server, and ViteHub closes the session.",
  H: 260,
  steps: [
    "browser.open() starts a page session in a Cloudflare browser.",
    "The script goes to the page and fills the search field.",
    "It clicks the button, and the page shows the results.",
    "count() reads the data, and the script returns it. ViteHub closes the session.",
  ],
  summary: "A Browser file runs steps on a real page in a cloud browser: go to it, fill, click, read. The data comes back to your server, and ViteHub closes the session.",
  plan(k) {
    const r = rng(k + 709);
    const [query, items] = QUERIES[k % 3] ?? QUERIES[0];
    const type = 3800;
    const fillOk = type + query.length * 70 + 300;
    const click = fillOk + 300, press = click + 700, res = press + 350, clickOk = res + items.length * 150 + 300;
    const count = clickOk + 300, countOk = count + 300 + items.length * 280 + 200;
    const ret = countOk + 300, close = ret + 900;
    const A: Times = { open: 500, win: 800, openOk: 1300, goto: 1600, load: 2400, gotoOk: 2700, fill: 3000, at: 3600, type, fillOk, click, press, res, clickOk, count, countOk, ret, close };
    return TL().done(A.close + 2400, A.close + 600, { q: query, items, at: A, id: pick(r, ["s_4kd", "s_91x", "s_t2m"]), step: [[0, 0], [A.goto, 1], [A.click, 2], [A.count, 3]] });
  },
  render(stage) {
    stage.append(h(`<div class="bw">
      <div class="bw-win"><div class="bw-top"><span class="bw-dots"><i></i><i></i><i></i></span><span class="bw-url"></span><span class="bw-prov">${icon("simple-icons:cloudflare", 12)}<span>Browser Run</span></span></div>
        <div class="bw-page"><div class="bw-sr"><span class="bw-h">Acme Docs</span><div class="bw-in"></div><div class="bw-btn">Search</div></div>
          <div class="bw-res">${[0, 1, 2, 3].map(() => `<div class="bw-li"><span></span><em></em></div>`).join("")}</div></div>
        <span class="bw-cur"><span class="bw-ring"></span>${icon("lucide:mouse-pointer-2", 17)}</span></div>
      <div class="bw-log">${[0, 1, 2, 3, 4, 5].map(i => `<div class="bw-row" style="--i:${i}"><span class="t"></span><span class="g"></span><span class="m"></span><span class="d"></span></div>`).join("")}</div>
    </div>`));
    const $ = (s: string) => q(stage, s);
    const win = $(".bw-win"), url = $(".bw-url"), page = $(".bw-page"), input = $(".bw-in"), btn = $(".bw-btn");
    const lis = qa(stage, ".bw-li").map(el => ({ el, name: q(el, "span"), n: q(el, "em") }));
    const cur = $(".bw-cur"), ring = $(".bw-ring");
    const rows = qa(stage, ".bw-row").map(el => ({ el, time: q(el, ".t"), tag: q(el, ".g"), msg: q(el, ".m"), dur: q(el, ".d") }));
    const center = (el: Element): Point => {
      const w = win.getBoundingClientRect(), b = el.getBoundingClientRect();
      return [b.left - w.left + b.width * 0.45, b.top - w.top + b.height * 0.6];
    };
    const ms = (d: number) => d >= 1000 ? `${(d / 1000).toFixed(1)}s` : `${d}ms`;
    return (t, p) => {
      const A = p.at;
      cls(win, "off", t < A.win); cls(win, "closed", t >= A.close);
      // The URL bar and the page.
      const host = "docs.acme.dev", typedUrl = host.slice(0, clamp(Math.floor((t - A.goto) / 45), 0, host.length));
      put(url, t < A.goto ? `<span>about:blank</span>` : `${icon("lucide:lock", 12)}<b>https://${typedUrl}${t >= A.res ? `/search?q=${p.q}` : ""}</b>`);
      cls(page, "off", t < A.load);
      const qn = clamp(Math.floor((t - A.type) / 70), 0, p.q.length);
      put(input, t < A.type ? "Search the docs" : p.q.slice(0, qn));
      cls(input, "ph", t < A.type); cls(input, "focus", t >= A.at && t < A.click + 400);
      cls(btn, "press", t >= A.press && t < A.press + 160);
      lis.forEach((li, i) => {
        const item = p.items[i];
        cls(li.el, "on", !!item && t >= A.res + i * 150);
        if (item) put(li.name, item);
        const hitAt = A.count + 300 + i * 280;
        cls(li.el, "hit", !!item && t >= hitAt && t < hitAt + 280);
        cls(li.el, "n", !!item && t >= hitAt);
        put(li.n, String(i + 1));
      });
      // The cursor goes to the field, then to the button.
      const rest: Point = [win.clientWidth * 0.7, 110], pIn = center(input), pBtn = center(btn);
      let c = rest;
      if (t >= A.fill) c = [lerp(rest[0], pIn[0], ease((t - A.fill) / (A.at - A.fill))), lerp(rest[1], pIn[1], ease((t - A.fill) / (A.at - A.fill)))];
      if (t >= A.click) c = [lerp(pIn[0], pBtn[0], ease((t - A.click) / (A.press - A.click))), lerp(pIn[1], pBtn[1], ease((t - A.click) / (A.press - A.click)))];
      cur.style.setProperty("--cx", c[0].toFixed(1)); cur.style.setProperty("--cy", c[1].toFixed(1));
      cur.style.setProperty("--ca", t >= A.fill - 300 && t < A.count ? "1" : "0");
      cls(ring, "on", (t >= A.at && t < A.at + 450) || (t >= A.press && t < A.press + 450));
      // Each step of server/browsers/search.ts writes one log row as it runs.
      const S: Row[] = [
        [A.open, A.openOk, "open", fs("browser.open()  session " + p.id, "browser.open()")],
        [A.goto, A.gotoOk, "goto", fs(`page.goto('https://${host}')`, `goto('${host}')`)],
        [A.fill, A.fillOk, "fill", fs(`locator('input').fill('${p.q}')`, `fill('${p.q}')`)],
        [A.click, A.clickOk, "click", fs("locator('button').click()", "click('button')")],
        [A.count, A.countOk, "count", fs(`locator('li').count()  → ${p.items.length}`, `count() → ${p.items.length}`)],
        [A.ret, A.ret, "done", fs(`return ${p.items.length} · session closed`, `${p.items.length} · closed`)],
      ];
      S.forEach(([a, b, tag, msg], i) => {
        const row = rows[i];
        if (!row) return;
        const s0 = 41 + Math.floor((a - A.open) / 1000);
        put(row.time, `10:23:${String(s0).padStart(2, "0")}`);
        put(row.tag, tag); put(row.msg, msg);
        put(row.dur, i === 5 ? ms(A.ret - A.open) : t < b ? `<span class="sp"></span>` : ms(b - a));
        const c2 = `bw-row${t >= a ? " on" : ""}${t >= a && t < b ? " cur" : ""}${i === 5 ? " ok" : ""}`;
        if (row.el.className !== c2) row.el.className = c2;
      });
      return val(t, p.step, 0) ?? 0;
    };
  },
});
