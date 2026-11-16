// Forms: the schema on the left builds the working form on the right, field by field. A visitor types and sends.
// The server checks the message with the same schema, and one field gets its error. The visitor fixes it and
// sends again. The message lands in the inbox, and an email goes to you with a reply address of the sender.
import { defineScene, snap, rng, pick, fs, val, TL, icon, h, q, qa, cls, put } from "../engine";
import type { Timed, TimelinePlan } from "../engine";

type Field = "email" | "message";
type Values = Record<Field, string>;
interface Times {
  e: number;
  eOn: number;
  m: number;
  mOn: number;
  btn: number;
  typeE: number;
  typeM: number;
  send: number;
  err: number;
  fix: number;
  fixEnd: number;
  send2: number;
  ok: number;
  inbox: number;
  mail: number;
}
type FormsPlan = TimelinePlan<{ who: string; bad: Field; first: Values; fixed: Values; at: Times; step: Timed<number>[] }>;

const PEOPLE = ["ada", "grace", "linus", "alan", "edsger", "barbara"];
const MSGS = ["I want to build a shop.", "Can you help with my docs?", "Do you take new projects?"];
const css = `.vh-hero-forms svg.icon{position:static;inset:auto;width:13px;height:13px}
.vh-hero-forms svg.icon path{fill:inherit;stroke:inherit;stroke-dasharray:none;vector-effect:none}.vh-hero-forms svg.icon path[stroke]{fill:none;stroke:currentColor}
.vh-hero-forms .tail.spin{display:inline-block}
.vh-hero-forms .fm{position:absolute;inset:0;display:grid;grid-template-columns:47% 49%;justify-content:space-between;align-items:stretch}
.vh-hero-forms .fm-card{display:flex;flex-direction:column;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden;min-width:0}
.vh-hero-forms .fm-hd{display:flex;align-items:center;gap:6px;height:30px;flex:none;padding:0 12px;box-shadow:inset 0 -1px 0 var(--line);font:11px var(--mono);color:var(--dim);white-space:nowrap;overflow:hidden}
.vh-hero-forms .fm-code{flex:1;display:flex;flex-direction:column;justify-content:center;padding:8px 0;font:11px/20px var(--mono);color:var(--muted);white-space:pre;overflow:hidden}
.vh-hero-forms .fm-l{padding:0 12px;transition:background-color 300ms ease,color 300ms ease}
.vh-hero-forms .fm-l.on{background:var(--soft);color:var(--fg)}
.vh-hero-forms .fm-l.err{color:var(--err)}
.vh-hero-forms .fm-l b{font-weight:400;color:var(--fg)}
.vh-hero-forms .fm-form{flex:1;display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px}
.vh-hero-forms .fm-field{opacity:0;transform:translateY(5px);transition:opacity 350ms var(--out),transform 350ms var(--out)}
.vh-hero-forms .fm-field.on{opacity:1;transform:none}
.vh-hero-forms .fm-row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;height:16px;margin-bottom:4px;white-space:nowrap}
.vh-hero-forms .fm-name{font:500 12px/16px var(--font-sans);color:var(--fg)}
.vh-hero-forms .fm-e{font:11px/16px var(--font-sans);color:var(--err);overflow:hidden;text-overflow:ellipsis;opacity:0;transform:translateX(4px);transition:opacity 250ms var(--out),transform 250ms var(--out)}
.vh-hero-forms .fm-e.on{opacity:1;transform:none}
.vh-hero-forms .fm-in{height:26px;border-radius:6px;box-shadow:inset 0 0 0 1px var(--line);padding:0 8px;font:12px/26px var(--font-sans);color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:box-shadow 250ms ease}
.vh-hero-forms .fm-in.focus{box-shadow:inset 0 0 0 1px var(--fg)}
.vh-hero-forms .fm-in.bad{box-shadow:inset 0 0 0 1px var(--err)}
.vh-hero-forms .fm-caret{display:inline-block;width:1px;height:13px;margin-left:1px;vertical-align:-2px;background:var(--fg);animation:fm-blink 1s steps(1) infinite}
@keyframes fm-blink{50%{opacity:0}}
.vh-hero-forms .fb{display:flex;align-items:center;gap:10px;margin-top:2px;min-width:0}
.vh-hero-forms .fm-btn{position:relative;flex:none;display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 12px;border-radius:7px;background:var(--fg);color:var(--bg);font:500 12px var(--font-sans);transition:background-color 300ms ease,transform 150ms ease}
.vh-hero-forms .fm-btn.press{transform:scale(.96)}
.vh-hero-forms .fm-btn.ok{background:var(--ok)}
.vh-hero-forms .fm-btn .tail{width:auto}
.vh-hero-forms .fm-st{display:flex;align-items:center;gap:5px;min-width:0;font:11px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;opacity:0;transition:opacity 250ms ease}
.vh-hero-forms .fm-st .w svg{margin:0 4px 0 2px}
.vh-hero-forms .fm-st.on{opacity:1}.vh-hero-forms .fm-st.err{color:var(--err)}.vh-hero-forms .fm-st.ok{color:var(--ok)}
.vh-hero-forms .fm-st>span{display:inline-flex;align-items:center;gap:5px;animation:vh-fig-c 250ms var(--out)}
.vh-hero-forms.fading .fm-field{opacity:0;transition:opacity 400ms}
@container (max-width:560px){
  .vh-hero-forms .fm{grid-template-columns:48% 49%}
  .vh-hero-forms .fm-hd{padding:0 10px}
  .vh-hero-forms .fm-code{font-size:10px;line-height:19px}
  .vh-hero-forms .fm-l{padding:0 10px}
  .vh-hero-forms .fm-form{padding:10px 10px 12px}
  .vh-hero-forms .fm-in{font-size:11.5px;padding:0 7px}
  .vh-hero-forms .fm-btn{padding:0 10px}
}
@container (max-width:420px){
  .vh-hero-forms .fm-code{font-size:9.5px;line-height:18px}
  .vh-hero-forms .fm-l{padding:0 8px}
  .vh-hero-forms .fm-st .w{display:none}
  .vh-hero-forms .fm-e .w{display:none}
  .vh-hero-forms .fm-form{padding:10px 8px 12px}
  .vh-hero-forms .fm-in{font-size:11px;padding:0 6px}
}`;

