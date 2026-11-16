// KV: one table, like a map. Code lines run one at a time. kv.set() inserts or changes a row, kv.get() reads a
// row and the value comes back to the code line, kv.del() removes a row and the next get returns null.
import { defineScene, snap, rng, pick, val, TL, h, q, cls, put } from "../engine";
import type { TimelinePlan } from "../engine";

interface Op {
  op: "set" | "get" | "del";
  key: string;
  val?: string;
  at: number;
}
type KvPlan = TimelinePlan<{ ops: Op[]; a: string; b: string; driver: string; step: number[] }>;

const css = `.vh-hero-kv .kv{position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;gap:5cqi}
.vh-hero-kv .kv-code{position:relative;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);padding:12px 0}
.vh-hero-kv .kv-file{padding:0 16px 10px;color:var(--muted);font:11px var(--mono)}
.vh-hero-kv .kv-line{display:flex;align-items:center;gap:12px;height:26px;padding:0 16px;font:12px var(--mono);white-space:nowrap;color:var(--muted);opacity:0;transform:translateY(4px);transition:opacity 260ms var(--out),transform 260ms var(--out),color 300ms ease,background-color 300ms ease}
.vh-hero-kv .kv-line.on{opacity:1;transform:none}
.vh-hero-kv .kv-line.cur{color:var(--fg);background:var(--soft)}
.vh-hero-kv .kv-n{width:10px;color:var(--dim);text-align:right}
.vh-hero-kv .kv-res{margin-left:auto;opacity:0;transform:translateX(8px);transition:opacity 300ms var(--out),transform 300ms var(--out)}
.vh-hero-kv .kv-res.on{opacity:1;transform:none}
.vh-hero-kv .kv-res.ok{color:var(--ok)}.vh-hero-kv .kv-res.dim{color:var(--dim)}
.vh-hero-kv .kv-table{position:relative;padding-top:12px}
.vh-hero-kv .kv-store{display:flex;justify-content:space-between;color:var(--muted);font:11px var(--mono);padding:0 2px 10px}
.vh-hero-kv .kv-store b{font-weight:400;color:var(--dim)}
.vh-hero-kv .kv-head,.vh-hero-kv .kv-row{display:grid;grid-template-columns:42% 1fr;align-items:center;height:30px;padding:0 10px;font:12px var(--mono)}
.vh-hero-kv .kv-head{color:var(--muted);font-size:11px;box-shadow:inset 0 -1px 0 var(--line)}
.vh-hero-kv .kv-rows{position:relative}
.vh-hero-kv .kv-row{position:absolute;left:0;right:0;top:0;border-radius:6px;box-shadow:inset 0 -1px 0 var(--line);transform:translateY(calc(var(--i)*30px));opacity:0;transition:transform 450ms var(--out),opacity 350ms ease,background-color 500ms ease,box-shadow 300ms ease,color 300ms ease}
.vh-hero-kv .kv-row.on{opacity:1}
.vh-hero-kv .kv-row.flash{background:var(--soft)}
.vh-hero-kv .kv-row.hit{box-shadow:inset 0 0 0 1px var(--fg)}
.vh-hero-kv .kv-row.del{color:var(--err)}.vh-hero-kv .kv-row.del .kv-v{text-decoration:line-through}
.vh-hero-kv .kv-k{color:var(--fg)}.vh-hero-kv .kv-row.del .kv-k{color:var(--err)}
.vh-hero-kv .kv-v{position:relative;height:30px;overflow:hidden}
.vh-hero-kv .kv-v span{position:absolute;left:0;top:0;line-height:30px}
.vh-hero-kv .kv-v span i{font-style:normal;display:inline-block}
.vh-hero-kv .kv-v .new i{animation:kv-in 420ms var(--out) both}
.vh-hero-kv .kv-v .old i{animation:kv-out 380ms var(--out) both}
@keyframes kv-in{from{opacity:0;transform:translateY(14px)}}
@keyframes kv-out{to{opacity:0;transform:translateY(-14px)}}
.vh-hero-kv.fading .kv-line,.vh-hero-kv.fading .kv-row{opacity:0;transition:opacity 400ms}
@container (max-width:560px){
  .vh-hero-kv .kv{grid-template-columns:54% 1fr;gap:10px}
  .vh-hero-kv .kv-n{display:none}
  .vh-hero-kv .kv-line{padding:0 10px;font-size:10.5px;gap:6px}
  .vh-hero-kv .kv-file{padding:0 10px 10px}
  .vh-hero-kv .kv-head,.vh-hero-kv .kv-row{font-size:11px;padding:0 6px}
  .vh-hero-kv .kv-store b{display:none}
}`;

