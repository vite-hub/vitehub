// Schedule: a 24 hour watch. The hour hand never stops: it sweeps one full day in each loop, and the next loop goes on
// from the same place. The cron '0 0 * * *' has one mark, at 00:00. When the hand reaches it, the host starts a run of
// server/schedules/daily-report.ts: a pill grows in the run list with a spinner, then a check. Some days the run
// throws: ViteHub logs it and does not retry, and the next day runs it again. The host changes each loop.
import { defineScene, rng, fs, val, TL, icon, h, q, cls, put, type Timed, type TimelinePlan } from "../engine";

// One loop is one day. The hand starts at 14:00 and reaches 00:00 at 10/24 of the loop.
const LEN = 15600, H0 = 14, RUN = Math.round((24 - H0) / 24 * LEN);
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const day = (k: number) => DAYS[((k % 7) + 7) % 7];
// The result of the run at the start of day d. It is fixed per day, so the run list agrees from loop to loop.
/** One run: whether it throws, its time in the list, and how long the pill spins. */
interface Run {
  err: boolean;
  ms: number;
  dur: number;
}
interface Host {
  id: string;
  name: string;
  hostName: string;
}
interface ScheduleExtra {
  k: number;
  host: Host;
  run: Run;
  A: { run: number; done: number; close: number };
  step: Timed<number>[];
  rows: (Run & { d: number })[];
}
const runOf = (d: number): Run => { const r = rng(d * 31 + 907); return { err: r() < .25, ms: 90 + Math.floor(r() * 260), dur: 450 + Math.floor(r() * 4) * 50 } };
const hm = (hr: number) => `${String(Math.floor(hr) % 24).padStart(2, "0")}:${String(Math.floor((hr % 1) * 60)).padStart(2, "0")}`;
const css = `.vh-hero-schedule svg.icon{position:static;inset:auto;width:13px;height:13px}
.vh-hero-schedule svg.icon path{fill:inherit;stroke:inherit;stroke-dasharray:none;vector-effect:none}.vh-hero-schedule svg.icon path[stroke]{fill:none;stroke:currentColor}
.vh-hero-schedule .tail.spin{display:inline-block}
.vh-hero-schedule .sc{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:56px}
.vh-hero-schedule .sc-dial{position:relative;width:206px;height:206px;flex:none}
.vh-hero-schedule .sc-dial svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.vh-hero-schedule .sc-tick{stroke:var(--line);stroke-width:1}
.vh-hero-schedule .sc-tick.big{stroke:var(--dim)}
.vh-hero-schedule .sc-ring{fill:none;stroke:var(--line);stroke-width:1}
.vh-hero-schedule .sc-mk{fill:var(--bg);stroke:var(--dim);stroke-width:1.5;transition:fill 300ms ease,stroke 300ms ease}
.vh-hero-schedule .sc-mk.on{fill:var(--fg);stroke:var(--fg)}
.vh-hero-schedule .sc-mk.ok{fill:var(--ok);stroke:var(--ok)}
.vh-hero-schedule .sc-mk.err{fill:var(--err);stroke:var(--err)}
.vh-hero-schedule .sc-hl{font:10px var(--mono);fill:var(--dim);text-anchor:middle;dominant-baseline:central}
.vh-hero-schedule .sc-ml{font:10px var(--mono);fill:var(--dim);text-anchor:middle;dominant-baseline:central;transition:fill 300ms ease}
.vh-hero-schedule .sc-ml.on{fill:var(--fg)}
.vh-hero-schedule .sc-hand{stroke:var(--fg);stroke-width:1.6;stroke-linecap:round}
.vh-hero-schedule .sc-pin{fill:var(--fg)}
.vh-hero-schedule .sc-now{position:absolute;left:50%;top:60%;transform:translate(-50%,-50%);font:11px var(--mono);color:var(--muted);font-variant-numeric:tabular-nums;background:var(--bg);padding:1px 4px;border-radius:4px}
.vh-hero-schedule .sc-side{width:300px;flex:none;display:flex;flex-direction:column;gap:14px}
.vh-hero-schedule .sc-card{border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);padding:10px 12px;font:12px/1.7 var(--mono);color:var(--muted);white-space:nowrap}
.vh-hero-schedule .sc-card b{font-weight:400;color:var(--fg)}
.vh-hero-schedule .sc-host{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:11px;color:var(--muted)}
.vh-hero-schedule .sc-host>span{display:inline-block;animation:vh-fig-c 300ms var(--out)}
.vh-hero-schedule .sc-runs{position:relative;height:112px}
.vh-hero-schedule .sc-rh{font:11px var(--mono);color:var(--dim);margin:0 0 6px 2px}
.vh-hero-schedule .sc-runs{height:78px}
.vh-hero-schedule .sc-row{position:absolute;left:0;right:0;height:24px;display:flex;align-items:center;transform:translateY(calc(var(--i)*26px + 4px));opacity:0;transition:opacity 260ms var(--out),transform 260ms var(--out)}
.vh-hero-schedule .sc-row.on{opacity:1;transform:translateY(calc(var(--i)*26px))}
.vh-hero-schedule .sc-row .pj{position:absolute;left:0;top:50%;transform:translateY(-50%)}
.vh-hero-schedule .sc-row .pj .body{clip-path:inset(calc(50% - 5px) calc(100% - 10px) calc(50% - 5px) 0 round 99px)}
.vh-hero-schedule .sc-row .pj.open .body{clip-path:inset(0 0 0 0 round 99px)}
.vh-hero-schedule .sc-rt{padding-left:20px;font:12px var(--mono);color:var(--muted);white-space:nowrap;opacity:0;transition:opacity 300ms ease}
.vh-hero-schedule .sc-rt.on{opacity:1}
.vh-hero-schedule .sc-rt b{font-weight:400;color:var(--fg)}
.vh-hero-schedule .sc-rt .ok{color:var(--ok)}.vh-hero-schedule .sc-rt .err{color:var(--err)}
.vh-hero-schedule.fading .sc-row{opacity:0;transition:opacity 400ms}
@container (max-width:560px){
.vh-hero-schedule .sc{gap:22px}
.vh-hero-schedule .sc-dial{width:180px;height:180px}
.vh-hero-schedule .sc-side{width:190px;gap:10px}
.vh-hero-schedule .sc-card{padding:8px 9px;font-size:10.5px;line-height:1.6}
.vh-hero-schedule .sc-rt{font-size:11px}
.vh-hero-schedule .sc-now{font-size:11px}
}
@container (max-width:420px){
.vh-hero-schedule .sc{gap:14px}
.vh-hero-schedule .sc-dial{width:146px;height:146px}
.vh-hero-schedule .sc-side{width:150px}
}`;

