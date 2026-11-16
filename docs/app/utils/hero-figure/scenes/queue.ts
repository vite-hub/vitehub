// Queue: three routes send email jobs to one queue at different times, and each route replies at once. One consumer
// runs the jobs one by one. Waiting jobs stand in line, one behind the other, and move up when the first one leaves.
// A job leaves the queue only when the consumer is free. The invite email fails, goes back under the line as a red
// ball, joins the end of the line, and works on its second attempt. The reset email does not wait for that retry.
import { defineScene, ease, easeIn, clamp, snap, rng, h, q, qa, cls, put, type Point } from "../engine";

// Coordinates: x in percent of the figure width, y in pixels from the lane center.
const ROUTES = [{ path: "POST /api/signup", y: -56 }, { path: "POST /api/invite", y: 0 }, { path: "POST /api/reset", y: 56 }];
const RX = 33, QX = 50, CX = 83.333, EXIT = 100, LANE = 176, LOOP = 46;
const CALL = 300, TRAVEL = 900, MOVE = 700, RUN = 1000, SHOW = 700, FAILSHOW = 500, BACK = 1400, RETRY = 2000, LEAVE = 900;
// The space in px between balls that wait in line, and how long a ball takes to move up one place.
const GAP = 18, ADV = 500;

interface Job {
  email: string;
  name: string;
  route: number;
  fails?: boolean;
  /** When the route gets the request. */
  req: number;
}
/** One time a job goes through the queue. A failed job has a second visit. */
interface Visit {
  job: Job;
  /** When the job reaches its place in line. */
  entry: number;
  /** When the queue can give the job to the consumer. */
  ready: number;
  attempt: number;
  /** When the job leaves the queue for the consumer. */
  start: number;
  fail?: number;
  back?: number;
  done?: number;
}
interface QueuePlan {
  len: number;
  end: number;
  jobs: Job[];
  visits: Visit[];
  stepAt: number[];
  /** The second visit of the failed job. */
  retry: Visit;
}
type State = "hidden" | "calling" | "moving" | "waiting" | "running" | "failed" | "retrying" | "done" | "gone";
interface JobFrame {
  state: State;
  p: Point;
  dx: number;
  open: boolean;
  a: number;
  loop?: boolean;
  leaving?: boolean;
}
type Curve = [Point, Point, Point, Point];

const BASE = [
  { email: "ada@example.com", name: "ada", route: 0 },
  { email: "ben@example.com", name: "ben", route: 1, fails: true },
  { email: "cy@example.com", name: "cy", route: 2 },
];

const at = ([p0, p1, p2, p3]: Curve, u: number): Point => {
  const v = 1 - u;
  const c = (k: 0 | 1) => v * v * v * p0[k] + 3 * v * v * u * p1[k] + 3 * v * u * u * p2[k] + u * u * u * p3[k];
  return [c(0), c(1)];
};
const toQueue = (y: number): Curve => [[RX, y], [RX + 11, y], [QX - 11, 0], [QX, 0]];
const loopBack: Curve = [[CX, 0], [CX - 2, LOOP * 1.35], [QX - 4, LOOP * 1.35], [QX, 0]];
const line = (a: Point, b: Point): Curve => [a, a, b, b];
const pathD = (c: Curve) => {
  const Y = ([x, y]: Point) => `${x} ${LANE / 2 + y}`;
  return `M${Y(c[0])} C ${Y(c[1])}, ${Y(c[2])}, ${Y(c[3])}`;
};

// How many places from the front a visit is at time t. A ball moves up smoothly when the one ahead leaves.
const place = (p: QueuePlan, v: Visit, t: number) => {
  let n = 0;
  for (const f of p.visits) if (f !== v && f.entry < v.entry) n += 1 - ease(clamp((t - f.start) / ADV));
  return n;
};