export default defineScene<FormsPlan>({
  css,
  key: "forms",
  name: "Forms",
    label: "The ContactSchema code is on the left. AutoForm builds a working contact form from it, field by field. A visitor types and sends the form. The server checks the message with the same schema, and one field shows its error. The visitor fixes it and sends again. The message is stored in the inbox, and an email goes to you with a reply address of the sender.",
  H: 190,
  steps: p => [
    "ContactSchema lists the fields of the form and their rules.",
    "AutoForm builds the form from the same schema, field by field.",
    p.bad === "email" ? "A visitor sends it. The email breaks a rule, so the server returns 400 with the error on that field." : "A visitor sends it. The message is too short, so the server returns 400 with the error on that field.",
    "The visitor fixes it and sends again. The message goes to the inbox, and you get an email.",
  ],
  summary: "One schema builds the form and checks each message. A bad field gets its error, and a good message lands in the inbox and in your email.",
  plan(k) {
    const r = rng(k + 401);
    const who = pick(r, PEOPLE), bad: Field = k % 2 ? "message" : "email";
    const full: Values = { email: `${who}@example.com`, message: pick(r, MSGS) };
    const first: Values = { email: bad === "email" ? `${who}@example` : full.email, message: bad === "message" ? "Hi!" : full.message };
    const fixed: Values = { email: full.email, message: bad === "message" ? `Hi! ${full.message}` : full.message };
    const typeE = 3700;
    const typeM = typeE + first.email.length * 55 + 300;
    const send = typeM + first.message.length * 40 + 400;
    const err = send + 800;
    const fix = err + 1400;
    const fixLen = fixed[bad].length - first[bad].length;
    const fixEnd = fix + fixLen * (bad === "email" ? 90 : 40);
    const send2 = fixEnd + 500, ok = send2 + snap(700 + r() * 300);
    const A: Times = { e: 900, eOn: 1300, m: 2000, mOn: 2400, btn: 3000, typeE, typeM, send, err, fix, fixEnd, send2, ok, inbox: ok + 300, mail: ok + 800 };
    return TL().done(A.mail + 2600, A.mail + 600, { who, bad, first, fixed, at: A, step: [[0, 0], [A.e, 1], [A.send, 2], [A.fix, 3]] });
  },
  render(stage) {
    stage.append(h(`<div class="fm">
      <div class="fm-card"><div class="fm-hd">${icon("lucide:file", 13)}shared/schemas.ts</div><div class="fm-code"><div class="fm-l">${fs("<b>ContactSchema</b> = v.object({", "<b>Contact</b> = v.object({")}</div><div class="fm-l">  email: v.pipe(${fs("v.string(),", "")}</div><div class="fm-l">    ${fs("v.email('Enter a valid email.')),", "v.email(…)),")}</div><div class="fm-l">  message: v.pipe(${fs("v.string(),", "")}</div><div class="fm-l">    ${fs("v.minLength(10, 'Tell me more.')),", "v.minLength(10)),")}</div><div class="fm-l">})</div></div></div>
      <div class="fm-card"><div class="fm-hd">${icon("lucide:mail", 13)}${fs('&lt;AutoForm name="contact" /&gt;', "&lt;AutoForm /&gt;")}</div><div class="fm-form">
        <div class="fm-field fe"><div class="fm-row"><span class="fm-name">Email</span><span class="fm-e">Enter a valid email.</span></div><div class="fm-in"></div></div>
        <div class="fm-field fmm"><div class="fm-row"><span class="fm-name">Message</span><span class="fm-e">Tell me more.</span></div><div class="fm-in"></div></div>
        <div class="fm-field fb"><span class="fm-btn"><span class="fm-bt"></span><span class="tail"></span></span><span class="fm-st"></span></div>
      </div></div></div>`));
    const L = qa(stage, ".fm-l");
    const fe = q(stage, ".fe"), fmm = q(stage, ".fmm"), fb = q(stage, ".fb");
    const ie = q(fe, ".fm-in"), im = q(fmm, ".fm-in"), ee = q(fe, ".fm-e"), em = q(fmm, ".fm-e");
    const btn = q(stage, ".fm-btn"), bt = q(stage, ".fm-bt"), tail = q(btn, ".tail"), st = q(stage, ".fm-st");
    return (t, p) => {
      const A = p.at, bad = p.bad;
      // Schema lines light up as their field is built, and the broken rule turns red.
      const ruleLine = bad === "email" ? 2 : 4;
      L.forEach((l, i) => {
        const grp = i === 1 || i === 2 ? "e" : i === 3 || i === 4 ? "m" : "";
        cls(l, "on", (grp === "e" && t >= A.e && t < A.m) || (grp === "m" && t >= A.m && t < A.btn + 300) || (i === ruleLine && t >= A.err && t < A.fixEnd));
        cls(l, "err", i === ruleLine && t >= A.err && t < A.fixEnd);
      });
      cls(fe, "on", t >= A.eOn); cls(fmm, "on", t >= A.mOn); cls(fb, "on", t >= A.btn);
      // What the visitor has typed.
      const value = (f: Field, typeAt: number) => {
        const first = p.first[f], fixed = p.fixed[f];
        if (t < typeAt) return "";
        if (bad === f && t >= A.fix) return first + fixed.slice(first.length, first.length + Math.floor((t - A.fix) / (f === "email" ? 90 : 40)));
        return first.slice(0, Math.floor((t - typeAt) / (f === "email" ? 55 : 40)));
      };
      const vE = value("email", A.typeE), vM = value("message", A.typeM);
      const focusE = (t >= A.typeE && t < A.typeM) || (bad === "email" && t >= A.fix && t < A.send2);
      const focusM = (t >= A.typeM && t < A.send) || (bad === "message" && t >= A.fix && t < A.send2);
      const caret = `<span class="fm-caret"></span>`;
      put(ie, vE + (focusE ? caret : ""));
      put(im, vM + (focusM ? caret : ""));
      const showErr = t >= A.err && t < A.fixEnd;
      cls(ie, "focus", focusE); cls(im, "focus", focusM);
      cls(ie, "bad", showErr && bad === "email"); cls(im, "bad", showErr && bad === "message");
      cls(ee, "on", showErr && bad === "email"); cls(em, "on", showErr && bad === "message");
      // The button and the answer of the server.
      const busy = (t >= A.send && t < A.err) || (t >= A.send2 && t < A.ok), done = t >= A.ok;
      cls(btn, "press", (t >= A.send && t < A.send + 150) || (t >= A.send2 && t < A.send2 + 150));
      cls(btn, "ok", done);
      put(bt, done ? "Sent" : "Send");
      const w = busy ? "spin" : done ? "ok" : "";
      if (tail.dataset.v !== w) { tail.dataset.v = w; tail.className = w === "spin" ? "tail spin" : "tail"; tail.textContent = w === "ok" ? "✓" : "" }
      let s = "", tone = "";
      if (t >= A.err && t < A.send2) { s = `<span>400<span class="w"> · 1 issue</span></span>`; tone = "err" }
      if (t >= A.ok) { s = `<span>${icon("lucide:inbox", 13)}inbox</span>`; tone = "ok" }
      if (t >= A.mail) s = `<span>${icon("lucide:inbox", 13)}inbox<span class="w"> · ${icon("lucide:mail", 13)}emailed</span></span>`;
      put(st, s); st.className = `fm-st ${tone}${s ? " on" : ""}`;
      return val(t, p.step, 0);
    };
  },
});