export default defineScene<TimelinePlan<ScheduleExtra>>({
css,
  key: "schedule",
  name: "Schedule",
  label: "A 24 hour watch face. The hour hand moves all the time and sweeps one full day. The cron of server/schedules/daily-report.ts, '0 0 * * *', has one mark at 00:00. When the hand reaches it, the host starts a run, and the run goes into a list of past runs. A run that throws is logged and not retried, and the next day runs it again.",
  H: 236,
  steps: p => [
    `daily-report.ts sets the cron '0 0 * * *'. The build gives it to ${p.host.hostName}.`,
    "The clock goes on. Nothing runs before 00:00.",
    "At 00:00 the host starts a run. The handler gets scheduledAt.",
    p.run.err ? "This run throws. ViteHub logs the error and does not retry it." : "The run ends. The next run is tomorrow at 00:00.",
    p.run.err ? "Tomorrow at 00:00 the host runs it again." : "The file is the same on every host.",
  ],
  summary: "server/schedules/daily-report.ts sets the cron '0 0 * * *'. Each day at 00:00 the host runs it. A run that throws is logged and not retried, and the next day runs it again.",
  plan(k) {
    const hosts: Host[] = [
      { id: "cf", name: fs("Cloudflare · Cron Triggers", "Cloudflare"), hostName: "Cloudflare Cron Triggers" },
      { id: "vc", name: fs("Vercel · cron jobs", "Vercel"), hostName: "Vercel cron jobs" },
      { id: "dn", name: fs("Deno · Deno.cron", "Deno"), hostName: "Deno.cron" },
      { id: "nd", name: fs("Node · process driver", "Node"), hostName: "the Node process driver" },
    ];
    const host = hosts[k % 4]!;
    const run = runOf(k + 1);
    const done = RUN + run.dur;
    const A = { run: RUN, done, close: done + 550 };
    const step: Timed<number>[] = [[0, 0], [3000, 1], [A.run, 2], [A.done, 3], [A.close + 1400, 4]];
    return TL().done(LEN, A.close + 1500, { k, host, run, A, step, rows: [k - 1, k, k + 1].map(d => ({ d, ...runOf(d) })) });
  },
  render(stage) {
    const P = (r: number, hr: number): [number, number] => { const a = hr / 24 * 2 * Math.PI; return [100 + Math.sin(a) * r, 100 - Math.cos(a) * r] };
    const ticks = Array.from({ length: 96 }, (_, i) => {
      const hr = i / 4, big = i % 24 === 0, hour = i % 4 === 0, [x1, y1] = P(big ? 85 : hour ? 88 : 91, hr), [x2, y2] = P(94, hr);
      return `<line class="sc-tick${big || hour ? " big" : ""}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${hour || big ? "" : ` style="opacity:.6"`}/>`;
    }).join("");
    const nums = [6, 12, 18].map(hh => { const [x, y] = P(72, hh); return `<text class="sc-hl" x="${x}" y="${y}">${String(hh).padStart(2, "0")}</text>` }).join("");
    const [mx, my] = P(76, 0), [lx, ly] = P(61, 0);
    stage.append(h(`<div class="sc">
      <div class="sc-dial"><svg viewBox="0 0 200 200" aria-hidden="true"><circle class="sc-ring" cx="100" cy="100" r="98"/>${ticks}${nums}
        <circle class="sc-mk" cx="${mx}" cy="${my}" r="5"/><text class="sc-ml" x="${lx}" y="${ly}">00</text>
        <line class="sc-hand" x1="100" y1="110" x2="100" y2="34"/><circle class="sc-pin" cx="100" cy="100" r="3.5"/></svg>
        <span class="sc-now"></span></div>
      <div class="sc-side">
        <div class="sc-card">${fs("server/schedules/", "")}daily-report.ts<br>cron: <b>'0 0 * * *'</b><div class="sc-host"></div></div>
        <div><div class="sc-rh">${fs("runs · vitehub schedule runs", "runs")}</div><div class="sc-runs"></div></div>
      </div></div>`));
    const mk = q<SVGElement>(stage, ".sc-mk"), ml = q<SVGElement>(stage, ".sc-ml"), hand = q<SVGElement>(stage, ".sc-hand"), now = q(stage, ".sc-now");
    const host = q(stage, ".sc-host"), list = q(stage, ".sc-runs");
    hand.style.transformOrigin = "100px 100px";
    const rows = [0, 1, 2].map(() => { const el = h(`<div class="sc-row"><span class="job pj"><span class="body"><span class="lab"></span><span class="tail"></span></span></span><span class="sc-rt"></span></div>`); list.append(el); return el });
    return (t, p) => {
      const A = p.A;
      put(host, `<span>${p.host.id === "cf" ? icon("simple-icons:cloudflare", 13) : p.host.id === "vc" ? icon("simple-icons:vercel", 12) : p.host.id === "dn" ? icon("simple-icons:deno", 13) : icon("simple-icons:nodedotjs", 13)}</span><span>${p.host.name}</span>`);
      // The hand moves at one speed for the whole loop, and the loop ends where the next one starts.
      const hr = H0 + 24 * t / LEN;
      hand.style.transform = `rotate(${(hr / 24 * 360).toFixed(2)}deg)`;
      put(now, `${day(hr >= 24 ? p.k + 1 : p.k)} ${hm(hr)}`);
      const state = t < A.run ? "" : t < A.done ? "on" : p.run.err ? "err" : "ok";
      mk.setAttribute("class", `sc-mk ${state}`);
      ml.setAttribute("class", `sc-ml${t >= A.run - 200 && t < A.close ? " on" : ""}`);
      rows.forEach((el, i) => {
        const r = p.rows[i]!, fresh = i === 2;
        el.style.setProperty("--i", String(i));
        cls(el, "on", !fresh || t >= A.run - 120);
        const pill = q(el, ".pj"), txt = q(el, ".sc-rt");
        const open = fresh && t >= A.run && t < A.close;
        const running = fresh && t < A.done;
        const tone = running ? "" : r.err ? "err" : "ok";
        const c = `job pj ${tone}${open ? " open" : ""}`;
        if (pill.className !== c) pill.className = c;
        put(q(pill, ".lab"), "daily-report");
        const tail = q(pill, ".tail"), w = running ? "spin" : r.err ? "err" : "ok";
        if (tail.dataset.v !== w) { tail.dataset.v = w; tail.className = w === "spin" ? "tail spin" : "tail"; tail.textContent = w === "ok" ? "✓" : w === "err" ? "✕" : "" }
        const at = `${day(r.d)} 00:00`;
        put(txt, r.err ? `<b>${at}</b> <span class="err">${fs("threw · logged", "threw")}</span>` : `<b>${at}</b> <span class="ok">ok</span>${fs(` ${r.ms} ms`, "")}`);
        cls(txt, "on", !fresh || t >= A.close - 100);
      });
      return val(t, p.step, 0) ?? 0;
    };
  },
});
