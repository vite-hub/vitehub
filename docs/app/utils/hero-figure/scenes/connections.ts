// Connections: four connected accounts as cards. Server calls run one at a time. Each call lights the Connection it
// uses, which adds its own token. Before one Google call the token is about to expire, and ViteHub refreshes it.
import { defineScene, snap, rng, pick, fs, TL, icon, h, q, cls, put, type TimelinePlan } from "../engine";

type Service = "google" | "github" | "slack" | "notion";
/** One server call: the Connection it uses, what it shows, and when it runs. */
interface Call {
  c: Service;
  op: string;
  code: string;
  at: number;
  refresh: boolean;
  /** When ViteHub starts to refresh the token, for the call that needs it. */
  refAt?: number;
}
type ConnectionsPlan = TimelinePlan<{ calls: Call[]; exp: string }>;

const css = `.vh-hero-connections svg.icon{position:static;width:auto;height:auto}
.vh-hero-connections .icon path{stroke-dasharray:none;vector-effect:none;transition:none;fill:inherit;stroke:inherit;stroke-width:inherit}
.vh-hero-connections .icon path[fill="none"]{fill:none;stroke:currentColor;stroke-width:2}
.vh-hero-connections .cn{position:absolute;inset:0;display:grid;grid-template-columns:44% 1fr;gap:4cqi}
.vh-hero-connections .cn-cap{height:22px;color:var(--muted);font:11px var(--mono)}
.vh-hero-connections .cn-feed{position:relative}
.vh-hero-connections .cn-l{display:flex;align-items:center;gap:10px;height:40px;margin-bottom:4px;padding:0 10px;border-radius:8px;font:12px var(--mono);white-space:nowrap;color:var(--muted);opacity:0;transform:translateY(5px);transition:opacity 300ms var(--out),transform 300ms var(--out),background-color 300ms ease,color 300ms ease}
.vh-hero-connections .cn-l.on{opacity:1;transform:none}
.vh-hero-connections .cn-l.cur{background:var(--soft);color:var(--fg)}
.vh-hero-connections .cn-l .lg{display:flex;color:var(--fg)}
.vh-hero-connections .cn-l .op{overflow:hidden;text-overflow:ellipsis}
.vh-hero-connections .cn-l .op small{color:var(--muted);font-size:11px;margin-right:6px}
.vh-hero-connections .cn-l .st{margin-left:auto;display:flex;align-items:center;gap:4px;color:var(--ok)}
.vh-hero-connections .sp{display:inline-block;width:10px;height:10px;border:1.5px solid var(--line);border-top-color:var(--fg);border-radius:99px;animation:vh-fig-s 700ms linear infinite}
.vh-hero-connections .cn-g{display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:1fr;gap:10px;height:calc(100% - 22px)}
.vh-hero-connections .cn-c{position:relative;display:flex;flex-direction:column;justify-content:space-between;padding:12px 14px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);min-width:0;transition:box-shadow 300ms ease,background-color 300ms ease}
.vh-hero-connections .cn-c.on{box-shadow:inset 0 0 0 1px var(--fg)}
.vh-hero-connections .cn-c.ref{box-shadow:inset 0 0 0 1px var(--warn)}
.vh-hero-connections .cn-c .top{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500}
.vh-hero-connections .cn-c .top .d{margin-left:auto;width:7px;height:7px;border-radius:9px;background:var(--ok);box-shadow:0 0 0 3px color-mix(in oklab,var(--ok) 18%,transparent)}
.vh-hero-connections .cn-c .kd{font:11px var(--mono);color:var(--muted)}
.vh-hero-connections .cn-c .ev{position:relative;height:16px;font:11px var(--mono)}
.vh-hero-connections .cn-c .ev>span{position:absolute;left:0;top:0;display:flex;align-items:center;gap:6px;white-space:nowrap;opacity:0;transform:translateY(4px);transition:opacity 280ms var(--out),transform 280ms var(--out)}
.vh-hero-connections .cn-c .ev>span.on{opacity:1;transform:none}
.vh-hero-connections .cn-c .ev .tk{color:var(--fg)}
.vh-hero-connections .cn-c .ev .w{color:var(--warn)}
.vh-hero-connections .cn-c .ev .ok{color:var(--ok)}
.vh-hero-connections .cn-c .ev .idle{color:var(--dim)}
.vh-hero-connections.fading .cn-l{opacity:0;transition:opacity 400ms}
@container (max-width:640px){
  .vh-hero-connections .cn-l .op .full{display:none}.vh-hero-connections .cn-l .op .short{display:inline}
}
@container (max-width:560px){
  .vh-hero-connections .cn{grid-template-columns:57% 1fr;gap:10px}
  .vh-hero-connections .cn-l{font-size:10.5px;gap:6px;padding:0 6px}
  .vh-hero-connections .cn-l .op small{display:none}
  .vh-hero-connections .cn-g{grid-template-columns:1fr;gap:6px}
  .vh-hero-connections .cn-c{flex-direction:row;align-items:center;padding:0 8px}
  .vh-hero-connections .cn-c .kd,.vh-hero-connections .cn-c .top .nm{display:none}
  .vh-hero-connections .cn-c .top{gap:6px}
  .vh-hero-connections .cn-c .ev{width:84px;font-size:10px}
  .vh-hero-connections .cn-c .ev>span{left:auto;right:0}
  .vh-hero-connections .cn-c .top .d{margin-left:0}
}`;


