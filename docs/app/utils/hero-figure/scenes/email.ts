// Email: three stacked layers. The Markdown template is at the back. The rendered email slides in front of it when
// the route gives it data, and email.send() hands it to the provider from the Vite config. The inbox notification
// arrives on top. Each loop the provider changes between Resend and Cloudflare Email, and the code stays the same.
import { defineScene, snap, rng, pick, fs, val, TL, icon, h, q, qa, cls, put } from "../engine";
import type { Timed, TimelinePlan } from "../engine";

interface Times {
  data: number;
  render: number;
  name: number;
  send: number;
  ok: number;
  inbox: number;
}
type EmailPlan = TimelinePlan<{ name: string; user: string; cf: boolean; prov: string; at: Times; step: Timed<number>[] }>;

const PEOPLE: [string, string][] = [["Ada", "ada"], ["Grace", "grace"], ["Linus", "linus"], ["Margaret", "margaret"], ["Alan", "alan"]];
const css = `.vh-hero-email svg.icon{position:static;inset:auto;width:13px;height:13px}
.vh-hero-email svg.icon path{fill:inherit;stroke:inherit;stroke-dasharray:none;vector-effect:none}.vh-hero-email svg.icon path[stroke]{fill:none;stroke:currentColor}
.vh-hero-email .tail.spin{display:inline-block}
.vh-hero-email .em{position:absolute;inset:0}
.vh-hero-email .em-l{position:absolute;border-radius:10px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line),0 10px 24px -14px color-mix(in oklab,var(--color-neutral-950) 22%,transparent);transition:opacity 450ms var(--out),transform 550ms var(--out),box-shadow 300ms ease}
.vh-hero-email .em-hd{display:flex;align-items:center;gap:6px;height:30px;padding-right:5px!important;padding:0 12px;box-shadow:inset 0 -1px 0 var(--line);font:11px var(--mono);color:var(--dim);white-space:nowrap;overflow:hidden}
.vh-hero-email .em-a{left:0;top:0;width:60%}
.vh-hero-email .em-a.back{opacity:.6;transform:scale(.98);transform-origin:0 0}
.vh-hero-email .em-md{padding:10px 12px 12px;font:12px/20px var(--mono);color:var(--muted)}
.vh-hero-email .em-md .h{color:var(--fg)}
.vh-hero-email .em-ph{white-space:nowrap;color:var(--fg);border-radius:4px;padding:0 2px;margin:0 -2px;transition:background-color 300ms ease,box-shadow 300ms ease}
.vh-hero-email .em-ph.on{background:var(--soft);box-shadow:inset 0 0 0 1px var(--dim)}
.vh-hero-email .em-data{margin-left:auto;padding:2px 8px;border-radius:99px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);font:11px/16px var(--mono);color:var(--muted);white-space:nowrap;opacity:0;transform:translateX(-6px);transition:opacity 300ms var(--out),transform 300ms var(--out)}
.vh-hero-email .em-data.on{opacity:1;transform:none}
.vh-hero-email .em-data b{font-weight:400;color:var(--fg)}
.vh-hero-email .em-data .n{display:none}
.vh-hero-email .em-a{z-index:1}
.vh-hero-email .em-b{left:20%;top:66px;width:64%;z-index:0;opacity:.75;transform:translateY(10px)}
.vh-hero-email .em-b.on{z-index:2;opacity:1;transform:none}
.vh-hero-email .sk{border-radius:4px;transition:color 300ms ease 150ms,background-color 300ms ease}
.vh-hero-email .em-b:not(.on) .sk{color:transparent;background:var(--soft)}
.vh-hero-email .em-b:not(.on) .pj{visibility:hidden}
.vh-hero-email .em-b.ok{box-shadow:inset 0 0 0 1px var(--ok),0 10px 24px -14px color-mix(in oklab,var(--color-neutral-950) 22%,transparent)}
.vh-hero-email .em-bd{padding:8px 12px 10px}
.vh-hero-email .em-f{display:grid;grid-template-columns:40px 1fr;height:18px;align-items:center;font:11px var(--mono);color:var(--dim)}
.vh-hero-email .em-f span{color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vh-hero-email .em-hr{height:1px;background:var(--line);margin:6px 0 8px}
.vh-hero-email .em-h{font:600 15px/22px var(--font-sans);color:var(--fg);white-space:nowrap}
.vh-hero-email .em-name{border-radius:4px;padding:0 2px;margin:0 -2px;transition:background-color 500ms ease}
.vh-hero-email .em-h.flash .em-name{background:var(--soft)}
.vh-hero-email .em-p{font:12.5px/20px var(--font-sans);color:var(--muted);white-space:nowrap}
.vh-hero-email .em-send{position:relative;height:30px;margin-top:6px}
.vh-hero-email .em-send .pj{position:absolute;left:0;top:50%;transform:translateY(-50%)}
.vh-hero-email .em-send .pj .body{clip-path:inset(calc(50% - 5px) calc(100% - 10px) calc(50% - 5px) 0 round 99px)}
.vh-hero-email .em-send .pj.open .body{clip-path:inset(0 0 0 0 round 99px)}
.vh-hero-email .em-c{right:0;top:160px;z-index:3;width:50%;display:flex;gap:10px;align-items:center;padding:10px 12px;opacity:0;transform:translateY(12px) scale(.98)}
.vh-hero-email .em-c.on{opacity:1;transform:none}
.vh-hero-email .em-ic{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--soft);color:var(--fg)}
.vh-hero-email .em-ic svg.icon{width:15px;height:15px}
.vh-hero-email .em-ct{min-width:0;flex:1}
.vh-hero-email .em-ct b{display:flex;justify-content:space-between;gap:8px;font:500 12.5px/18px var(--font-sans);color:var(--fg)}
.vh-hero-email .em-ct b i{font:400 11px/18px var(--mono);color:var(--dim);font-style:normal}
.vh-hero-email .em-ct>span{display:block;font:12px/17px var(--font-sans);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vh-hero-email.fading .em-b,.vh-hero-email.fading .em-c,.vh-hero-email.fading .em-data{opacity:0;transition:opacity 400ms}
@container (max-width:640px){
  .vh-hero-email .em-data .w{display:none}.vh-hero-email .em-data .n{display:inline}
}
@container (max-width:560px){
  .vh-hero-email .em-a{width:72%}
  .vh-hero-email .em-md{font-size:11px;line-height:19px;padding:8px 10px 10px}
  .vh-hero-email .em-data{font-size:10.5px;padding:3px 7px}
  .vh-hero-email .em-data .w{display:none}.vh-hero-email .em-data .n{display:inline}
  .vh-hero-email .em-b{left:14%;width:74%;top:64px}
  .vh-hero-email .em-bd{padding:8px 10px 10px}
  .vh-hero-email .em-hd{padding:0 10px}
  .vh-hero-email .em-f{grid-template-columns:34px 1fr;font-size:10.5px}
  .vh-hero-email .em-h{font-size:14px}
  .vh-hero-email .em-p{font-size:12px}
  .vh-hero-email .em-c{width:62%;top:172px;padding:8px 10px}
}`;

