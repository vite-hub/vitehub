// Realtime: two people edit welcome.md at the same time. Each screen shows both edits as they happen, and the other
// person's caret with their name and color. Two seconds after the last edit, the room saves the file.
import { defineScene, clamp, snap, rng, pick, fs, h, q, qa, prog, cls, put } from "../engine";

/** A person: a name and a color. */
type Person = [string, string];

interface Doc {
  h: string;
  a: string;
  b: string;
}
interface RealtimePlan {
  len: number;
  end: number;
  A: Person;
  B: Person;
  d: Doc;
  ja: number;
  jb: number;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  last: number;
  save: number;
  saved: number;
}

const PAIRS: [Person, Person][] = [
  [["Ada", "#2563eb"], ["Kai", "#c2410c"]],
  [["Lea", "#0e7490"], ["Sam", "#b45309"]],
  [["Mia", "#2563eb"], ["Tom", "#be185d"]],
];
const DOCS: Doc[] = [
  { h: "Welcome", a: "We meet on Mondays at 10.", b: "Bring one question for the demo." },
  { h: "Welcome", a: "Your laptop is on your desk.", b: "Ask Ana for a door badge." },
  { h: "Welcome", a: "The team lunch is on Friday.", b: "Pick a dish in the chat by noon." },
];

const css = `.vh-hero-realtime .r-root{position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;gap:20px}
.vh-hero-realtime .r-win{transition:none;display:flex;flex-direction:column;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden;min-width:0}
.vh-hero-realtime .r-bar{height:38px;flex-shrink:0;display:flex;align-items:center;gap:8px;padding:0 10px 0 14px;box-shadow:inset 0 -1px 0 var(--line);white-space:nowrap}
.vh-hero-realtime .r-fn{font:12px var(--mono);color:var(--fg)}
.vh-hero-realtime .r-st{display:inline-flex;align-items:center;gap:5px;font:11px var(--mono);color:var(--muted);transition:color 300ms ease;min-width:0;overflow:hidden}
.vh-hero-realtime .r-st>span{display:inline-block;animation:vh-fig-c 250ms var(--out);overflow:hidden;text-overflow:ellipsis}
.vh-hero-realtime .r-st.ok{color:var(--ok)}
.vh-hero-realtime .r-avs{margin-left:auto;display:flex}
.vh-hero-realtime .r-av{width:22px;height:22px;border-radius:99px;display:flex;align-items:center;justify-content:center;font:600 10px Geist,sans-serif;color:#fff;background:var(--c);box-shadow:0 0 0 2px var(--bg);transform:scale(0);transition:transform 420ms cubic-bezier(.34,1.56,.64,1)}
.vh-hero-realtime .r-av+.r-av{margin-left:-5px}
.vh-hero-realtime .r-av.on{transform:none}
.vh-hero-realtime .r-doc{flex:1;padding:16px 18px;font-size:13px;line-height:1.6}
.vh-hero-realtime .r-h{font-size:18px;font-weight:600;letter-spacing:-.01em;margin-bottom:8px}
.vh-hero-realtime .r-p{margin:0 0 10px;min-height:21px;color:var(--fg)}
.vh-hero-realtime .r-p.dim{color:var(--muted)}
.vh-hero-realtime .r-cr{position:relative;display:inline-block;width:2px;height:16px;margin-left:1px;vertical-align:-3px;background:var(--c)}
.vh-hero-realtime .r-cr.me{width:1px;background:var(--fg)}
.vh-hero-realtime .r-cr b{position:absolute;left:-1px;bottom:100%;padding:1px 5px;border-radius:4px 4px 4px 0;background:var(--c);color:#fff;font:500 10px/1.3 Geist,sans-serif;white-space:nowrap;transition:opacity 300ms ease}
.vh-hero-realtime .r-cr.idle b{opacity:0}
.vh-hero-realtime .r-cr.blink{animation:rtblink 900ms steps(1) infinite}
@keyframes rtblink{50%{opacity:0}}
.vh-hero-realtime .r-new{border-radius:3px;transition:background-color 600ms ease}
.vh-hero-realtime .r-foot{height:32px;flex-shrink:0;display:flex;align-items:center;gap:6px;padding:0 14px;box-shadow:inset 0 1px 0 var(--soft);font:11px var(--mono);color:var(--dim)}
.vh-hero-realtime .r-foot b{font-weight:400;color:var(--muted)}
@container (max-width:560px){
 .vh-hero-realtime .r-root{grid-template-columns:1fr}
 .vh-hero-realtime .r-win+.r-win{display:none}
 .vh-hero-realtime .r-doc{padding:12px 14px}
}`;