export default defineScene<ConnectionsPlan>({
  css,
  key: "connections",
  name: "Connections",
  label: "Four connected accounts: Google, GitHub, Slack, and Notion. Server calls run one at a time, and each call lights the Connection it uses. The Connection adds its own token, so the code never holds one. Before one Google call, the token is about to expire, and ViteHub refreshes it first.",
  H: 240,
  steps: [
    "Each account is connected once. The app keeps the tokens encrypted.",
    "Code calls an API through useConnection(name). The Connection adds its token.",
    "The Google token expires soon. ViteHub refreshes it before the call.",
    "Each token goes only to its own API. The code never holds one.",
  ],
  summary: "Google, GitHub, Slack, and Notion are connected once. Each call uses its own Connection, which adds the token and refreshes it when it expires, so the code never holds a token.",
  plan(k) {
    const r = rng(k + 709);
    const CALLS: Record<Service, [string, string][]> = {
      github: [[fs("<small>POST</small>/repos/acme/web/issues", "POST /issues"), "201"], [fs("<small>GET</small>/repos/acme/web/pulls", "GET /pulls"), "200"]],
      slack: [[fs("<small>POST</small>/api/chat.postMessage", "chat.postMessage"), "200"]],
      notion: [[fs("<small>POST</small>/v1/pages", "POST /v1/pages"), "200"]],
      google: [[fs("gmail.users.messages.list()", "messages.list()"), "200"], [fs("gmail.users.drafts.create()", "drafts.create()"), "200"], [fs("gmail.users.labels.list()", "labels.list()"), "200"]],
    };
    const others: Service[] = ["github", "slack", "notion"];
    others.sort(() => r() - 0.5);
    // Google is always the third call.
    const order: Service[] = [...others.slice(0, 2), "google", ...others.slice(2)];
    const t0 = 900;
    let t = t0;
    const calls = order.map((c): Call => {
      const [op, code] = pick(r, CALLS[c]);
      const x: Call = { c, op, code, at: t, refresh: c === "google" };
      if (x.refresh) { x.refAt = t; x.at = t + 1700; }
      t = x.at + 1900 + snap(r() * 200);
      return x;
    });
    const last = calls.at(-1)?.at ?? t0;
    return TL().done(last + 3600, last + 1600, { calls, exp: pick(r, ["40s", "52s", "35s"]) });
  },
  render(stage) {
    const CARDS: [Service, string, string][] = [
      ["google", icon("simple-icons:google", 16), "OAuth · gmail"],
      ["github", icon("simple-icons:github", 16), "API key"],
      ["slack", icon("simple-icons:slack", 16), "API key"],
      ["notion", icon("simple-icons:notion", 16), "API key"],
    ];
    const LOGO: Record<Service, string> = { google: "", github: "", slack: "", notion: "" };
    for (const [n, i] of CARDS) LOGO[n] = i;
    stage.append(h(`<div class="cn">
      <div><div class="cn-cap">useConnection(name)</div><div class="cn-feed"></div></div>
      <div><div class="cn-cap">connections</div><div class="cn-g">${CARDS.map(([n, i, kd]) => `<div class="cn-c" data-n="${n}"><div class="top">${i}<span class="nm">${n}</span><i class="d"></i></div><div class="kd">${kd}</div><div class="ev"><span class="idle">connected</span><span class="tk"></span><span class="w"></span><span class="ok"></span></div></div>`).join("")}</div></div>
    </div>`));
    const feed = q(stage, ".cn-feed");
    const L = [0, 1, 2, 3].map(() => {
      const el = h(`<div class="cn-l"><span class="lg"></span><span class="op"></span><span class="st"></span></div>`);
      feed.append(el);
      return { el, lg: q(el, ".lg"), op: q(el, ".op"), st: q(el, ".st") };
    });
    const C = CARDS.map(([n]) => {
      const el = q(stage, `.cn-c[data-n="${n}"]`);
      return { n, el, idle: q(el, ".ev .idle"), tk: q(el, ".ev .tk"), w: q(el, ".ev .w"), ok: q(el, ".ev .ok") };
    });
    return (t, p) => {
      p.calls.forEach((x, i) => {
        const line = L[i];
        if (!line) return;
        const after = p.calls[i + 1];
        const start = x.refAt ?? x.at, next = after ? (after.refAt ?? after.at) : p.len;
        put(line.lg, LOGO[x.c]); put(line.op, x.op);
        put(line.st, t < x.at + 800 ? (t >= start ? `<i class="sp"></i>` : "") : `${icon("lucide:check", 12)}${x.code}`);
        cls(line.el, "on", t >= start); cls(line.el, "cur", t >= start && t < next);
      });
      for (const { n, el, idle, tk, w, ok } of C) {
        const x = p.calls.find(c => c.c === n);
        const refAt = x?.refAt;
        const busy = !!x && t >= x.at && t < x.at + 1300;
        const refreshing = !!x && refAt !== undefined && t >= refAt && t < x.at;
        const refreshed = refAt !== undefined && t >= refAt + 1000;
        cls(el, "on", busy); cls(el, "ref", refreshing && refAt !== undefined && t < refAt + 1000);
        put(tk, `${icon("lucide:key-round", 12)}+ token`);
        put(w, refAt !== undefined && t >= refAt + 500 ? `<i class="sp"></i>refreshing` : `${icon("lucide:clock", 12)}${fs(`expires in ${p.exp}`, `${p.exp} left`)}`);
        put(ok, `${icon("lucide:check", 12)}${fs("token refreshed", "fresh")}`);
        const show = busy ? "tk" : refreshing ? (refreshed ? "ok" : "w") : x?.refresh && t >= x.at + 1300 ? "ok" : "idle";
        cls(idle, "on", show === "idle"); cls(tk, "on", show === "tk"); cls(w, "on", show === "w"); cls(ok, "on", show === "ok");
      }
      const gi = p.calls.findIndex(c => c.refresh), g = p.calls[gi];
      const first = p.calls[0]?.at ?? 0, refAt = g?.refAt ?? p.len;
      return t < first ? 0 : t < refAt ? 1 : t < (p.calls[gi + 1]?.at ?? p.len) ? 2 : 3;
    };
  },
});
