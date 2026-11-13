// Rate Limit: each client IP has its own meter of 5 per 10 seconds. A request slides into the next free cell, merges
// into it, and goes through. When the meter is full, an extra request stops in front of it as a red 429 and the meter
// shakes. The other IP still has room. When the window ends, every meter empties.
import { defineScene, ease, clamp, lerp, snap, rng, pick, TL, icon, h, q, qa, cls, put, type TimelinePlan } from "../engine";

/** One request: its client row, its arrival time, its window, whether it goes through, and its meter cell. */
interface Req {
  c: number;
  a: number;
  w: number;
  ok: boolean;
  slot: number;
}
interface RateExtra {
  names: [string, string];
  busy: number;
  reqs: Req[];
  W0: number;
  W1: number;
  rej1: number;
  ob: number;
}
interface Look {
  a?: number;
  tone?: string;
  open?: boolean;
  text?: string;
}

const css = `.vh-hero-rate-limit svg.icon{position:static;width:auto;height:auto}
.vh-hero-rate-limit .icon path{stroke-dasharray:none;vector-effect:none;transition:none;fill:inherit;stroke:inherit;stroke-width:inherit}
.vh-hero-rate-limit .icon path[fill="none"]{fill:none;stroke:currentColor;stroke-width:2}
.vh-hero-rate-limit .rl{position:absolute;inset:0}
.vh-hero-rate-limit .rl-top{position:absolute;left:0;right:0;top:0;display:flex;align-items:center;gap:16px;height:34px;font:12px var(--mono);white-space:nowrap}
.vh-hero-rate-limit .rl-code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}
.vh-hero-rate-limit .rl-code b{font-weight:400;color:var(--fg)}
.vh-hero-rate-limit .rl-win{display:flex;align-items:center;gap:10px;color:var(--muted);font-variant-numeric:tabular-nums}
.vh-hero-rate-limit .rl-bar{position:relative;width:90px;height:4px;border-radius:9px;background:var(--line);overflow:hidden}
.vh-hero-rate-limit .rl-bar i{position:absolute;inset:0;border-radius:9px;background:var(--fg);transform-origin:left;transform:scaleX(var(--u,1))}
.vh-hero-rate-limit .rl-win.reset{color:var(--ok)}.vh-hero-rate-limit .rl-win.reset .rl-bar i{background:var(--ok)}
.vh-hero-rate-limit .rl-lane{position:absolute;left:0;right:0;height:0;border-top:1px dashed var(--line)}
.vh-hero-rate-limit .rl-who{position:absolute;left:0;display:flex;align-items:center;gap:6px;font:12px var(--mono);color:var(--fg);transform:translateY(-50%)}
.vh-hero-rate-limit .rl-who .icon{color:var(--muted)}
.vh-hero-rate-limit .rl-m{position:absolute;display:flex;gap:4px;padding:5px;border-radius:9px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);transform:translate(calc(-50% + var(--sh,0px)),-50%);transition:box-shadow 300ms ease}
.vh-hero-rate-limit .job{z-index:2}
.vh-hero-rate-limit .rl-m.max{box-shadow:inset 0 0 0 1px var(--err)}
.vh-hero-rate-limit .rl-m i{position:relative;width:16px;height:16px;border-radius:4px;background:var(--soft);box-shadow:inset 0 0 0 1px var(--line)}
.vh-hero-rate-limit .rl-m i b{position:absolute;inset:0;border-radius:4px;background:var(--fg);opacity:0;transition:background-color 250ms ease}
.vh-hero-rate-limit .rl-m.max i b{background:var(--err)}
.vh-hero-rate-limit .rl-m,.vh-hero-rate-limit .rl-m i b{will-change:transform}
.vh-hero-rate-limit .rl-n{position:absolute;font:12px var(--mono);color:var(--muted);transform:translate(-50%,-50%);font-variant-numeric:tabular-nums;transition:color 300ms ease;white-space:nowrap}
.vh-hero-rate-limit .rl-n.max{color:var(--err)}
.vh-hero-rate-limit .rl-res{position:absolute;right:0;font:11px var(--mono);color:var(--dim);transform:translateY(-50%)}
@container (max-width:720px){.vh-hero-rate-limit .rl-top{gap:12px}.vh-hero-rate-limit .rl-bar{width:72px}}
.vh-hero-rate-limit.fading .rl-m i b,.vh-hero-rate-limit.fading .rl-n{opacity:.0;transition:opacity 400ms}
@container (max-width:560px){
  .vh-hero-rate-limit .rl-top{font-size:10.5px;gap:8px}
  .vh-hero-rate-limit .rl-bar{width:44px}
  .vh-hero-rate-limit .rl-m i{width:13px;height:13px}
  .vh-hero-rate-limit .rl-who,.vh-hero-rate-limit .rl-n{font-size:11px}
  .vh-hero-rate-limit .rl-res{display:none}
}`;