export default defineScene<RealtimePlan>({
  css,
  key: "realtime",
  name: "Realtime",
  label: "Two people open welcome.md on their own screens. Each one gets a name and a color. They type in different lines at the same time, and each screen shows both changes at once, with the other person's caret and name. They stop typing. Two seconds later, the room saves the document to welcome.md.",
  H: 214,
  steps: p => [
    `${p.A[0]} and ${p.B[0]} open welcome.md. Each person gets a name and a color.`,
    "They type at the same time. Each change shows on both screens, with the other person's caret.",
    "They stop typing. The room waits 2 seconds after the last edit.",
    "The room saves the document to welcome.md in the Workspace.",
  ],
  summary: "Two people edit welcome.md at the same time, see each other's carets, and the room saves the file after a pause.",
  plan(k) {
    const r = rng(k + 8118);
    const [A, B] = PAIRS[k % PAIRS.length]!, d = pick(r, DOCS);
    const j = () => snap(r() * 300);
    const ja = 300, jb = 800 + j();
    const a0 = 1500, a1 = a0 + d.a.length * 75, b0 = 2000 + j(), b1 = b0 + d.b.length * 70;
    const last = Math.max(a1, b1), save = last + 2000, saved = save + 500;
    return { len: saved + 2900, end: saved + 1500, A, B, d, ja, jb, a0, a1, b0, b1, last, save, saved };
  },
  render(stage) {
    const win = () => `<div class="r-win">
      <div class="r-bar"><span class="r-fn">welcome.md</span><span class="r-st"><span></span></span><span class="r-avs"><span class="r-av"></span><span class="r-av"></span></span></div>
      <div class="r-doc"><div class="r-h"></div><p class="r-p r-pa"></p><p class="r-p r-pb"></p></div>
      <div class="r-foot"></div>
    </div>`;
    const root = h(`<div class="r-root">${win()}${win()}</div>`);
    stage.append(root);
    const wins = qa(root, ".r-win");
    return (t, p, still) => {
      root.style.opacity = still ? "1" : (1 - clamp((t - (p.len - 500)) / 500)).toFixed(3);
      const ta = p.d.a.slice(0, Math.round(clamp((t - p.a0) / (p.a1 - p.a0)) * p.d.a.length));
      const tb = p.d.b.slice(0, Math.round(clamp((t - p.b0) / (p.b1 - p.b0)) * p.d.b.length));
      const people = [p.A, p.B] as const, texts = [ta, tb] as const, ends = [p.a1, p.b1] as const, starts = [p.a0, p.b0] as const, joins = [p.ja, p.jb] as const;
      wins.forEach((w, i) => {
        const me = i ? 1 : 0, other = i ? 0 : 1;
        w.style.opacity = still ? "1" : (.25 + .75 * prog(t, joins[me] - 200, joins[me] + 300)).toFixed(3);
        const avs = qa(w, ".r-av");
        // My own avatar first, then the other person.
        ([me, other] as const).forEach((who, j) => {
          const av = avs[j]!;
          av.style.setProperty("--c", people[who][1]); put(av, people[who][0].slice(0, 1)); cls(av, "on", t >= joins[who]);
        });
        put(q(w, ".r-h"), p.d.h);
        put(q(w, ".r-foot"), fs(`you are <b>${people[me][0]}</b> · ${t >= p.jb ? "2 people" : "1 person"} here`, `you are <b>${people[me][0]}</b>`));
        ([[".r-pa", 0], [".r-pb", 1]] as const).forEach(([sel, who]) => {
          const el = q(w, sel), mine = who === me, txt = texts[who];
          const on = t >= joins[who] && t >= joins[other] - (mine ? 1e9 : 0);
          const idle = t >= ends[who] + 1200;
          const c = !on ? "" : mine ? `<span class="r-cr me${t < starts[who] || t >= ends[who] ? " blink" : ""}"></span>`
            : `<span class="r-cr${idle || still ? " idle" : ""}" style="--c:${people[who][1]}"><b>${people[who][0]}</b></span>`;
          put(el, (txt || "") + c);
        });
        const st = q(w, ".r-st"), sl = q(st, "span");
        let s = "";
        if (t >= p.a0) s = "editing…";
        if (t >= p.last + 300) s = "unsaved";
        if (t >= p.save) s = "saving…";
        if (t >= p.saved) s = "✓ saved";
        put(sl, s);
        cls(st, "ok", t >= p.saved);
      });
      if (t >= p.save) return 3;
      if (t >= p.last + 300) return 2;
      if (t >= p.a0) return 1;
      return 0;
    };
  },
});
