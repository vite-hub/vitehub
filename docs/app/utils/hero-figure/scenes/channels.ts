// Channels: a hub. Each logo is one Channel file in server/channels. A signed event comes in from Stripe or GitHub:
// ViteHub checks the signature and stores the delivery by its ID, and the handler runs once. The handler sends a
// message out through another Channel. The same delivery comes again and is dropped. In some loops a request with a
// bad signature is rejected.
import { defineScene, ease, snap, rng, pick, fs, val, TL, icon, h, q, cls, put, type Point, type Timed, type TimelinePlan } from "../engine";

type Source = "stripe" | "github";
type Chat = "slack" | "telegram";
type NodeId = Source | Chat | "gmail" | "discord";
const N: Record<NodeId, { x: number; y: number; file: string }> = {
  stripe: { x: 6, y: 32, file: "stripe.ts" }, github: { x: 6, y: 98, file: "github.ts" }, gmail: { x: 6, y: 164, file: "gmail.ts" },
  slack: { x: 94, y: 32, file: "slack.ts" }, discord: { x: 94, y: 98, file: "discord.ts" }, telegram: { x: 94, y: 164, file: "telegram.ts" },
};
const NODES: NodeId[] = ["stripe", "github", "gmail", "slack", "discord", "telegram"];
const CHATS: Chat[] = ["slack", "telegram"];
const HUB: Point = [50, 98];
/** The four points of the S curve from a to b, the same curve as the engine's `sc`. */
const curve = (a: Point, b: Point): [Point, Point, Point, Point] => {
  const d = (b[0] - a[0]) * 0.45;
  return [a, [a[0] + d, a[1]], [b[0] - d, b[1]], b];
};
const bez = ([c0, c1, c2, c3]: [Point, Point, Point, Point], u: number): Point => {
  const v = 1 - u;
  const at = (k: 0 | 1) => v * v * v * c0[k] + 3 * v * v * u * c1[k] + 3 * v * u * u * c2[k] + u * u * u * c3[k];
  return [at(0), at(1)];
};
const at = (n: NodeId, u: number) => bez(curve([N[n].x, N[n].y], HUB), u);
const out = (n: NodeId, u: number) => bez(curve(HUB, [N[n].x, N[n].y]), u);

interface Event {
  id: string;
  name: string;
  short: string;
  msg: [string, string];
}
interface Times {
  in: number;
  arr: number;
  ok: number;
  close: number;
  out: number;
  outArr: number;
  bub: number;
  dup: number;
  dupArr: number;
  dupDrop: number;
  dupEnd: number;
  fg: number;
  fgArr: number;
  fgErr: number;
  fgEnd: number;
}
type ChannelsPlan = TimelinePlan<{ src: Source; dst: Chat; ev: Event; forged: boolean; tm: Times; other: Source; srcName: string; step: Timed<number>[] }>;
/** How the status pill under the hub looks. */
interface Pill {
  text: string;
  tail: string;
  tone?: string;
}

