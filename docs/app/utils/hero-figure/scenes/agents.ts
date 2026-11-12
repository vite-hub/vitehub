// Agents: one Slack thread. A person asks the Agent to fix a GitHub issue. The Agent's work shows as plain cards in
// its reply: it reads the issue, opens the file and writes the fixed line, opens a pull request, then answers in
// the thread. Each loop uses another person, issue, and file.
import { defineScene, clamp, snap, rng, pick, TL, icon, h, cls, put, q, type TimelinePlan } from "../engine";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const css = `.vh-hero-agents svg.icon{position:static;width:auto;height:auto}
.vh-hero-agents .icon path{stroke-dasharray:none;vector-effect:none;transition:none;fill:inherit;stroke:inherit;stroke-width:inherit}
.vh-hero-agents .icon path[fill="none"],.vh-hero-agents .icon g[fill="none"] path{fill:none;stroke:currentColor;stroke-width:2}
.vh-hero-agents .ag{position:absolute;inset:0;display:flex;flex-direction:column;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.vh-hero-agents .ag-h{display:flex;align-items:center;gap:8px;height:34px;flex-shrink:0;padding:0 14px;box-shadow:inset 0 -1px 0 var(--line);font:12px var(--mono);color:var(--muted);white-space:nowrap}
.vh-hero-agents .ag-h b{font-weight:500;color:var(--fg)}
.vh-hero-agents .ag-h .r{margin-left:auto;color:var(--dim)}
.vh-hero-agents .ag-b{flex:1;display:flex;flex-direction:column;gap:10px;padding:12px 14px;min-height:0}
.vh-hero-agents .ag-row{display:grid;grid-template-columns:22px 1fr;gap:10px;align-items:start}
.vh-hero-agents .av{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:var(--soft);box-shadow:inset 0 0 0 1px var(--line);font:500 11px var(--font-sans);color:var(--fg)}
.vh-hero-agents .ag-q{font-size:13px;line-height:22px;opacity:0;transform:translateY(5px);transition:opacity 300ms var(--out),transform 300ms var(--out)}
.vh-hero-agents .ag-q.on,.vh-hero-agents .ag-a.on{opacity:1;transform:none}
.vh-hero-agents .ag-q b{font-weight:500;margin-right:6px}
.vh-hero-agents .ag-a{opacity:0;transform:translateY(5px);transition:opacity 300ms var(--out),transform 300ms var(--out)}
.vh-hero-agents .ag-col{display:flex;flex-direction:column;gap:6px;min-width:0}
.vh-hero-agents .cd{display:flex;flex-direction:column;border-radius:8px;box-shadow:inset 0 0 0 1px var(--line);font:12px var(--mono);min-width:0;opacity:0;transform:translateY(5px);transition:opacity 300ms var(--out),transform 300ms var(--out),box-shadow 300ms ease}
.vh-hero-agents .cd.on{opacity:1;transform:none}
.vh-hero-agents .cd.busy{box-shadow:inset 0 0 0 1px var(--fg)}
.vh-hero-agents .cd-h{display:flex;align-items:center;gap:8px;height:28px;padding:0 10px;white-space:nowrap;min-width:0}
.vh-hero-agents .cd-h .t{overflow:hidden;text-overflow:ellipsis;min-width:0;color:var(--fg)}
.vh-hero-agents .cd-h .n{color:var(--muted)}
.vh-hero-agents .cd-h .st{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--ok);flex-shrink:0}
.vh-hero-agents .cd-h .ic{display:flex;color:var(--fg)}
.vh-hero-agents .cd-h .badge{padding:1px 7px;border-radius:99px;font-size:11px;color:var(--ok);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--ok) 45%,transparent);opacity:0;transition:opacity 300ms ease}
.vh-hero-agents .cd-h .badge.on{opacity:1}
.vh-hero-agents .cd-f .cd-h{box-shadow:inset 0 -1px 0 var(--line)}
.vh-hero-agents .ln{position:relative;display:flex;gap:8px;height:20px;align-items:center;padding:0 10px;white-space:pre;overflow:hidden;color:var(--muted);transition:background-color 300ms ease,color 300ms ease}
.vh-hero-agents .ln .m{width:8px;flex-shrink:0;color:var(--dim);transition:color 300ms ease}
.vh-hero-agents .ln.del{background:color-mix(in oklab,var(--err) 9%,transparent);color:var(--err)}
.vh-hero-agents .ln.del .m{color:var(--err)}
.vh-hero-agents .ln.del .c{text-decoration:line-through}
.vh-hero-agents .ln.add{background:color-mix(in oklab,var(--ok) 9%,transparent);color:var(--ok)}
.vh-hero-agents .ln.add .m{color:var(--ok)}
.vh-hero-agents .ln .car{display:inline-block;width:6px;height:13px;margin-left:1px;vertical-align:-2px;background:currentColor;opacity:.6}
.vh-hero-agents .ag-r{font-size:13px;line-height:1.45;color:var(--fg);margin-top:2px;min-height:19px}
.vh-hero-agents .ag-r .car{display:inline-block;width:6px;height:13px;margin-left:2px;vertical-align:-2px;background:var(--fg);opacity:.5}
.vh-hero-agents .sp{display:inline-block;width:10px;height:10px;border:1.5px solid var(--line);border-top-color:var(--fg);border-radius:99px;animation:vh-fig-s 700ms linear infinite}
.vh-hero-agents.fading .ag-q,.vh-hero-agents.fading .ag-a{opacity:0;transition:opacity 400ms}
@container (max-width:560px){
  .vh-hero-agents .ag-h{padding:0 10px}.vh-hero-agents .ag-h .r{display:none}
  .vh-hero-agents .ag-b{padding:10px;gap:8px}
  .vh-hero-agents .ag-row{grid-template-columns:20px 1fr;gap:8px}
  .vh-hero-agents .av{width:20px;height:20px}
  .vh-hero-agents .ag-q,.vh-hero-agents .ag-r{font-size:12px}
  .vh-hero-agents .cd{font-size:11px}
  .vh-hero-agents .cd-h{padding:0 8px;gap:6px}.vh-hero-agents .ln{padding:0 8px;gap:6px}
  .vh-hero-agents .cd-h .n.full{display:none}
}`;


