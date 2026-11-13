// Database: a table with typed columns. A typed Drizzle query runs: an insert adds a row, an update changes a cell,
// and a select lights the matching rows and dims the others. The result shows its TypeScript type.
import { defineScene, rng, pick, fs, TL, h, q, cls, put } from "../engine";
import type { TimelinePlan } from "../engine";

interface Row {
  id: number;
  title: string;
  done: boolean;
}
type DatabasePlan = TimelinePlan<{ rows: Row[]; added: string; target: number; want: boolean; ins: number; upd: number; sel: number }>;

const css = `.vh-hero-database .db{position:absolute;inset:0;display:flex;flex-direction:column}
.vh-hero-database .db-lbl b{font-weight:400}
.vh-hero-database .db-lbl{display:flex;justify-content:space-between;height:18px;margin:0 2px 8px;font:11px var(--mono);color:var(--dim);white-space:nowrap}
.vh-hero-database .db-card{border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.vh-hero-database .db-q{position:relative;height:34px;box-shadow:inset 0 -1px 0 var(--line);font:12px/34px var(--mono);padding:0 12px;white-space:nowrap;overflow:hidden;color:var(--fg)}
.vh-hero-database .db-q i{font-style:normal;display:inline-block;animation:db-in 380ms var(--out) both}
.vh-hero-database .db-q .k{color:var(--muted)}
@keyframes db-in{from{opacity:0;transform:translateY(8px)}}
.vh-hero-database .db-h,.vh-hero-database .db-r{display:grid;grid-template-columns:20% 1fr 24%;align-items:center;padding:0 12px;font:12px var(--mono)}
.vh-hero-database .db-h{height:28px;box-shadow:inset 0 -1px 0 var(--line);color:var(--fg)}
.vh-hero-database .db-h small{margin-left:6px;color:var(--dim);font-size:11px}
.vh-hero-database .db-rows{position:relative;height:124px;margin:0 4px}
.vh-hero-database .db-r{position:absolute;left:0;right:0;top:2px;height:24px;padding:0 8px;border-radius:6px;color:var(--muted);transform:translateY(calc(var(--i)*24px));opacity:0;transition:opacity 400ms ease,background-color 400ms ease,color 300ms ease}
.vh-hero-database .db-r.on{opacity:1}
.vh-hero-database .db-r.on.dim{opacity:.32}
.vh-hero-database .db-r.hit{color:var(--fg);background:var(--soft)}
.vh-hero-database .db-r.flash{background:var(--soft);color:var(--fg)}
.vh-hero-database .db-r .b{transition:color 300ms ease}
.vh-hero-database .db-r .b.t{color:var(--ok)}
.vh-hero-database .db-r i{font-style:normal;display:inline-block;animation:db-in 380ms var(--out) both}
.vh-hero-database .db-res{height:30px;padding:0 12px;box-shadow:inset 0 1px 0 var(--line);font:11.5px/30px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vh-hero-database .db-res>span{display:inline-block;transition:opacity 300ms var(--out),transform 300ms var(--out)}
.vh-hero-database .db-res>span.off{opacity:0;transform:translateY(4px)}
.vh-hero-database .db-res b{font-weight:400;color:var(--fg)}
.vh-hero-database .db-res .n{display:none}
.vh-hero-database.fading .db-r,.vh-hero-database.fading .db-res>span,.vh-hero-database.fading .db-q i{opacity:0;transition:opacity 400ms}
@container (max-width:560px){
  .vh-hero-database .db-q{font-size:11px;padding:0 10px}
  .vh-hero-database .db-h,.vh-hero-database .db-r{font-size:11px;grid-template-columns:18% 1fr 30%}
  .vh-hero-database .db-h{padding:0 10px}
  .vh-hero-database .db-h small{margin-left:4px;font-size:10px}
  .vh-hero-database .db-res{font-size:10.5px;padding:0 10px}
}
@container (max-width:420px){
  .vh-hero-database .db-q{font-size:10.5px}
  .vh-hero-database .db-res .w{display:none}.vh-hero-database .db-res .n{display:inline}
  .vh-hero-database .db-lbl b{display:none}
  .vh-hero-database .db-h,.vh-hero-database .db-r{grid-template-columns:27% 1fr 30%}
}`;

