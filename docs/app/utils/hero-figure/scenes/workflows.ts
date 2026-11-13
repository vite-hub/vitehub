// Workflows: one run of a podcast pipeline with three steps. The route returns the run id at once. Each step saves
// its result, and the run completes.
import { defineScene, snap, rng, pick, fs, TL, type Point } from "../engine";

export default defineScene({
  key: "workflows",
  name: "Workflows",
  label: "A route starts a run of the publish-episode workflow and returns its id at once. The run goes through three steps: transcribe, summarize, and publish. Each step saves its result before the next one starts. The run completes, and any route can read its status and result.",
  H: 120,
  // Five file names share one row. At the docs column width, a smaller name keeps a gap between them.
  css: `@container (max-width:640px){.vh-fig.vh-hero-workflows .head .nm{font-size:11px}}`,
  heads: [
    { x: 9, label: "Route", name: "startWorkflow()" },
    { x: 29.5, label: "Step 1", name: "01.transcribe.ts" },
    { x: 50, label: "Step 2", name: "02.summarize.ts" },
    { x: 69, label: "Step 3", name: "03.publish.ts" },
    { x: 100, label: "Run", name: "getWorkflowRun(id)", align: "l" },
  ],
  paths: [{ pts: [[9, 0], [69, 0]] }, { pts: [[69, 0], [86, 0]], cls: "tail" }],
  stops: [{ id: "r", x: 9, y: 0 }, { id: "1", x: 29.5, y: 0 }, { id: "2", x: 50, y: 0 }, { id: "3", x: 69, y: 0 }],
  texts: [
    { id: "id", x: 9, y: 24, cls: "sm" },
    { id: "r1", x: 29.5, y: 24, cls: "sm" }, { id: "r2", x: 50, y: 24, cls: "sm" }, { id: "r3", x: 69, y: 24, cls: "sm" },
    { id: "st", x: 100, y: 0, align: "r" }, { id: "res", x: 100, y: 24, cls: "sm", align: "r" },
  ],
  tokens: ["run"],
  steps: () => [
    "A request starts a run. The route returns the run id at once and does not wait.",
    "The run goes through the steps in order.",
    "Each step saves its result. The next step starts from that result.",
    "The run completes. Any route can read its status and result with the id.",
  ],
  summary: "A run goes through the steps in order. Each step saves its result, and any route can read the run with its id.",
  plan(k) {
    const r = rng(k + 101), id = pick(r, ["run_9fa", "run_k27", "run_3xe", "run_q8m"]);
    const X = [29.5, 50, 69] as const, NAMES = [fs("transcribe", "1"), fs("summarize", "2"), fs("publish", "3")];
    const RESULT: [string, string, string] = [pick(r, ["4,812 words", "5,107 words", "3,960 words"]), "summary.md", pick(r, ["/episodes/42", "/episodes/43"])];
    const tl = TL();
    let t = 500;
    tl.pos("run", 0, [9, 0]).look("run", t, {}).set("stop", "r", t, "on").set("text", "st", 0, null);
    t += 300;
    tl.set("text", "id", t, { v: fs(`→ ${id}`, "→ id"), tone: "fg" }).set("text", "st", t, fs("queued", "…")).step(0, 0);
    tl.pos("run", t, [9, 0]);
    t += 900;
    for (let i = 0; i < 3; i++) {
      const at: Point = [X[i]!, 0], name = NAMES[i]!, d = snap(1100 + r() * 900);
      tl.pos("run", t, at).look("run", t, { open: true, text: name, tail: "spin" }).set("text", "st", t, { v: fs(`running · ${i + 1}/3`, `${i + 1}/3`), tone: "fg" });
      if (i === 0) tl.step(t, 1);
      t += d;
      tl.look("run", t, { open: true, text: name, tail: "ok", tone: "ok" });
      t += 600;
      tl.look("run", t, {}).set("stop", String(i + 1), t, "ok").set("text", `r${i + 1}`, t, { v: fs(RESULT[i]!, "✓"), tone: "ok" });
      if (i === 0) tl.step(t, 2);
      tl.pos("run", t, at);
      t += i < 2 ? 800 : 0;
    }
    tl.pos("run", t + 800, [86, 0]).fade("run", t + 300, t + 800).look("run", t, { small: false });
    t += 800;
    tl.set("text", "st", t, { v: fs("completed", "done"), tone: "ok" }).set("text", "res", t, { v: fs(RESULT[2], ""), tone: "fg" }).step(t, 3);
    return tl.done(t + 2600, t + 400);
  },
});