interface Story {
  names: string[];
  q: string;
  issue: [string, string];
  file: string;
  old: string;
  fix: string;
  pr: [string, string];
  a: string;
}
interface Times {
  msg: number;
  issue: number;
  issueDone: number;
  file: number;
  del: number;
  type: number;
  typed: number;
  fileDone: number;
  pr: number;
  prDone: number;
  reply: number;
  done: number;
}
type AgentsPlan = TimelinePlan<{ s: Story & { name: string }; A: Times }>;

const STORIES: [Story, Story, Story] = [
  { names: ["Maya", "Theo"], q: "Can you fix issue #318?", issue: ["#318", "Build fails on main"], file: "src/env.ts",
    old: "import { cfg } from './config'", fix: "import { cfg } from './settings'", pr: ["#319", "Fix the config import"],
    a: "Done. config.ts is now settings.ts. PR #319 fixes the import." },
  { names: ["Kai", "Zoe"], q: "Can you take issue #42?", issue: ["#42", "Docs link in README is broken"], file: "README.md",
    old: "[Docs](https://acme.dev/doc)", fix: "[Docs](https://acme.dev/docs)", pr: ["#43", "Fix the docs link"],
    a: "The link pointed to /doc. PR #43 changes it to /docs." },
  { names: ["Lin", "Sam"], q: "Please look at issue #207.", issue: ["#207", "Typo on the sign-in button"], file: "src/SignIn.vue",
    old: "<button>Sing in</button>", fix: "<button>Sign in</button>", pr: ["#208", "Fix the sign-in typo"],
    a: "I fixed the typo in SignIn.vue. PR #208 is ready for review." },
];