function jobAt(p: QueuePlan, j: Job, t: number): JobFrame {
  const y = ROUTES[j.route]?.y ?? 0, c: Point = [CX, 0];
  const s = (state: State, pos: Point, extra: Partial<JobFrame> = {}): JobFrame => ({ state, p: pos, dx: 0, open: false, a: 1, ...extra });
  const [v1, v2] = p.visits.filter(v => v.job === j);
  if (t < j.req || !v1) return s("hidden", [RX, y], { a: 0 });
  if (t < j.req + CALL) return s("calling", [RX, y]);
  // Arriving: the curve ends at the queue, shifted back to the job's place in line.
  const arrive = (v: Visit, curve: Curve, from: number, length: number, state: State) => {
    const u = ease((t - from) / length);
    return s(state, at(curve, u), { dx: -GAP * place(p, v, t) * u });
  };
  const wait = (v: Visit, state: State) => s(state, [QX, 0], { dx: -GAP * place(p, v, t) });
  const go = (v: Visit) => s("moving", at(line([QX, 0], c), ease((t - v.start) / MOVE)));
  if (t < v1.entry) return arrive(v1, toQueue(y), j.req + CALL, TRAVEL, "moving");
  if (t < v1.start) return wait(v1, "waiting");
  if (t < v1.start + MOVE) return go(v1);
  let v = v1;
  if (v2 && v1.fail !== undefined && v1.back !== undefined) {
    if (t < v1.fail) return s("running", c, { open: true });
    if (t < v1.back) return s("failed", c, { open: true });
    if (t < v2.entry) return { ...arrive(v2, loopBack, v1.back, BACK, "retrying"), loop: true };
    if (t < v2.start) return wait(v2, t < v2.ready ? "retrying" : "waiting");
    if (t < v2.start + MOVE) return go(v2);
    v = v2;
  }
  const done = v.done ?? 0;
  if (t < done) return s("running", c, { open: true });
  if (t < done + SHOW) return s("done", c, { open: true });
  if (t < done + SHOW + LEAVE) {
    const u = (t - done - SHOW) / LEAVE;
    return s("done", at(line(c, [EXIT, 0]), easeIn(u)), { a: Math.max(0, 1 - Math.max(0, (u - .2) / .5)), leaving: true });
  }
  return s("gone", [EXIT, 0], { a: 0 });
}

const css = `.vh-fig.vh-hero-queue>.lane{margin-top:0}
.vh-hero-queue .q-heads{display:grid;grid-template-columns:36% 28% 36%;height:41px;text-align:center}
.vh-hero-queue .q-lbl{font-size:14px;font-weight:500}
.vh-hero-queue .q-nm{display:block;margin-top:4px;color:var(--muted);font:12px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 6px}
.vh-hero-queue .q-lane{position:relative;height:${LANE}px;margin-top:12px}
.vh-hero-queue .q-lane svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.vh-hero-queue .q-lane path{fill:none;stroke:var(--line);stroke-width:1;stroke-dasharray:4 5;vector-effect:non-scaling-stroke}
.vh-hero-queue .q-stop{position:absolute;top:50%;left:0;width:7px;height:7px;border-radius:99px;background:var(--dim);transform:translate(calc(var(--x)*1cqi - 50%),calc(var(--y)*1px - 50%))}
.vh-hero-queue .q-route{position:absolute;top:50%;right:calc(100% - var(--x)*1cqi + 14px);transform:translateY(calc(var(--y)*1px - 50%));text-align:right;font:12px var(--mono);white-space:nowrap}
.vh-hero-queue .q-route small{display:block;margin-top:3px;color:var(--ok);font-size:11px;opacity:0;transform:translateY(3px);transition:opacity 200ms var(--out),transform 200ms var(--out)}
.vh-hero-queue .q-route small.on{opacity:1;transform:none}
.vh-hero-queue .q-job{position:absolute;top:50%;left:0;display:flex;transform:translate(calc(var(--x)*1cqi - 50% + var(--dx,0)*1px),calc(var(--y)*1px - 50%));opacity:var(--a,1);will-change:transform}
.vh-hero-queue .q-body{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:99px;background:var(--fg);color:transparent;font:12px/1 var(--mono);white-space:nowrap;clip-path:inset(calc(50% - 5px) calc(50% - 5px) round 99px);transition:clip-path 550ms cubic-bezier(.65,0,.35,1) 80ms,color 120ms ease-out,background-color 300ms ease}
.vh-hero-queue .q-job.open{z-index:1}
.vh-hero-queue .q-job.open .q-body{color:var(--bg);clip-path:inset(0 round 99px);transition:clip-path 650ms cubic-bezier(.65,0,.35,1),color 250ms ease-out 350ms,background-color 300ms ease}
.vh-hero-queue .q-job.q-failed .q-body,.vh-hero-queue .q-job.q-retrying .q-body{background:var(--err)}
.vh-hero-queue .q-job.q-done .q-body{background:var(--ok)}
.vh-hero-queue .q-lane path.q-tail-line{stroke:url(#vh-hero-queue-tailfade)}
.vh-hero-queue .q-lane path.q-loop{stroke:var(--err);opacity:0;transition:opacity 300ms ease}
.vh-hero-queue .q-lane path.q-loop.on{opacity:.45}
.vh-hero-queue .q-short{display:none}
@container (max-width:520px){
.vh-hero-queue .q-full{display:none}
.vh-hero-queue .q-short{display:inline}
}
@container (max-width:420px){
.vh-hero-queue .q-route{right:calc(100% - var(--x)*1cqi + 10px);font-size:10.5px}
.vh-hero-queue .q-route small{font-size:10px}
}
.vh-hero-queue .q-det{display:grid;grid-template-columns:36% 28% 36%;min-height:20px;margin-top:4px;text-align:center}
.vh-hero-queue .q-det>div{display:grid;justify-items:center}
.vh-hero-queue .q-det>div>*{grid-area:1/1}
.vh-hero-queue .q-row{font:12px var(--mono);color:var(--muted);font-variant-numeric:tabular-nums;opacity:0;transform:translateY(4px);transition:opacity 200ms var(--out),transform 200ms var(--out)}
.vh-hero-queue .q-row.on{opacity:1;transform:none}
.vh-hero-queue .q-row.ok{color:var(--ok)}
.vh-hero-queue .q-row.err{color:var(--err)}
.vh-hero-queue.fading .q-row,.vh-hero-queue.fading .q-route small{opacity:0;transition-duration:400ms}`;

