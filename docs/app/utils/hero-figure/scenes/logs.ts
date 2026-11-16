// Logs: wide events, as Evlog writes them. One event per request streams into the list. One opens in the inspector
// with all its fields. An error arrives and stands out, with why it failed and how to fix it. Then a level filter
// narrows the list to the errors.
import { defineScene, snap, rng, pick, fs, val, TL, icon, h, q, cls, put } from "../engine";
import type { Timed, TimelinePlan } from "../engine";

type Kind = "fill" | "ok" | "err0" | "err";
type Level = "info" | "warn" | "error";
/** [method, path, status, level] */
type Request = [string, string, number, Level];
interface LogEvent {
  kind: Kind;
  at: number;
  time: string;
  m: string;
  p: string;
  s: number;
  lv: Level;
  d: string;
}
interface Times {
  sel: number;
  errShift: number;
  errSel: number;
  filter: number;
}
type LogsPlan = TimelinePlan<{ ev: LogEvent[]; at: Times; user: { id: number; plan: string }; items: number; total: number; order: string; req: string; step: Timed<number>[] }>;

const FILL: Request[] = [
    ["GET", "/api/products", 200, "info"], ["GET", "/api/status", 200, "info"], ["POST", "/api/login", 401, "warn"],
    ["GET", "/api/user", 200, "info"], ["POST", "/api/cart", 200, "info"], ["GET", "/api/search", 200, "info"],
  ];
const css = `.vh-hero-logs svg.icon{position:static;inset:auto;width:12px;height:12px}
.vh-hero-logs svg.icon path{fill:inherit;stroke:inherit;stroke-dasharray:none;vector-effect:none}.vh-hero-logs svg.icon path[stroke]{fill:none;stroke:currentColor}
.vh-hero-logs .lg{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px}
.vh-hero-logs .lg-bar{display:flex;align-items:center;gap:8px;height:26px;font:11.5px var(--mono);color:var(--muted)}
.vh-hero-logs .lg-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:99px;box-shadow:inset 0 0 0 1px var(--line);white-space:nowrap;transition:box-shadow 300ms ease,color 300ms ease}
.vh-hero-logs .lg-chip b{font-weight:400;color:var(--fg)}
.vh-hero-logs .lg-chip>span{display:inline-block;animation:vh-fig-c 250ms var(--out)}
.vh-hero-logs .lg-chip.on{box-shadow:inset 0 0 0 1px var(--err);color:var(--err)}
.vh-hero-logs .lg-chip.on b{color:var(--err)}
.vh-hero-logs .lg-live{margin-left:auto;display:inline-flex;align-items:center;gap:6px;color:var(--dim);white-space:nowrap}
.vh-hero-logs .lg-live i{width:6px;height:6px;border-radius:99px;background:var(--ok);animation:lg-pulse 1.6s ease-in-out infinite}
@keyframes lg-pulse{50%{opacity:.35}}
.vh-hero-logs .lg-main{position:relative;flex:1;display:grid;grid-template-columns:57% 40%;justify-content:space-between;min-height:0}
.vh-hero-logs .lg-list{position:relative;overflow:hidden}
.vh-hero-logs .lg-row{position:absolute;left:0;right:0;top:0;display:grid;grid-template-columns:64px 46px 1fr 34px 52px;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:6px;font:11.5px var(--mono);color:var(--muted);white-space:nowrap;transform:translateY(calc(var(--i)*25px));opacity:0;transition:transform 450ms var(--out),opacity 300ms ease,background-color 300ms ease,box-shadow 300ms ease}
.vh-hero-logs .lg-row.on{opacity:1}
.vh-hero-logs .lg-row.new{transform:translateY(calc(var(--i)*25px - 8px))}
.vh-hero-logs .lg-row.sel{box-shadow:inset 0 0 0 1px var(--fg);background:var(--soft)}
.vh-hero-logs .lg-row.flash{background:color-mix(in oklab,var(--err) 10%,transparent)}
.vh-hero-logs .lg-row .p{color:var(--fg);overflow:hidden;text-overflow:ellipsis}
.vh-hero-logs .lg-row .d{text-align:right;color:var(--dim)}
.vh-hero-logs .lg-row .t{color:var(--dim)}
.vh-hero-logs .lv{font-size:10.5px}
.vh-hero-logs .lv.info{color:var(--muted)}.vh-hero-logs .lv.warn{color:var(--warn)}.vh-hero-logs .lv.error{color:var(--err)}
.vh-hero-logs .lg-row.error .s{color:var(--err)}.vh-hero-logs .lg-row.warn .s{color:var(--warn)}
.vh-hero-logs .lg-ins{align-self:start;position:relative;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);padding:10px 12px;background:var(--bg);opacity:0;transform:translateX(8px);transition:opacity 350ms var(--out),transform 350ms var(--out),box-shadow 300ms ease}
.vh-hero-logs .lg-ins.on{opacity:1;transform:none}
.vh-hero-logs .lg-ins.err{box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--err) 55%,transparent)}
.vh-hero-logs .lg-ins>div{animation:vh-fig-c 300ms var(--out)}
.vh-hero-logs .lg-ih{display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;font:12px var(--mono);color:var(--fg);white-space:nowrap}
.vh-hero-logs .lg-ih span{color:var(--ok)}.vh-hero-logs .lg-ih span.err{color:var(--err)}
.vh-hero-logs .lg-f{display:grid;grid-template-columns:22px 82px 1fr;height:21px;align-items:center;font:11.5px var(--mono);color:var(--muted);white-space:nowrap}
.vh-hero-logs .lg-f>i{font-style:normal;color:var(--dim)}
.vh-hero-logs .lg-f>b{font-weight:400;color:var(--fg);overflow:hidden;text-overflow:ellipsis}
.vh-hero-logs .lg-f.e>b{color:var(--err)}
.vh-hero-logs .lg-f.sub>span{color:var(--dim)}.vh-hero-logs .lg-f.sub>b{color:var(--muted)}
.vh-hero-logs .lg-empty{grid-column:2;grid-row:1;align-self:start;height:130px;display:grid;place-items:center;border-radius:10px;outline:1px dashed var(--line);outline-offset:-1px;font:11.5px var(--mono);color:var(--dim);transition:opacity 300ms ease}.vh-hero-logs .lg-empty.off{opacity:0}
.vh-hero-logs .lg-ins{grid-column:2;grid-row:1}.vh-hero-logs .lg-list{grid-column:1;grid-row:1}
.vh-hero-logs.fading .lg-row,.vh-hero-logs.fading .lg-ins{opacity:0!important;transition:opacity 400ms}
@container (max-width:640px){
  .vh-hero-logs .lg-main{grid-template-columns:50% 47%}
  .vh-hero-logs .lg-row{grid-template-columns:58px 38px 1fr 28px;gap:5px;padding:0 6px}
  .vh-hero-logs .lg-row .d{display:none}
  .vh-hero-logs .lg-ins{padding:10px}
  .vh-hero-logs .lg-f{grid-template-columns:19px 63px 1fr;font-size:10.5px}
}
@container (max-width:560px){
  .vh-hero-logs .lg-bar{font-size:10.5px}
  .vh-hero-logs .lg-chip{padding:0 8px}
  .vh-hero-logs .lg-main{grid-template-columns:100%}
  .vh-hero-logs .lg-row{grid-template-columns:40px 1fr 30px;font-size:10.5px}
  .vh-hero-logs .lg-row .t,.vh-hero-logs .lg-row .d{display:none}
  .vh-hero-logs .lg-ins{position:absolute;left:0;right:0;top:0;padding:8px 10px}
  .vh-hero-logs .lg-empty{display:none}
  .vh-hero-logs .lg-ins{grid-column:1}
  .vh-hero-logs .lg-ins.late{opacity:0;transform:translateX(8px)}
  .vh-hero-logs .lg-f{grid-template-columns:16px 66px 1fr;font-size:10.5px}
  .vh-hero-logs .lg-ih{font-size:11px}
}`;