export default defineScene<AgentsPlan>({
  css,
  key: "agents",
  name: "Agents",
  label: "A Slack thread. A person asks the Agent to fix a GitHub issue. The Agent reads the issue, opens the file and writes the fixed line, opens a pull request, then replies in the same thread.",
  H: 256,
  steps: p => [
    `${p.s.name} asks the Agent in Slack to fix issue ${p.s.issue[0]}.`,
    "The Agent reads the issue on GitHub.",
    `It opens ${p.s.file} and writes the fix.`,
    `It opens pull request ${p.s.pr[0]} and replies in the same thread.`,
  ],
  summary: "A person asks the Agent in Slack to fix an issue. The Agent reads the issue on GitHub, writes the fix in the file, opens a pull request, and replies in the same thread.",
  plan(k) {
    const r = rng(k + 907);
    const base = STORIES[k % 3] ?? STORIES[0];
    const s = { ...base, name: pick(r, base.names) };
    const j = () => snap(r() * 200);
    const msg = 500;
    const issue = 1500 + j(), issueDone = issue + 1000;
    const file = issueDone + 300, del = file + 700, type = del + 500, typed = type + 1100, fileDone = typed + 250;
    const pr = fileDone + 350 + j(), prDone = pr + 900;
    const reply = prDone + 400, done = reply + 1800;
    const A: Times = { msg, issue, issueDone, file, del, type, typed, fileDone, pr, prDone, reply, done };
    return TL().done(A.done + 2600, A.done + 600, { s, A });
  },
  render(stage) {
    stage.append(h(`<div class="ag">
      <div class="ag-h">${icon("simple-icons:slack", 14)}<b>#support</b><span class="r">thread</span></div>
      <div class="ag-b">
        <div class="ag-row ag-q"><span class="av q"></span><span class="tx"></span></div>
        <div class="ag-row ag-a"><span class="av">${icon("lucide:bot", 13)}</span><div class="ag-col">
          <div class="cd cd-i"><div class="cd-h"><span class="ic">${icon("simple-icons:github", 13)}</span><span class="n"></span><span class="t"></span><span class="st"></span></div></div>
          <div class="cd cd-f"><div class="cd-h"><span class="ic">${icon("lucide:file-text", 13)}</span><span class="t"></span><span class="st"></span></div>
            <div class="ln l0"><span class="m"> </span><span class="c"></span></div><div class="ln l1"><span class="m"> </span><span class="c"></span></div></div>
          <div class="cd cd-p"><div class="cd-h"><span class="ic">${icon("lucide:git-pull-request", 13)}</span><span class="n"></span><span class="t"></span><span class="st"><span class="badge">Open</span></span></div></div>
          <div class="ag-r"></div>
        </div></div>
      </div>
    </div>`));
    const $ = (s: string) => q(stage, s);
    const ask = $(".ag-q"), askAv = $(".av.q"), askTx = $(".ag-q .tx"), ans = $(".ag-a");
    const ci = $(".cd-i"), cf = $(".cd-f"), cp = $(".cd-p"), l0 = $(".l0"), l1 = $(".l1"), rep = $(".ag-r");
    const st = (el: HTMLElement, busy: boolean, done: boolean, extra = "") => put(q(el, ".st"), `${extra}${busy && !done ? `<i class="sp"></i>` : done ? icon("lucide:check", 13) : ""}`);
    return (t, p, still) => {
      const { s, A } = p;
      put(askAv, s.name.slice(0, 1)); put(askTx, `<b>${s.name}</b>${s.q}`);
      cls(ask, "on", t >= A.msg); cls(ans, "on", t >= A.issue - 200);
      // Read the issue.
      put(q(ci, ".n"), s.issue[0]); put(q(ci, ".t"), esc(s.issue[1]));
      cls(ci, "on", t >= A.issue); cls(ci, "busy", t >= A.issue && t < A.issueDone);
      st(ci, t >= A.issue, t >= A.issueDone);
      // Open the file, mark the old line, write the new one.
      put(q(cf, ".t"), s.file);
      cls(cf, "on", t >= A.file); cls(cf, "busy", t >= A.file && t < A.fileDone);
      st(cf, t >= A.file, t >= A.fileDone);
      cls(l0, "del", t >= A.del);
      put(q(l0, ".m"), t >= A.del ? "-" : " "); put(q(l0, ".c"), esc(s.old));
      const n = Math.round(clamp((t - A.type) / (A.typed - A.type)) * s.fix.length);
      cls(l1, "add", t >= A.type);
      put(q(l1, ".m"), t >= A.type ? "+" : " ");
      put(q(l1, ".c"), t >= A.type ? `${esc(s.fix.slice(0, n))}${n < s.fix.length && !still ? `<i class="car"></i>` : ""}` : "");
      // Open the pull request.
      put(q(cp, ".n"), s.pr[0]); put(q(cp, ".t"), esc(s.pr[1]));
      cls(cp, "on", t >= A.pr); cls(cp, "busy", t >= A.pr && t < A.prDone);
      put(q(cp, ".st"), t >= A.prDone ? `<span class="badge on">Open</span>` : t >= A.pr ? `<i class="sp"></i>` : "");
      // Reply in the thread.
      const m = Math.round(clamp((t - A.reply) / (A.done - A.reply)) * s.a.length);
      put(rep, t >= A.reply ? `${s.a.slice(0, m)}${m < s.a.length && !still ? `<i class="car"></i>` : ""}` : "");
      return t < A.issue ? 0 : t < A.file ? 1 : t < A.pr ? 2 : 3;
    };
  },
});