export default defineScene<KvPlan>({
  css,
  key: "kv",
  name: "KV",
  label: "Code lines run one at a time next to a table of keys and values. kv.set() adds a row, kv.get() reads a row and returns its value, kv.set() on the same key changes the value, and kv.del() removes the row, so the next kv.get() returns null.",
  H: 210,
  steps: [
    "kv.set() saves a value under a key. The key gets a row.",
    "kv.get() reads the value by its key, from any route.",
    "kv.set() on the same key changes the value.",
    "kv.del() removes the key. Now kv.get() returns null.",
  ],
  summary: "KV is one table of keys and values. kv.set() saves a value, kv.get() reads it, and kv.del() removes it. The code is the same on every store.",
  plan(k) {
    const r = rng(k + 211);
    const [a, v1, v2] = pick(r, [["theme", "'dark'", "'light'"], ["plan", "'free'", "'pro'"], ["volume", "3", "7"], ["lang", "'en'", "'fr'"]]);
    const [b, bv] = pick(r, [["locale", "'en-US'"], ["cursor", "'c_812'"], ["banner", "true"], ["draft", "'v2'"]]);
    const driver = pick(r, ["fs-lite", "redis", "upstash", "cloudflare-kv-binding", "deno-kv"]);
    const gap = 1900, t0 = 600;
    const ops: Op[] = ([
      { op: "set", key: a, val: v1 }, { op: "set", key: b, val: bv }, { op: "get", key: a },
      { op: "set", key: a, val: v2 }, { op: "del", key: b }, { op: "get", key: b },
    ] satisfies Omit<Op, "at">[]).map((o, i) => ({ ...o, at: t0 + i * gap + (i ? snap(r() * 200) : 0) }));
    const at = (i: number) => ops[i]?.at ?? t0;
    const last = at(ops.length - 1);
    return TL().done(last + 3200, last + 1400, { ops, a, b, driver, step: [at(0), at(2), at(3), at(4)] });
  },
  render(stage) {
    stage.append(h(`<div class="kv">
      <div class="kv-code"><div class="kv-file">server/api/prefs.ts</div><div class="kv-lines"></div></div>
      <div class="kv-table"><div class="kv-store"><span>kv</span><b></b></div><div class="kv-head"><span>key</span><span>value</span></div><div class="kv-rows"></div></div>
    </div>`));
    const lines = q(stage, ".kv-lines"), rows = q(stage, ".kv-rows"), store = q(stage, ".kv-store b");
    const L = [...Array(6)].map((_, i) => { const el = h(`<div class="kv-line"><span class="kv-n">${i + 1}</span><span class="kv-c"></span><span class="kv-res"></span></div>`); lines.append(el); return el });
    // Rows: the one that is there from the start, then up to two keys from the plan. Built per key on demand.
    const R = new Map<string, HTMLElement>();
    const row = (key: string) => {
      const have = R.get(key);
      if (have) return have;
      const el = h(`<div class="kv-row"><span class="kv-k"></span><span class="kv-v"><span class="old"></span><span class="new"></span></span></div>`);
      rows.append(el);
      R.set(key, el);
      return el;
    };
    row("visits");
    return (t, p, still) => {
      put(store, p.driver);
      // Code lines.
      p.ops.forEach((o, i) => {
        const el = L[i]!, c = q(el, ".kv-c"), res = q(el, ".kv-res");
        put(c, o.op === "set" ? `kv.set('${o.key}', ${o.val})` : `kv.${o.op}('${o.key}')`);
        cls(el, "on", t >= o.at);
        const next = p.ops[i + 1]?.at ?? p.len;
        cls(el, "cur", t >= o.at && t < next);
        let out = "", tone = "";
        if (o.op === "get") {
          const found = p.ops.slice(0, i).filter(x => x.key === o.key && x.op !== "get").at(-1);
          out = found?.op === "set" ? `→ ${found.val}` : "→ null";
          tone = found?.op === "set" ? "ok" : "dim";
        }
        put(res, out);
        res.className = `kv-res ${tone}${o.op === "get" && t >= o.at + 650 ? " on" : ""}`;
      });
      // Table state at time t: which keys exist, in insertion order, with their current and previous value.
      const keys = ["visits", ...new Set(p.ops.map(o => o.key))];
      keys.forEach(row);
      for (const [key, el] of R) if (!keys.includes(key)) cls(el, "on", false);
      const state = keys.map(key => {
        const mine = p.ops.filter(o => o.key === key && o.op !== "get");
        const born = key === "visits" ? -1 : (mine[0]?.at ?? 0) + 350;
        const delAt = mine.find(o => o.op === "del")?.at;
        const sets = mine.filter(o => o.op === "set" && o.at + 350 <= t);
        const curSet = sets.at(-1), prevSet = sets.at(-2);
        const gets = p.ops.filter(o => o.op === "get" && o.key === key);
        return {
          key, born, delAt,
          alive: t >= born && (delAt === undefined || t < delAt + 1100),
          gone: delAt !== undefined && t >= delAt + 1100,
          val: key === "visits" ? "1284" : curSet?.val ?? "", prev: prevSet?.val,
          changedAt: curSet ? curSet.at + 350 : -1e9,
          hit: gets.some(g => t >= g.at + 150 && t < g.at + 1300),
          del: delAt !== undefined && t >= delAt + 250,
        };
      });
      let slot = 0;
      for (const s of state) {
        const el = row(s.key), x = q(el, ".kv-v .old"), y = q(el, ".kv-v .new");
        el.style.setProperty("--i", String(slot));
        if (t >= s.born && !s.gone) slot++;
        put(q(el, ".kv-k"), s.key);
        cls(el, "on", s.alive);
        cls(el, "flash", t >= s.changedAt && t < s.changedAt + 900);
        cls(el, "hit", s.hit);
        cls(el, "del", s.del);
        // Two spans cross-fade when a value changes: the old one goes up, the new one comes from below.
        put(x, s.prev === undefined || still ? "" : `<i>${s.prev}</i>`); put(y, `<i>${s.val}</i>`);
      }
      return val(t, p.step.map((at, i) => [at, i]), 0);
    };
  },
});