export default defineScene<LogsPlan>({
  css,
  key: "logs",
  name: "Logs",
    label: "A list of log events streams in, one wide event for each request. One checkout event opens in the inspector and shows its fields: request id, user, cart, and order. An error event arrives and stands out in red, with the error, why it happened, and how to fix it. A level filter then narrows the list to the errors.",
  H: 250,
  steps: [
    "Each request writes one wide event. Events stream in as requests end.",
    "Open an event to see all its fields: the request, the user, the cart.",
    "An error stands out. Its event says why it failed and how to fix it.",
    "A level filter narrows the list to the errors.",
  ],
  summary: "Logs shows one wide event for each request. An event opens with all its fields, an error says why it failed and how to fix it, and filters narrow the list.",
  plan(k) {
    const r = rng(k + 811);
    const fill = [...FILL].sort(() => r() - .5);
    const plan: Kind[] = ["fill", "fill", "ok", "fill", "err0", "fill", "fill", "err", "fill"];
    let t = 400, fi = 0, sec = 41 + Math.floor(r() * 12);
    const user = { id: 1 + Math.floor(r() * 90), plan: pick(r, ["pro", "free", "team"]) };
    const items = 1 + Math.floor(r() * 4), total = pick(r, [1299, 4900, 9999, 2450]);
    const ev = plan.map((kind): LogEvent => {
      const at = t; t += snap(550 + r() * 400);
      const time = `10:23:${String(sec++).padStart(2, "0")}`;
      if (kind === "fill") { const [m, p, s, lv] = fill[fi++ % fill.length]!; return { kind, at, time, m, p, s, lv, d: `${3 + Math.floor(r() * 80)}ms` } }
      if (kind === "ok") return { kind, at, time, m: "POST", p: "/api/checkout", s: 200, lv: "info", d: `${180 + Math.floor(r() * 120)}ms` };
      if (kind === "err0") return { kind, at, time, m: "GET", p: "/api/feed", s: 500, lv: "error", d: `${900 + Math.floor(r() * 400)}ms` };
      return { kind, at, time, m: "POST", p: "/api/checkout", s: 402, lv: "error", d: `${90 + Math.floor(r() * 80)}ms` };
    });
    const okAt = ev.find(e => e.kind === "ok")?.at ?? 0, errAt0 = ev.find(e => e.kind === "err")?.at ?? 0;
    // The error arrives after the first inspection: move it and the events after it later.
    const sel = okAt + 900;
    const errShift = Math.max(0, sel + 2000 - errAt0);
    for (const e of ev) if (e.at >= errAt0) e.at += errShift;
    const errAt = errAt0 + errShift, errSel = errAt + 900;
    const A: Times = { sel, errShift, errSel, filter: errSel + 2600 };
    return TL().done(A.filter + 2600, A.filter + 900, {
      ev, at: A, user, items, total, order: `ord_${pick(r, ["abc123", "k29x1q", "7mx0p2"])}`, req: `req_${pick(r, ["8f2", "1kq", "x7a", "30b"])}`,
      step: [[0, 0], [A.sel, 1], [errAt, 2], [A.filter, 3]],
    });
  },
  render(stage) {
    stage.append(h(`<div class="lg">
      <div class="lg-bar"><span class="lg-chip lvl"></span><span class="lg-chip">${icon("lucide:search", 12)}<span>${fs("text: <b>any</b>", "any")}</span></span><span class="lg-live"><i></i>${fs("Stream · vitehub logs", "")}</span></div>
      <div class="lg-main"><div class="lg-list"></div><div class="lg-empty">select an event</div><div class="lg-ins"></div></div>
    </div>`));
    const list = q(stage, ".lg-list"), ins = q(stage, ".lg-ins"), lvl = q(stage, ".lvl"), empty = q(stage, ".lg-empty");
    const rows = [...Array(9)].map(() => { const el = h(`<div class="lg-row"><span class="t"></span><span class="lv"></span><span class="p"></span><span class="s"></span><span class="d"></span></div>`); list.append(el); return el });
    return (t, p) => {
      const A = p.at, filtered = t >= A.filter;
      const vis = p.ev.map((e, i) => ({ e, i })).filter(({ e }) => t >= e.at && (!filtered || e.lv === "error")).reverse();
      const pos = new Map(vis.map(({ i }, n) => [i, n]));
      const sel = t >= A.errSel ? "err" : t >= A.sel ? "ok" : null;
      p.ev.forEach((e, i) => {
        const el = rows[i]!, lv = q(el, ".lv");
        put(q(el, ".t"), e.time); put(lv, e.lv.toUpperCase()); lv.className = `lv ${e.lv}`;
        put(q(el, ".p"), `${e.m} ${e.p}`); put(q(el, ".s"), String(e.s)); put(q(el, ".d"), e.d);
        const n = pos.get(i);
        const on = n !== undefined && n < 8;
        if (n !== undefined) el.style.setProperty("--i", String(n));
        const c = `lg-row ${e.lv}${on ? " on" : ""}${t >= e.at && t < e.at + 60 ? " new" : ""}${e.kind === sel ? " sel" : ""}${e.lv === "error" && t >= e.at && t < e.at + 900 ? " flash" : ""}`;
        if (el.className !== c) el.className = c;
      });
      put(lvl, `${icon("lucide:filter", 12)}<span>level: <b>${filtered ? "error" : "all"}</b></span>`);
      cls(lvl, "on", filtered);
      // The inspector: the fields of the selected event.
      const e = sel && p.ev.find(x => x.kind === sel);
      if (e) {
        const head = `<div class="lg-ih">${e.m} ${e.p}<span class="${sel === "err" ? "err" : ""}">${e.s} · ${e.d}</span></div>`;
        const f = (tree: string, k: string, v: string | number, c = "") => `<div class="lg-f ${c}"><i>${tree}</i><span>${k}</span><b>${v}</b></div>`;
        const body = sel === "ok"
          ? f("├─", "requestId", p.req) + f("├─", "user", `id=${p.user.id} plan=${p.user.plan}`) + f("├─", "cart", `items=${p.items} total=${p.total}`) + f("└─", "orderId", p.order)
          : f("├─", "error", "Card declined", "e") + f("│", "why", "Issuer declined the charge", "sub") + f("│", "fix", "Ask for another card", "sub") + f("├─", "user", `id=${p.user.id} plan=${p.user.plan}`) + f("└─", "cart", `items=${p.items} total=${p.total}`);
        put(ins, `<div>${head}${body}</div>`);
      }
      cls(ins, "on", !!e); cls(empty, "off", !!e); cls(ins, "err", sel === "err"); cls(ins, "late", filtered);
      return val(t, p.step, 0);
    };
  },
});
