// Sandbox: your app on the left, a separate machine on the right. The route sends the input to the pixels task.
// The provider starts an isolated machine, installs the task's dependencies there, runs the entry point, and sends
// the result back as a Response. The network policy allows only the npm registry, so a fetch to another host is blocked.
// Then the session closes, its files go away, and the machine is gone.
import { defineScene, ease, lerp, snap, rng, pick, fs, val, TL, icon, h, q, cls, put, type Timed, type TimelinePlan } from "../engine";

const HOSTS = ["github.com", "example.com", "openai.com", "httpbin.org"];
const SIZES: [number, number][] = [[1920, 1080], [1280, 720], [3840, 2160], [800, 600], [2560, 1440]];

/** The times of one run. */
interface Times {
  call: number;
  send: number;
  start: number;
  run: number;
  inst: number;
  instOk: number;
  exec: number;
  fetch: number;
  block: number;
  execOk: number;
  out: number;
  ret: number;
  arr: number;
  close: number;
  gone: number;
}
interface SandboxExtra {
  w: number;
  hh: number;
  host: string;
  px: string;
  at: Times;
  ms: string;
  step: Timed<number>[];
}

const css = `.vh-hero-sandbox svg.icon{position:static;inset:auto;width:13px;height:13px}
.vh-hero-sandbox svg.icon path{fill:inherit;stroke:inherit;stroke-dasharray:none;vector-effect:none}.vh-hero-sandbox svg.icon path[stroke]{fill:none;stroke:currentColor}
.vh-hero-sandbox .tail.spin{display:inline-block}
.vh-hero-sandbox .sb{position:absolute;inset:0;display:grid;grid-template-columns:43% 42%;justify-content:space-between;align-items:center}
.vh-hero-sandbox .sb-lbl{display:flex;align-items:center;gap:6px;font:11px var(--mono);color:var(--dim);margin:0 0 8px 2px;white-space:nowrap}
.vh-hero-sandbox .sb-app{border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);padding:10px 0;font:11px/22px var(--mono);color:var(--muted);white-space:pre;overflow:hidden}
.vh-hero-sandbox .sb-l{padding:0 14px;transition:background-color 300ms ease,color 300ms ease}
.vh-hero-sandbox .sb-l.on{background:var(--soft);color:var(--fg)}
.vh-hero-sandbox .sb-res{padding:0 14px;color:var(--ok);opacity:0;transform:translateY(4px);transition:opacity 300ms var(--out),transform 300ms var(--out)}
.vh-hero-sandbox .sb-res.on{opacity:1;transform:none}
.vh-hero-sandbox .sb-m{transition:opacity 700ms ease,transform 600ms var(--out)}
.vh-hero-sandbox .sb-m.off{opacity:0;transform:scale(.97)}
.vh-hero-sandbox .sb-m.gone{opacity:.32}
.vh-hero-sandbox .sb-box{border-radius:10px;box-shadow:inset 0 0 0 1px var(--fg);padding:8px 0 10px;transition:box-shadow 400ms ease}
.vh-hero-sandbox .sb-m.gone .sb-box{box-shadow:inset 0 0 0 1px var(--line)}
.vh-hero-sandbox .sb-bar{display:flex;justify-content:space-between;align-items:center;padding:0 12px 8px;font:11px var(--mono);color:var(--muted);box-shadow:inset 0 -1px 0 var(--line)}
.vh-hero-sandbox .sb-st{display:inline-flex;align-items:center;gap:6px}
.vh-hero-sandbox .sb-st i{width:7px;height:7px;border-radius:99px;background:var(--dim);transition:background-color 300ms ease}
.vh-hero-sandbox .sb-st.run i{background:var(--ok)}
.vh-hero-sandbox .sb-term{padding:8px 12px 0;font:11.5px/22px var(--mono);color:var(--muted)}
.vh-hero-sandbox .sb-t{display:flex;justify-content:space-between;gap:10px;white-space:nowrap;opacity:0;transform:translateY(4px);transition:opacity 260ms var(--out),transform 260ms var(--out),color 300ms ease}
.vh-hero-sandbox .sb-t.on{opacity:1;transform:none}
.vh-hero-sandbox .sb-t.fg{color:var(--fg)}.vh-hero-sandbox .sb-t.ok{color:var(--ok)}
.vh-hero-sandbox .sb-t .r{color:var(--dim)}.vh-hero-sandbox .sb-t .r.ok{color:var(--ok)}.vh-hero-sandbox .sb-t .r.err{color:var(--err)}
.vh-hero-sandbox .sb-t.err{color:var(--err)}.vh-hero-sandbox .sb-t.in{padding-left:12px}
.vh-hero-sandbox .sb-t.shake{animation:sb-shake 380ms ease}
@keyframes sb-shake{20%{transform:translateX(-3px)}45%{transform:translateX(3px)}70%{transform:translateX(-2px)}100%{transform:none}}
.vh-hero-sandbox .sb-note{transition:color 300ms ease}.vh-hero-sandbox .sb-note.hit{color:var(--err)}
.vh-hero-sandbox .sb-t .sp{display:inline-block;width:10px;height:10px;margin-top:6px;border:1.5px solid var(--line);border-top-color:var(--fg);border-radius:99px;animation:vh-fig-s 700ms linear infinite}
.vh-hero-sandbox .sb-note{display:flex;align-items:center;gap:6px;margin:10px 0 0 2px;font:11px var(--mono);color:var(--dim)}
.vh-hero-sandbox .sb-wire{position:absolute;left:43%;right:42%;top:50%;height:0;border-top:1px dashed var(--line)}
.vh-hero-sandbox .sb-ball{position:absolute;left:0;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:99px;background:var(--fg);transform:translateX(calc(var(--x)*1cqi));opacity:var(--a,0);transition:background-color 300ms ease}
.vh-hero-sandbox .sb-ball.ok{background:var(--ok)}
.vh-hero-sandbox.fading .sb-res,.vh-hero-sandbox.fading .sb-m{opacity:0;transition:opacity 400ms}
@container (max-width:560px){
.vh-hero-sandbox .sb{grid-template-columns:47% 47%}
.vh-hero-sandbox .sb-wire{left:47%;right:47%}
.vh-hero-sandbox .sb-app,.vh-hero-sandbox .sb-term{font-size:10px;line-height:20px}
.vh-hero-sandbox .sb-l,.vh-hero-sandbox .sb-res{padding:0 9px}
.vh-hero-sandbox .sb-bar{padding:0 9px 7px;font-size:10px}
.vh-hero-sandbox .sb-term{padding:6px 9px 0}
.vh-hero-sandbox .sb-t.in{padding-left:6px}
.vh-hero-sandbox .sb-note{font-size:10px}
}`;