export default defineScene<TimelinePlan<RateExtra>>({
  css,
  key: "rate-limit",
  name: "Rate Limit",
  label: "Two client IPs send requests to a route with a limit of 5 requests in each 10 second window. Each request of the first IP slides into the next free cell of its meter and goes through. When the meter is full, the extra request gets a 429 error and the meter shakes. The second IP has its own meter and still gets through. When the window ends, every meter is empty again.",
  H: 220,
  steps: [
    "The route allows 5 requests for each client IP in each 10 second window.",
    "Each request fills one cell of its IP's meter and goes through.",
    "The meter is full. The extra request gets a 429 error.",
    "The other IP has its own meter, so its request goes through.",
    "The window ends. Every meter is empty again.",
  ],
  summary: "Each client IP has its own meter of 5 requests in each 10 second window. Requests under the limit go through, extra requests get 429, and the meters empty when the window ends.",
  plan(k) {
    const r = rng(k + 811);
    const names = pick<[string, string]>(r, [["203.0.113.7", "198.51.100.4"], ["192.0.2.15", "203.0.113.42"], ["198.51.100.23", "192.0.2.8"]]);
    const busy = r() < .5 ? 0 : 1;
    const W0 = 600, W1 = W0 + 10000;
    const reqs: Req[] = [];
    const req = (c: number, a: number): Req => ({ c, a, w: 0, ok: false, slot: 0 });
    let t = 1400;
    for (let i = 0; i < 5; i++) { reqs.push(req(busy, t)); t += snap(600 + r() * 350) }
    const rej1 = t + 200; reqs.push(req(busy, rej1));
    const other = 1 - busy;
    reqs.push(req(other, 1400 + snap(1000 + r() * 1400)));
    const ob = rej1 + 1500; reqs.push(req(other, ob));
    reqs.push(req(busy, ob + snap(1300 + r() * 500)));
    reqs.push(req(busy, W1 + 1000));
    reqs.sort((x, y) => x.a - y.a);
    const used = [0, 0];
    for (const rq of reqs) {
      if (rq.a >= W1 && !rq.w) { used[0] = used[1] = 0 }
      rq.w = rq.a >= W1 ? 1 : 0;
      const n = used[rq.c] ?? 0;
      rq.ok = n < 5; rq.slot = n;
      if (rq.ok) used[rq.c] = n + 1;
    }
    return TL().done(W1 + 1000 + 2900, rej1 + 700, { names, busy, reqs, W0, W1, rej1, ob });
  },
  render(stage) {
    stage.append(h(`<div class="rl">
      <div class="rl-top"><span class="rl-code"></span><span class="rl-win"><span class="rl-t"></span><span class="rl-bar"><i></i></span></span></div>
    </div>`));
    const root = q(stage, ".rl"), code = q(stage, ".rl-code"), win = q(stage, ".rl-win"), wt = q(stage, ".rl-t"), bar = q(stage, ".rl-bar i");
    const ROWS = [92, 170] as const;
    const rows = ROWS.map(y => {
      const lane = h(`<div class="rl-lane" style="top:${y}px"></div>`), who = h(`<div class="rl-who" style="top:${y - 22}px"></div>`);
      const m = h(`<div class="rl-m" style="top:${y}px">${"<i><b></b></i>".repeat(5)}</div>`), n = h(`<div class="rl-n" style="top:${y - 26}px"></div>`), res = h(`<div class="rl-res" style="top:${y - 14}px">200 OK</div>`);
      root.append(lane, who, m, n, res);
      return { lane, who, m, n, res, y, fills: qa(m, "b") };
    });
    const job = () => { const el = h(`<span class="job"><span class="body"><span class="lab"></span><span class="tail"></span></span></span>`); root.append(el); return el };
    const J = Array.from({ length: 12 }, job), X = Array.from({ length: 12 }, job);
    const look = (el: HTMLElement, x: number, y: number, W: number, o: Look) => {
      el.style.setProperty("--x", (x / W * 100).toFixed(3));
      el.style.setProperty("--y", (y - stage.clientHeight / 2).toFixed(1));
      el.style.setProperty("--dx", "0");
      el.style.setProperty("--a", (o.a ?? 1).toFixed(3));
      const c = `job ${o.tone ?? ""}${o.open ? " open" : ""}`;
      if (el.className !== c) el.className = c;
      const lab = q(el, ".lab");
      if (lab.dataset.v !== (o.text ?? "")) { lab.dataset.v = o.text ?? ""; lab.textContent = o.text ?? "" }
    };
    // How far a request has merged into its cell: 0 before, 1 after.
    const merge = (rq: Req, t: number) => clamp((t - rq.a + 140) / 340);
    return (t, p) => {
      const W = stage.clientWidth, narrow = W < 560, mid = W < 720;
      const cs = narrow ? 13 : 16, mw = cs * 5 + 16 + 10;
      const mx = W * (narrow ? .56 : .5), x0 = 10, x1 = W - (narrow ? 10 : 60);
      const cellX = (i: number) => mx - mw / 2 + 5 + i * (cs + 4) + cs / 2, outX = mx + mw / 2 + 10, stopX = mx - mw / 2 - 34;
      // The docs column is about 600px wide: a shorter name and timer keep the whole call on one line.
      put(code, narrow
        ? `<b>limit: 5</b>, window: <b>'10s'</b>`
        : `requireRateLimit(event, '${mid ? "send" : "send-message"}', { <b>limit: 5</b>, window: <b>'10s'</b> })`);
      // The window: a bar that empties over 10 seconds, then starts again.
      const inWin = t < p.W1;
      const left = inWin ? Math.max(0, (p.W1 - t) / 10000) : 1 - Math.min(1, (t - p.W1) / 10000);
      bar.style.setProperty("--u", clamp(t < p.W0 ? 1 : left).toFixed(4));
      const secs = inWin ? Math.ceil((p.W1 - Math.max(t, p.W0)) / 1000) : 10 - Math.floor((t - p.W1) / 1000);
      put(wt, t >= p.W1 && t < p.W1 + 1500 ? "new window" : `${mid ? "" : "resets in "}${secs}s`);
      cls(win, "reset", t >= p.W1 && t < p.W1 + 1500);
      const wnow = t >= p.W1 ? 1 : 0, clear = clamp((t - p.W1) / 400);
      rows.forEach((row, c) => {
        row.lane.style.left = "0px"; row.lane.style.right = `${W - x1}px`;
        row.m.style.left = `${mx}px`; row.n.style.left = `${mx}px`;
        put(row.who, `${icon("lucide:globe", 13)}${p.names[c]}`);
        // Each cell fills as its request merges into it. At the window end, the old fills fade out.
        row.fills.forEach((b, i) => {
          let u = 0;
          for (const rq of p.reqs) if (rq.c === c && rq.ok && rq.slot === i) u = Math.max(u, rq.w ? merge(rq, t) : merge(rq, t) * (1 - clear));
          b.style.opacity = u.toFixed(3);
          b.style.transform = `scale(${lerp(.6, 1, ease(u)).toFixed(3)})`;
        });
        const used = p.reqs.filter(rq => rq.c === c && rq.ok && rq.w === wnow && t >= rq.a).length, full = used >= 5 && t < p.W1;
        cls(row.m, "max", full); cls(row.n, "max", full);
        put(row.n, `${used} / 5`);
        // A refused request shakes the meter: a fast, decaying side to side.
        let sh = 0;
        for (const rq of p.reqs) if (rq.c === c && !rq.ok && t >= rq.a && t < rq.a + 600) { const u = (t - rq.a) / 600; sh = 7 * Math.sin(u * Math.PI * 7) * (1 - u) * (1 - u) }
        row.m.style.setProperty("--sh", `${sh.toFixed(2)}px`);
      });
      p.reqs.forEach((rq, i) => {
        const el = J[i]!, ex = X[i]!, y = ROWS[rq.c ? 1 : 0], go = 1000;
        const target = rq.ok ? cellX(rq.slot) : stopX;
        // In: the ball eases along the lane to its cell, or to the stop in front of a full meter.
        if (t < rq.a - go) look(el, x0, y, W, { a: 0 });
        else if (t < rq.a) look(el, lerp(x0, target, ease((t - rq.a + go) / go)), y, W, { a: clamp((t - rq.a + go) / 200) });
        else if (rq.ok) look(el, target, y, W, { a: 1 - merge(rq, t) });
        else {
          const back = clamp((t - rq.a - 1000) / 450);
          look(el, target - ease(back) * 18, y, W, { open: t < rq.a + 1100, tone: "err", text: "429", a: 1 - back });
        }
        // Out: a green ball leaves the meter on the right, like a metro.
        if (!rq.ok || t < rq.a + 180) return look(ex, outX, y, W, { a: 0 });
        const u = (t - rq.a - 180) / 950;
        look(ex, lerp(outX, x1, ease(u)), y, W, { tone: "ok", a: clamp(u * 5) * (1 - clamp((u - .7) / .3)) });
      });
      for (let i = p.reqs.length; i < J.length; i++) { look(J[i]!, 0, 0, W, { a: 0 }); look(X[i]!, 0, 0, W, { a: 0 }) }
      return t < (p.reqs[0]?.a ?? 0) - 200 ? 0 : t < p.rej1 ? 1 : t < p.ob - 200 ? 2 : t < p.W1 ? 3 : 4;
    };
  },
});