export default defineScene<DatabasePlan>({
  css,
  key: "database",
  name: "Database",
  label: "A notes table with typed columns: id is a number, title is a string, done is a boolean. A query adds a row with db.insert(), another changes a cell with db.update(), and db.select() returns the matching rows while the other rows dim. The result has the TypeScript type of the table.",
  H: 242,
  steps: [
    "You write the tables in TypeScript. Each column has a type.",
    "db.insert() adds a row. The id counts up by itself.",
    "db.update() changes a value in the matching row.",
    "db.select() returns the matching rows, typed from your schema.",
  ],
  summary: "You write the tables in TypeScript. db.insert(), db.update(), and db.select() run on them, and each result has the type of your table.",
  plan(k) {
    const r = rng(k + 307);
    const pool = ["Buy milk", "Call the bank", "Fix login bug", "Book flights", "Water plants", "Pay rent", "Read chapter 3"];
    const rows: Row[] = [];
    for (let i = 0; i < 4; i++) {
      let t: string;
      do t = pick(r, pool); while (rows.some(x => x.title === t));
      rows.push({ id: i + 1, title: t, done: r() < .5 });
    }
    const second = rows[1]!;
    if (rows.every(x => x.done) || rows.every(x => !x.done)) second.done = !second.done;
    const added = pick(r, ["Ship docs", "Plan sprint", "Send invoice", "Walk the dog"]);
    const target = pick(r, rows.filter(x => !x.done)).id;
    const want = pick(r, [true, false]);
    const t0 = 900, ins = t0, upd = t0 + 3400, sel = t0 + 6800;
    return TL().done(sel + 4400, sel + 2400, { rows, added, target, want, ins, upd, sel });
  },
  render(stage) {
    stage.append(h(`<div class="db">
      <div class="db-lbl"><span>notes</span><b>src/database.ts</b></div>
      <div class="db-card">
        <div class="db-q"></div>
        <div class="db-h"><span>id<small>number</small></span><span>title<small>string</small></span><span>done<small>boolean</small></span></div>
        <div class="db-rows"></div>
        <div class="db-res"><span></span></div>
      </div>
    </div>`));
    const query = q(stage, ".db-q"), body = q(stage, ".db-rows"), res = q(stage, ".db-res>span");
    const R = [...Array(5)].map(() => { const el = h(`<div class="db-r"><span class="i"></span><span class="ti"></span><span class="b"></span></div>`); body.append(el); return el });
    const TYPE = `<b class="w">{ id: number; title: string; done: boolean }[]</b><b class="n">typed</b>`;
    return (t, p) => {
      const step = t < p.ins ? 0 : t < p.upd ? 1 : t < p.sel ? 2 : 3;
      const Q = [
        "",
        fs(`<span class="k">db.</span>insert(schema.notes).values({ title: '${p.added}' }).returning()`, `insert(notes).values({ title: '${p.added}' })`),
        fs(`<span class="k">db.</span>update(schema.notes).set({ done: true }).where(eq(schema.notes.id, ${p.target}))`, `update(notes).set({ done: true })`),
        fs(`<span class="k">db.</span>select().from(schema.notes).where(eq(schema.notes.done, ${p.want}))`, `select().where(eq(done, ${p.want}))`),
      ];
      put(query, step ? `<i>${Q[step]}</i>` : `<i><span class="k">const { db, schema } = useDatabase('default')</span></i>`);
      const rows = [...p.rows, { id: 5, title: p.added, done: false }];
      const hits = step === 3 && t >= p.sel + 700;
      rows.forEach((row, i) => {
        const el = R[i]!, a = q(el, ".i"), b = q(el, ".ti"), c = q(el, ".b");
        const done = row.id === p.target && t >= p.upd + 700 ? true : row.done;
        el.style.setProperty("--i", String(i));
        put(a, String(row.id)); put(b, `'${row.title}'`); put(c, `<i>${done}</i>`);
        cls(c, "t", done);
        cls(el, "on", i < 4 || t >= p.ins + 700);
        cls(el, "flash", (i === 4 && t >= p.ins + 700 && t < p.ins + 1800) || (row.id === p.target && t >= p.upd + 700 && t < p.upd + 1800));
        cls(el, "hit", hits && done === p.want);
        cls(el, "dim", hits && done !== p.want);
      });
      const n = rows.filter(x => (x.id === p.target ? true : x.done) === p.want).length;
      // The result line: the rows that come back and their type. It stays in place and only changes its text.
      const msg = step === 0 ? `typed rows from src/database.ts`
        : step === 1 ? (t >= p.ins + 1000 ? `→ 1 row: ${TYPE}` : "")
        : step === 2 ? (t >= p.upd + 1000 ? `→ ${fs("1 row changed", "1 changed")}` : "")
        : (t >= p.sel + 1000 ? `→ ${n} ${n === 1 ? "row" : "rows"}: ${TYPE}` : "");
      if (msg) put(res, msg);
      cls(res, "off", !msg);
      return step;
    };
  },
});