const css = `.vh-hero-channels svg.icon{position:static;inset:auto;width:20px;height:20px}
.vh-hero-channels svg.icon path{fill:inherit;stroke:inherit;stroke-dasharray:none;vector-effect:none}.vh-hero-channels svg.icon path[stroke]{fill:none;stroke:currentColor}
.vh-hero-channels .tail.spin{display:inline-block}
.vh-hero-channels .ch{position:absolute;inset:0}
.vh-hero-channels .ch>svg.ch-wires{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.vh-hero-channels .ch-wires path{fill:none;stroke:var(--line);stroke-width:1;stroke-dasharray:4 5;vector-effect:non-scaling-stroke;transition:stroke 300ms ease,opacity 300ms ease}.vh-hero-channels .ch-wires path.on{stroke:var(--fg);stroke-dasharray:none;opacity:.6}
.vh-hero-channels .ch-wires path.ok{stroke:var(--ok);stroke-dasharray:none;opacity:.8}
.vh-hero-channels .ch-wires path.err{stroke:var(--err)}
.vh-hero-channels .ch-node{position:absolute;left:calc(var(--x)*1cqi);top:calc(var(--y)*1px);width:40px;height:40px;margin:-20px 0 0 -20px;display:grid;place-items:center;border-radius:99px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);color:var(--muted);transition:box-shadow 300ms ease,color 300ms ease}
.vh-hero-channels .ch-node.on{box-shadow:inset 0 0 0 1px var(--fg);color:var(--fg)}
.vh-hero-channels .ch-node.ok{box-shadow:inset 0 0 0 1px var(--ok);color:var(--fg)}
.vh-hero-channels .ch-node.err{box-shadow:inset 0 0 0 1px var(--err);color:var(--fg)}
.vh-hero-channels .ch-nl{position:absolute;left:calc(var(--x)*1cqi);top:calc(var(--y)*1px + 30px);transform:translate(-50%,-50%);font:11px var(--mono);color:var(--dim);white-space:nowrap}
.vh-hero-channels .ch-hub{position:absolute;left:50%;top:98px;width:220px;height:66px;margin:-33px 0 0 -110px;border-radius:12px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);display:flex;flex-direction:column;justify-content:center;align-items:center;gap:5px;z-index:2;transition:box-shadow 300ms ease}
.vh-hero-channels .ch-hub.on{box-shadow:inset 0 0 0 1px var(--fg)}
.vh-hero-channels .ch-hf{font:11px var(--mono);color:var(--dim)}
.vh-hero-channels .ch-he{font:12.5px var(--mono);color:var(--fg);white-space:nowrap}
.vh-hero-channels .ch-he>span,.vh-hero-channels .ch-hf>span{display:inline-block;animation:vh-fig-c 250ms var(--out)}
.vh-hero-channels .ch-ball{position:absolute;left:0;top:0;width:10px;height:10px;border-radius:99px;background:var(--fg);transform:translate(calc(var(--x)*1cqi - 50%),calc(var(--y)*1px - 50%));opacity:var(--a,0);z-index:1}
.vh-hero-channels .ch-ball.err{background:var(--err)}
.vh-hero-channels .ch .pj{position:absolute;left:50%;top:150px;transform:translate(-50%,-50%);z-index:3}
.vh-hero-channels .ch-bub{position:absolute;right:calc(100cqi - var(--x)*1cqi + 26px);top:calc(var(--y)*1px + var(--oy)*1px);padding:6px 10px;border-radius:10px 10px 2px 10px;box-shadow:inset 0 0 0 1px var(--line);background:var(--bg);font:12.5px var(--font-sans);color:var(--fg);white-space:nowrap;opacity:0;transform:translateY(6px) scale(.96);transform-origin:100% var(--to);transition:opacity 300ms var(--out),transform 400ms var(--out)}
.vh-hero-channels .ch-nl{transition:opacity 300ms ease}.vh-hero-channels .ch-nl.hide{opacity:0}
.vh-hero-channels .ch-sum{position:absolute;left:50%;top:150px;transform:translate(-50%,-50%);font:11.5px var(--mono);color:var(--muted);white-space:nowrap;opacity:0;transition:opacity 300ms ease}.vh-hero-channels .ch-sum.on{opacity:1}.vh-hero-channels .ch-sum .ok{color:var(--ok)}
.vh-hero-channels .ch-bub[data-n="telegram"]{border-radius:10px 2px 10px 10px}
.vh-hero-channels .ch-bub.on{opacity:1;transform:none}
.vh-hero-channels .ch-bub i{font-style:normal;color:var(--muted)}
.vh-hero-channels.fading .ch-bub,.vh-hero-channels.fading .ch-ball{opacity:0!important;transition:opacity 400ms}
@container (max-width:640px){
  .vh-hero-channels .ch-hub{width:236px;margin-left:-118px}
  .vh-hero-channels .ch-he{font-size:11.5px}
  .vh-hero-channels .ch-nl.n-stripe,.vh-hero-channels .ch-nl.n-github,.vh-hero-channels .ch-nl.n-gmail{transform:translate(-20px,-50%)}
  .vh-hero-channels .ch-nl.n-slack,.vh-hero-channels .ch-nl.n-discord,.vh-hero-channels .ch-nl.n-telegram{transform:translate(calc(20px - 100%),-50%)}
}
@container (max-width:560px){
  .vh-hero-channels .ch-node{width:34px;height:34px;margin:-17px 0 0 -17px}
  .vh-hero-channels svg.icon{width:17px;height:17px}
  .vh-hero-channels .ch-nl{display:none}
  .vh-hero-channels .ch-hub{width:128px;margin-left:-64px;height:58px;margin-top:-29px}
  .vh-hero-channels .ch-he{font-size:11px}
  .vh-hero-channels .ch-bub{font-size:11.5px;padding:5px 8px}
}`;