export default defineScene<TimelinePlan<SandboxExtra>>({
css,
  key: "sandbox",
  name: "Sandbox",
  label: "Your app and a separate cloud machine. A route calls runSandboxTask with the pixels task and an input. Vercel starts an isolated machine. The task's dependencies install there from the npm registry. The network policy allows only that registry, so when the task code fetches another host, the call is blocked. The entry point returns, and the result comes back to the route as a Response. Then the session closes, its files go away, and the machine is gone.",
  H: 236,
  steps: p => [
    "A route calls runSandboxTask('pixels') with the input. The task is a folder in server/sandbox-tasks.",
    "Vercel starts an isolated machine. The task's dependencies install there, not in your app.",
    `The network policy allows only the npm registry. The fetch to ${p.host} is blocked.`,
    "The entry point returns. Its result comes back to the route as a Response.",
    "The session closes and its files go away. Your app keeps only the result.",
  ],
  summary: "runSandboxTask() runs a task in an isolated cloud machine. Its network policy blocks hosts that it does not allow. The result comes back to your route, and the machine closes after the run.",
  plan(k) {
    const r = rng(k + 503);
    const [w, hh] = pick(r, SIZES), host = pick(r, HOSTS);
    const run = 2300, inst = run, instOk = inst + snap(900 + r() * 500);
    const exec = instOk + 300, fetch = exec + snap(400 + r() * 300), block = fetch + 600;
    const execOk = block + snap(1300 + r() * 600);
    const out = execOk + 200, ret = out + 300, arr = ret + 900;
    const close = arr + 300, gone = close + 900;
    const A: Times = { call: 500, send: 1100, start: 1500, run, inst, instOk, exec, fetch, block, execOk, out, ret, arr, close, gone };
    const step: Timed<number>[] = [[0, 0], [A.start, 1], [A.fetch, 2], [A.execOk, 3], [A.close, 4]];
    return TL().done(A.gone + 2500, A.gone + 700, { w, hh, host, px: (w * hh).toLocaleString("en-US"), at: A, ms: ((A.execOk - A.exec) / 1000).toFixed(1), step });
  },
  render(stage) {
    stage.append(h(`<div class="sb">
      <div><div class="sb-lbl">${icon("lucide:app-window", 13)}your app · ${fs("server/api/pixels.post.ts", "route")}</div>
        <div class="sb-app"><div class="sb-l l1"></div><div class="sb-l l2"></div><div class="sb-l l3"></div><div class="sb-res"></div></div></div>
      <div class="sb-m"><div class="sb-lbl sb-prov"></div>
        <div class="sb-box"><div class="sb-bar"><span>${fs("sandbox-tasks/pixels", "pixels")}</span><span class="sb-st"><i></i><b></b></span></div>
          <div class="sb-term"><div class="sb-t t1"></div><div class="sb-t t2"></div><div class="sb-t t3"></div><div class="sb-t t4"></div><div class="sb-t t5"></div></div></div>
        <div class="sb-note">${icon("lucide:shield", 12)}${fs("networkPolicy: allow registry.npmjs.org", "allow: npm registry")}</div></div>
      <span class="sb-wire"></span><span class="sb-ball"></span></div>`));
    const $ = (s: string) => q(stage, s);
    const l1 = $(".l1"), l2 = $(".l2"), l3 = $(".l3"), res = $(".sb-res"), m = $(".sb-m"), prov = $(".sb-prov");
    const st = $(".sb-st"), stt = $(".sb-st b"), note = $(".sb-note"), ball = $(".sb-ball");
    const [t1, t2, t3, t4, t5] = [$(".t1"), $(".t2"), $(".t3"), $(".t4"), $(".t5")];
    const sp = `<span class="sp"></span>`;
    return (t, p, still) => {
      const A = p.at;
      put(l1, fs("const res = await runSandboxTask(", "await runSandboxTask("));
      put(l2, fs(`  'pixels', { w: ${p.w}, h: ${p.hh} })`, `  'pixels', input)`));
      put(l3, fs("return res.json()", "res.json()"));
      cls(l1, "on", t >= A.call && t < A.ret); cls(l2, "on", t >= A.call && t < A.ret); cls(l3, "on", t >= A.arr);
      put(res, fs(`→ 200 { pixels: ${p.px} }`, `→ 200 ✓`));
      cls(res, "on", t >= A.arr);
      put(prov, `${icon("simple-icons:vercel", 12)}Vercel Sandbox`);
      cls(m, "off", t < A.start); cls(m, "gone", t >= A.gone && !still);
      const state = t < A.run ? "starting" : t < A.close ? "running" : "closed";
      put(stt, state); cls(st, "run", state === "running");
      const row = (el: HTMLElement, on: boolean, html: string, tone: string) => { put(el, html); const c = `sb-t${on ? " on" : ""} ${tone}`; if (el.className !== c) el.className = c };
      row(t1, t >= A.inst, `<span>${fs("install dependencies", "install")}</span>${t < A.instOk ? sp : `<span class="r ok">✓</span>`}`, t < A.instOk ? "fg" : "");
      row(t2, t >= A.exec, `<span>${fs("run index.ts → count()", "run index.ts")}</span>${t < A.execOk ? sp : `<span class="r ok">${p.ms}s</span>`}`, t >= A.exec && t < A.execOk ? "fg" : "");
      row(t3, t >= A.fetch, `<span>${fs(`fetch('https://${p.host}')`, `fetch(${p.host})`)}</span>${t < A.block ? sp : `<span class="r err">✗</span>`}`, `in${t >= A.block ? " err" : " fg"}${t >= A.block && t < A.block + 400 ? " shake" : ""}`);
      cls(note, "hit", t >= A.block && t < A.block + 1400);
      row(t4, t >= A.out, `<span>${fs(`{ pixels: ${p.px} }`, `{ pixels }`)}</span><span class="r">${fs("→ app", "→")}</span>`, "ok");
      row(t5, t >= A.close, `<span>${fs("files removed · session closed", "closed")}</span><span class="r">✓</span>`, "");
      // The ball: the input goes over, the result comes back.
      const W = stage.clientWidth || 800, narrow = W < 560, x0 = narrow ? 47 : 43, x1 = narrow ? 53 : 58;
      let x: number | null = null, ok = false;
      if (t >= A.send && t < A.start + 500) x = lerp(x0, x1, ease((t - A.send) / (A.start + 500 - A.send)));
      if (t >= A.ret && t < A.arr) { x = lerp(x1, x0, ease((t - A.ret) / (A.arr - A.ret))); ok = true }
      ball.style.setProperty("--a", x === null ? "0" : "1");
      if (x !== null) ball.style.setProperty("--x", x.toFixed(2));
      cls(ball, "ok", ok);
      return val(t, p.step, 0) ?? 0;
    };
  },
});