export default defineScene<QueuePlan>({
  css,
  key: "queue",
  name: "Queue",
  label: "Three routes send email jobs to one queue at different times, and each route replies at once. One consumer runs the jobs one by one. The invite email fails, waits in the queue, and works on its second attempt, while the next job runs.",
  // The heads (41), the gap (12), the lane, the gap (4), and the line under it (20).
  H: 41 + 12 + LANE + 4 + 20,
  steps: [
    "A signup reaches its route. The route sends a job to the queue and replies at once.",
    "The consumer runs one job at a time. The other jobs wait in line in the queue.",
    "The invite email fails. The queue takes it back and puts it at the end of the line.",
    "The next job does not wait for the retry.",
    "The retry works. Every job is done.",
  ],
  summary: "Each route replies at once. The jobs wait in line, one consumer runs them later, and the failed one runs again.",
  plan(k) {
    // Each loop picks new times for the second and third requests, so the rhythm is never the same.
    const r = rng(k + 11), ben = snap(900 + r() * 1700), cy = snap(ben + 350 + r() * 1600);
    const reqs = [600, ben, cy];
    const jobs: Job[] = BASE.map((j, i) => ({ ...j, req: reqs[i] ?? 0 }));
    // The queue is a line, first in, first out. A job leaves it only when the consumer is free.
    // A failed job goes back under the line and joins the end of the queue. It can run again after RETRY.
    const visits: Visit[] = [];
    type Pending = Omit<Visit, "start">;
    const pending: Pending[] = jobs.map(job => ({ job, entry: job.req + CALL + TRAVEL, ready: job.req + CALL + TRAVEL, attempt: 1 }));
    let free = 0;
    for (;;) {
      pending.sort((x, y) => Math.max(x.ready, free) - Math.max(y.ready, free) || x.entry - y.entry);
      const next = pending.shift();
      if (!next) break;
      const v: Visit = { ...next, start: Math.max(next.ready, next.entry, free) };
      visits.push(v);
      const end = v.start + MOVE + RUN;
      if (v.job.fails && v.attempt === 1) {
        v.fail = end;
        v.back = end + FAILSHOW;
        free = v.back;
        pending.push({ job: v.job, entry: v.back + BACK, ready: v.back + RETRY, attempt: 2 });
      } else {
        v.done = end;
        free = end + SHOW + 400;
      }
    }
    const [first] = visits, [firstBen, retry] = visits.filter(v => v.job.fails), reset = visits.find(v => v.job.route === 2);
    if (!first || !firstBen || !retry || !reset) throw new Error("hero figure: the queue plan has no retry");
    const lastDone = visits.at(-1)?.done ?? 0;
    const stepAt = [0, first.start + MOVE, firstBen.fail ?? 0, reset.start, retry.done ?? 0];
    return { len: lastDone + SHOW + LEAVE + 1400, end: lastDone + 400, jobs, visits, stepAt, retry };
  },
  render(stage) {
    stage.append(h(`<div class="q">
      <div class="q-heads"><div><span class="q-lbl">Routes</span><span class="q-nm"><span class="q-full">sendQueue('emails', …)</span><span class="q-short">sendQueue()</span></span></div><div><span class="q-lbl">Queue</span><span class="q-nm">emails</span></div><div><span class="q-lbl">Consumer</span><span class="q-nm">queues/emails.ts</span></div></div>
      <div class="q-lane"><svg viewBox="0 0 100 ${LANE}" preserveAspectRatio="none" aria-hidden="true">${ROUTES.map(r => `<path d="${pathD(toQueue(r.y))}"/>`).join("")}<path d="${pathD(line([QX, 0], [CX, 0]))}"/><defs><linearGradient id="vh-hero-queue-tailfade" x1="0" x2="1"><stop offset="0" style="stop-color:var(--line)"/><stop offset="1" style="stop-color:var(--line);stop-opacity:0"/></linearGradient></defs><path class="q-tail-line" d="${pathD(line([CX, 0], [EXIT, 0]))}"/><path class="q-loop" d="${pathD(loopBack)}"/></svg>${ROUTES.map(r => `<span class="q-stop" style="--x:${RX};--y:${r.y}"></span><span class="q-route" style="--x:${RX};--y:${r.y}">${r.path}<small class="q-ok">200 OK · 12 ms</small></span>`).join("")}<span class="q-stop" style="--x:${QX};--y:0"></span><span class="q-stop" style="--x:${CX};--y:0"></span>${BASE.map(j => `<span class="q-job"><span class="q-body">✉ <span class="q-full">${j.email}</span><span class="q-short">${j.name}</span><span class="q-tail"></span></span></span>`).join("")}</div>
      <div class="q-det"><div></div><div><span class="q-row err q-retry"></span><span class="q-row q-waiting"></span></div><div><span class="q-row ok q-done-n"></span></div></div>
    </div>`));
    const jobEls = qa(stage, ".q-job"), oks = qa(stage, ".q-ok"), loop = q<SVGPathElement>(stage, ".q-loop");
    const retryEl = q(stage, ".q-retry"), waitingEl = q(stage, ".q-waiting"), doneEl = q(stage, ".q-done-n");
    return (t, p) => {
      const frames = p.jobs.map(j => jobAt(p, j, t));
      frames.forEach((f, i) => {
        const el = jobEls[i];
        if (!el) return;
        el.style.setProperty("--x", f.p[0].toFixed(3));
        el.style.setProperty("--y", f.p[1].toFixed(2));
        el.style.setProperty("--a", f.a.toFixed(3));
        el.style.setProperty("--dx", f.dx.toFixed(2));
        const c = `q-job q-${f.state}${f.open ? " open" : ""}`;
        if (el.className !== c) el.className = c;
        const tail = q(el, ".q-tail");
        const want = f.state === "running" ? "spin" : f.state === "failed" ? "✕" : f.state === "done" && !f.leaving ? "✓" : "";
        if (tail.dataset.v !== want) {
          tail.dataset.v = want;
          tail.className = want === "spin" ? "q-tail spin" : "q-tail";
          tail.textContent = want === "spin" ? "" : want;
        }
      });
      p.jobs.forEach((j, i) => { const el = oks[i]; if (el) cls(el, "on", t >= j.req + CALL) });
      cls(loop, "on", frames.some(f => f.loop));
      const retrying = frames.some(f => f.state === "retrying");
      const retryIn = retrying ? Math.max(1, Math.ceil((p.retry.ready - t) / 1000)) : null;
      const waiting = p.visits.filter(v => t >= v.entry && t < v.start).length;
      const done = p.visits.filter(v => v.done !== undefined && t >= v.done).length;
      put(retryEl, `Retry in ${retryIn ?? 2}s`);
      cls(retryEl, "on", retryIn !== null);
      put(waitingEl, `${waiting} waiting`);
      cls(waitingEl, "on", retryIn === null && waiting > 0);
      put(doneEl, `${done} done`);
      cls(doneEl, "on", done > 0);
      let step = 0;
      p.stepAt.forEach((x, i) => { if (t >= x) step = i });
      return step;
    };
  },
});