export default defineScene<ChannelsPlan>({
  css,
  key: "channels",
  name: "Channels",
  label: "Logos of Stripe, GitHub, Gmail, Slack, Telegram, and Discord sit around a hub. Each one is a Channel file in server/channels. A signed event comes in. ViteHub checks the signature, stores the delivery by its ID, and runs the handler once. The handler sends a message to a chat through another Channel with useChannel. The same delivery comes again, and ViteHub drops it. A request with a bad signature is rejected.",
  H: 200,
  steps: p => [
    `${p.srcName} posts a signed event to the ${p.src} Channel.`,
    "ViteHub checks the signature and stores the delivery by its ID. The handler runs once.",
    `The handler sends a message with useChannel('${p.dst}').send().`,
    p.forged ? "A repeat of the same delivery is dropped. A request with a bad signature is rejected." : "The same delivery comes again. ViteHub already has its ID, so it drops it.",
  ],
  summary: "Each logo is a Channel file. Signed events come in, a repeat is dropped, the handler runs once, and messages go out through useChannel().",
  plan(k) {
    const r = rng(k + 307);
    const src: Source = k % 2 ? "github" : "stripe";
    const dst = pick(r, CHATS);
    const ev: Event = src === "stripe"
      ? { id: pick(r, ["evt_1Q8", "evt_3Kq", "evt_7Zm", "evt_2Hx"]), name: "checkout.session.completed", short: "checkout", msg: pick<[string, string]>(r, [["New order", "$42.00"], ["New order", "$18.50"], ["Order paid", "$120.00"]]) }
      : { id: pick(r, ["dl_51a", "dl_9c2", "dl_7e0"]), name: "pull_request.opened", short: "pull_request", msg: pick<[string, string]>(r, [["PR #128 opened", "fix login"], ["PR #131 opened", "add search"], ["PR #96 opened", "docs"]]) };
    const forged = r() < 0.5;
    const arr = 1500;
    const ok = arr + snap(800 + r() * 300), close = ok + 700;
    const out = close + 200, outArr = out + 900, bub = outArr;
    const dup = bub + 1500, dupArr = dup + 900, dupDrop = dupArr + 700, dupEnd = dupDrop + 900;
    const fg = dupEnd + 300, fgArr = fg + 900, fgErr = fgArr + 600, fgEnd = fgErr + 1000;
    const T: Times = { in: 600, arr, ok, close, out, outArr, bub, dup, dupArr, dupDrop, dupEnd, fg, fgArr, fgErr, fgEnd };
    const last = forged ? T.fgEnd : T.dupEnd;
    return TL().done(last + 2300, last + 400, {
      src, dst, ev, forged, tm: T, other: src === "stripe" ? "github" : "stripe",
      srcName: src === "stripe" ? "Stripe" : "GitHub",
      step: [[0, 0], [T.arr, 1], [T.close, 2], [T.dup, 3]],
    });
  },
  render(stage) {
    const wire = (a: Point, b: Point) => {
      const [c0, c1, c2, c3] = curve(a, b);
      return `M${c0[0]} ${c0[1]} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${c3[0]} ${c3[1]}`;
    };
    const logos: Record<NodeId, string> = {
      stripe: icon("simple-icons:stripe", 20), github: icon("simple-icons:github", 20), gmail: icon("simple-icons:gmail", 20),
      slack: icon("simple-icons:slack", 20), telegram: icon("simple-icons:telegram", 20), discord: icon("simple-icons:discord", 20),
    };
    stage.append(h(`<div class="ch">
      <svg class="ch-wires" viewBox="0 0 100 200" preserveAspectRatio="none" aria-hidden="true">${NODES.map(n => `<path data-n="${n}" d="${N[n].x < 50 ? wire([N[n].x, N[n].y], HUB) : wire(HUB, [N[n].x, N[n].y])}"/>`).join("")}</svg>
      ${NODES.map(n => `<span class="ch-node" data-n="${n}" style="--x:${N[n].x};--y:${N[n].y}">${logos[n]}</span><span class="ch-nl n-${n}" style="--x:${N[n].x};--y:${N[n].y}">${N[n].file}</span>`).join("")}
      <div class="ch-hub"><span class="ch-hf"></span><span class="ch-he"></span></div>
      <span class="ch-ball"></span><span class="ch-sum"></span>
      <span class="job pj"><span class="body"><span class="lab"></span><span class="tail"></span></span></span>
      ${CHATS.map(n => `<span class="ch-bub" data-n="${n}" style="--x:${N[n].x};--y:${N[n].y};--oy:${n === "slack" ? -30 : 6};--to:${n === "slack" ? "100%" : "0%"}"></span>`).join("")}
    </div>`));
    const parts = NODES.map(n => ({ n, wire: q<SVGPathElement>(stage, `.ch-wires path[data-n="${n}"]`), node: q(stage, `.ch-node[data-n="${n}"]`) }));
    const bubs = CHATS.map(n => ({ n, el: q(stage, `.ch-bub[data-n="${n}"]`) }));
    const hub = q(stage, ".ch-hub"), hf = q(stage, ".ch-hf"), he = q(stage, ".ch-he");
    const ball = q(stage, ".ch-ball"), pill = q(stage, ".pj"), lab = q(pill, ".lab"), tail = q(pill, ".tail");
    const sum = q(stage, ".ch-sum"), tgLabel = q(stage, ".ch-nl.n-telegram");
    return (t, p) => {
      const T = p.tm, src = p.src, dst = p.dst;
      // The one ball: in from the source, out to the chat, the repeat, then the forged request.
      let pos: Point | null = null, a = 0, bad = false;
      if (t >= T.in && t < T.arr) { pos = at(src, ease((t - T.in) / (T.arr - T.in))); a = 1; }
      else if (t >= T.out && t < T.outArr) { pos = out(dst, ease((t - T.out) / (T.outArr - T.out))); a = 1; }
      else if (t >= T.dup && t < T.dupArr) { pos = at(src, ease((t - T.dup) / (T.dupArr - T.dup))); a = 1; }
      else if (p.forged && t >= T.fg && t < T.fgArr) { pos = at(p.other, ease((t - T.fg) / (T.fgArr - T.fg))); a = 1; bad = true; }
      if (pos) { ball.style.setProperty("--x", pos[0].toFixed(2)); ball.style.setProperty("--y", pos[1].toFixed(1)); }
      ball.style.setProperty("--a", String(a));
      cls(ball, "err", bad && t >= T.fg + 500);
      // Wires and nodes.
      for (const { n, wire, node } of parts) {
        let w = "", s = "";
        if (n === src && ((t >= T.in && t < T.close) || (t >= T.dup && t < T.dupEnd))) { w = "on"; s = "on"; }
        if (n === src && t >= T.ok && t < T.close) { w = "ok"; s = "ok"; }
        if (n === dst && t >= T.out && t < T.bub + 1400) { w = t >= T.outArr ? "ok" : "on"; s = t >= T.outArr ? "ok" : "on"; }
        if (p.forged && n === p.other && t >= T.fg && t < T.fgEnd) { w = t >= T.fgErr ? "err" : "on"; s = t >= T.fgErr ? "err" : "on"; }
        if (wire.getAttribute("class") !== w) wire.setAttribute("class", w);
        if (node.className !== `ch-node ${s}`) node.className = `ch-node ${s}`;
      }
      // The hub shows the Channel file and what it does now.
      let file = N[src].file, line = fs(p.ev.name, p.ev.short);
      if (t >= T.ok && t < T.close) line = fs("stored · handler runs once", "stored");
      if (t >= T.close && t < T.dup) line = fs(`useChannel('${dst}').send()`, `→ ${dst}`);
      if (t >= T.dupDrop && t < T.dupEnd + 300) line = fs("ID already stored · dropped", "dropped");
      if (p.forged && t >= T.fg) { file = N[p.other].file; line = fs(p.other === "stripe" ? "stripe-signature" : "x-hub-signature-256", "signature"); }
      if (p.forged && t >= T.fgErr) line = fs("bad signature · rejected", "rejected");
      put(hf, `<span>${fs("server/channels/", "")}${file}</span>`);
      put(he, `<span>${line}</span>`);
      cls(hub, "on", (t >= T.arr && t < T.outArr) || (t >= T.dupArr && t < T.dupEnd) || (p.forged && t >= T.fgArr && t < T.fgEnd));
      // The status pill under the hub.
      const W: [number, number, Pill][] = [
        [T.arr, T.close, t < T.ok ? { text: fs(`${p.ev.id} · signature`, p.ev.id), tail: "spin" } : { text: fs(`${p.ev.id} · signature`, p.ev.id), tail: "ok", tone: "ok" }],
        [T.dupArr, T.dupEnd, t < T.dupDrop ? { text: fs(`${p.ev.id} · signature`, p.ev.id), tail: "spin" } : { text: fs(`${p.ev.id} · duplicate`, p.ev.id), tail: "err", tone: "dim" }],
      ];
      if (p.forged) W.push([T.fgArr, T.fgEnd, t < T.fgErr ? { text: "signature", tail: "spin" } : { text: "signature", tail: "err", tone: "err" }]);
      const win = W.find(([a, b]) => t >= a && t < b + 500);
      const s = win?.[2], open = !!win && t >= win[0] && t < win[1];
      const c = `job pj ${s?.tone ?? ""}${open ? " open" : ""}`;
      if (pill.className !== c) pill.className = c;
      pill.style.opacity = win && t < win[1] + 350 ? "1" : "0";
      if (s) put(lab, s.text);
      const w = s?.tail ?? "";
      if (tail.dataset.v !== w) {
        tail.dataset.v = w;
        tail.className = w === "spin" ? "tail spin" : "tail";
        tail.textContent = w === "ok" ? "✓" : w === "err" ? "✕" : "";
      }
      // The message in the chat.
      for (const { n, el } of bubs) {
        cls(el, "on", n === dst && t >= T.bub);
        if (n === dst) put(el, `${p.ev.msg[0]} <i>${fs("· " + p.ev.msg[1], "")}</i>`);
      }
      const last = p.forged ? T.fgEnd : T.dupEnd;
      put(sum, `<span class="ok">ran once</span> · ${fs("1 repeat dropped", "1 dropped")}${p.forged ? ` · ${fs("1 rejected", "1 bad")}` : ""}`);
      cls(sum, "on", t >= last + 400);
      tgLabel.classList.toggle("hide", p.dst === "telegram" && t >= T.bub);
      return val(t, p.step, 0) ?? 0;
    };
  },
});