export default defineScene<EmailPlan>({
  css,
  key: "email",
  name: "Email",
  label: "Three stacked cards. At the back is a Markdown template, server/emails/welcome.md, with the placeholder data.user.name. The route gives it data, and the rendered email slides in front of it with the name filled in. email.send gives the message to the provider from the Vite config, Resend or Cloudflare Email. The provider accepts it, and an inbox notification arrives on top. The next time the provider is the other one, and the code is the same.",
  H: 244,
  steps: p => [
    "welcome.md is a Markdown template. Its placeholder waits for data.",
    `The route gives it { name: '${p.name}' }. renderEmailMarkdown() makes the email.`,
    `email.send() gives the message to ${p.prov}. The Vite config sets the provider, not the route.`,
    `${p.prov} accepts it, and the email arrives. With another provider, the code is the same.`,
  ],
  summary: "A Markdown template and data become an email. email.send() gives it to Resend or Cloudflare Email, and the route code stays the same.",
  plan(k) {
    const r = rng(k + 211);
    const [name, user] = pick(r, PEOPLE);
    const cf = k % 2 === 1;
    const ok = snap(5900 + r() * 400);
    const at: Times = { data: 1300, render: 2300, name: 2900, send: 4600, ok, inbox: ok + 700 };
    return TL().done(at.inbox + 3000, at.inbox + 900, { name, user, cf, prov: cf ? "Cloudflare Email" : "Resend", at, step: [[0, 0], [at.data, 1], [at.send, 2], [at.ok, 3]] });
  },
  render(stage) {
    stage.append(h(`<div class="em">
      <div class="em-l em-a"><div class="em-hd">${icon("lucide:file", 13)}${fs("server/emails/welcome.md", "welcome.md")}<span class="em-data"><span class="w">{ user: { name: <b class="em-dn"></b> } }</span><span class="n">name: <b class="em-dn"></b></span></span></div>
        <div class="em-md"><span class="h"># Welcome <span class="em-ph">{{ data.user.name }}</span></span><br><br>Your workspace is ready.</div></div>
      <div class="em-l em-b"><div class="em-hd">${icon("lucide:mail", 13)}${fs("renderEmailMarkdown() → email.send()", "email.send()")}</div>
        <div class="em-bd">
          <div class="em-f">from<span>team@acme.dev</span></div>
          <div class="em-f">to<span><span class="sk em-to"></span></span></div>
          <div class="em-hr"></div>
          <div class="em-h"><span class="sk">Welcome <span class="em-name"></span></span></div>
          <div class="em-p"><span class="sk">Your workspace is ready.</span></div>
          <div class="em-send"><span class="job pj"><span class="body"><span class="lab"></span><span class="tail"></span></span></span></div>
        </div></div>
      <div class="em-l em-c"><span class="em-ic">${icon("lucide:mail", 15)}</span><span class="em-ct"><b>Acme<i>now</i></b><span>Welcome <span class="em-cn"></span></span><span>Your workspace is ready.</span></span></div>
    </div>`));
    const $ = (s: string) => q(stage, s);
    const A = $(".em-a"), B = $(".em-b"), C = $(".em-c"), ph = $(".em-ph"), data = $(".em-data"), dn = qa(stage, ".em-dn");
    const to = $(".em-to"), head = $(".em-h"), nm = $(".em-name"), cn = $(".em-cn"), pill = $(".em-send .pj");
    const lab = q(pill, ".lab"), tail = q(pill, ".tail");
    return (t, p) => {
      const a = p.at;
      cls(ph, "on", t >= 500 && t < a.name + 300);
      cls(data, "on", t >= a.data);
      dn.forEach(e => put(e, `'${p.name}'`));
      // The rendered email comes forward, and the template moves back.
      cls(B, "on", t >= a.render);
      cls(A, "back", t >= a.render + 200);
      put(to, `${p.user}@example.com`);
      put(nm, p.name); put(cn, p.name);
      cls(head, "flash", t >= a.name && t < a.name + 900);
      cls(B, "ok", t >= a.ok && t < a.inbox + 1200);
      // The send pill: it opens with the provider name and closes with a check.
      const open = t >= a.send && t < a.ok + 900, tone = t >= a.ok ? "ok" : "";
      const c = `job pj ${tone}${open ? " open" : ""}`;
      if (pill.className !== c) pill.className = c;
      pill.style.opacity = t < a.send - 200 ? "0" : "1";
      put(lab, p.cf ? fs("cloudflare-email", "cloudflare") : "resend");
      const w = t < a.ok ? "spin" : "ok";
      if (tail.dataset.v !== w) { tail.dataset.v = w; tail.className = w === "spin" ? "tail spin" : "tail"; tail.textContent = w === "ok" ? "✓" : "" }
      // The inbox notification arrives on top.
      cls(C, "on", t >= a.inbox);
      return val(t, p.step, 0);
    };
  },
});
