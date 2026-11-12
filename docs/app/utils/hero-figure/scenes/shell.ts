// Shell: a terminal. The limits sit above it as chips. Commands are typed and run on read-only Workspace files.
// ls and cat answer with exit code 0. A command that is not in the list is refused with exit code 126. rg finds
// many lines, and the output is cut at maxOutputLength with a note.
import { defineScene, clamp, snap, rng, fs, val, TL, h, q, cls, put, type Timed, type TimelinePlan } from "../engine";

const BLOCKED: [string, string][] = [["rm intro.md", "rm"], ["curl https://example.com", "curl"], ["node -e 'fs.rmSync(\"/\")'", "node"]];
const VIEW = 8;
/** An output line: its HTML and an optional tone. */
type Out = [string, string?];

/** One command: the text that is typed, its output lines, and its exit code with a tone. */
interface Cmd {
  cmd: string;
  out: Out[];
  x: [string, string];
  kind?: "block" | "cut";
  name?: string;
}
/** A command with its times and its first line in the terminal. */
interface TimedCmd extends Cmd {
  at: number;
  line: number;
  typed: number;
  done: number;
  outAt: number[];
}
interface ShellExtra {
  cmds: TimedCmd[];
  caps: string[];
  step: Timed<number>[];
  lines: number;
}

const css = `.vh-hero-shell .shx{position:absolute;inset:0;display:flex;flex-direction:column;gap:12px}
.vh-hero-shell .sh-chips{display:flex;flex-wrap:wrap;gap:6px}
.vh-hero-shell .sh-chip{padding:3px 9px;border-radius:99px;box-shadow:inset 0 0 0 1px var(--line);font:11.5px var(--mono);color:var(--muted);white-space:nowrap;transition:box-shadow 300ms ease,color 300ms ease}
.vh-hero-shell .sh-chip b{font-weight:400;color:var(--fg)}
.vh-hero-shell .sh-chip.err{box-shadow:inset 0 0 0 1px var(--err);color:var(--err)}
.vh-hero-shell .sh-chip.err b{color:var(--err)}
.vh-hero-shell .sh-chip.warn{box-shadow:inset 0 0 0 1px var(--warn);color:var(--warn)}
.vh-hero-shell .sh-chip.warn b{color:var(--warn)}
.vh-hero-shell .sh-term{position:relative;flex:1;min-height:0;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.vh-hero-shell .sh-bar{display:flex;justify-content:space-between;padding:7px 14px;font:11px var(--mono);color:var(--dim);box-shadow:inset 0 -1px 0 var(--line)}
.vh-hero-shell .sh-view{position:absolute;left:0;right:0;top:30px;bottom:0;overflow:hidden;-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 6px);mask-image:linear-gradient(to bottom,transparent 0,#000 6px)}
.vh-hero-shell .sh-body{padding:7px 14px;transform:translateY(calc(var(--s,0)*-19px - min(var(--s,0),1)*7px));transition:transform 400ms var(--out)}
.vh-hero-shell .sh-ln{display:flex;justify-content:space-between;gap:12px;height:19px;font:12px/19px var(--mono);color:var(--muted);white-space:nowrap;opacity:0;transition:opacity 200ms ease}
.vh-hero-shell .sh-ln.on{opacity:1}
.vh-hero-shell .sh-ln>span:first-child{overflow:hidden;text-overflow:ellipsis}
.vh-hero-shell .sh-ln.cmd{color:var(--fg)}
.vh-hero-shell .sh-ln.cmd i{font-style:normal;color:var(--dim)}
.vh-hero-shell .sh-ln.err{color:var(--err)}
.vh-hero-shell .sh-ln.warn{color:var(--warn)}
.vh-hero-shell .sh-ln em{font-style:normal;color:var(--fg)}
.vh-hero-shell .sh-x{flex:none;font-size:11px;color:var(--dim);opacity:0;transition:opacity 250ms ease}
.vh-hero-shell .sh-x.on{opacity:1}.vh-hero-shell .sh-x.ok{color:var(--ok)}.vh-hero-shell .sh-x.err{color:var(--err)}.vh-hero-shell .sh-x.warn{color:var(--warn)}
.vh-hero-shell .sh-caret{display:inline-block;width:7px;height:13px;margin-left:1px;vertical-align:-2px;background:var(--fg);animation:sh-blink 1s steps(1) infinite}
@keyframes sh-blink{50%{opacity:0}}
.vh-hero-shell.fading .sh-body{opacity:0;transition:opacity 400ms}
@container (max-width:640px){.vh-hero-shell .sh-chips{gap:4px}.vh-hero-shell .sh-chip{font-size:11px;padding:3px 7px}}
@container (max-width:560px){
.vh-hero-shell .shx{gap:10px}
.vh-hero-shell .sh-chip{font-size:10px;padding:2px 7px}
.vh-hero-shell .sh-ln{font-size:10.5px;gap:6px}
.vh-hero-shell .sh-bar,.vh-hero-shell .sh-body{padding-left:10px;padding-right:10px}
.vh-hero-shell .sh-bar{font-size:10px}
}`;

export default defineScene<TimelinePlan<ShellExtra>>({
css,
  key: "shell",
  name: "Shell",
  label: "A terminal with its limits as chips: only ls, cat, and rg, read-only Workspace files, a 10 second timeout, and an output limit of 5,000 characters. ls and cat run and return exit code 0. A command that is not in the list is refused with exit code 126. rg finds many lines, and the output is cut at the limit with a note.",
  H: 244,
  steps: p => p.caps,
  summary: "The shell runs only the commands you list, on the files you give it. Other commands get exit code 126, and long output is cut at maxOutputLength.",
  plan(k) {
    const r = rng(k + 613);
    const [bcmd, bname] = BLOCKED[k % 3]!;
    const blockFirst = r() < .5;
    const cmds: Cmd[] = [
      { cmd: "ls", out: [["auth.md  billing.md  deploy.md  intro.md"]], x: ["0", "ok"] },
      { cmd: "cat intro.md", out: [["# Acme docs. Start with auth.md."]], x: ["0", "ok"] },
    ];
    const block: Cmd = { cmd: bcmd, out: [[`policy_denied · ${bname} is not allowed`, "err"]], x: ["126", "err"], kind: "block", name: bname };
    const rg: Cmd = {
      cmd: "rg auth .", x: [fs("0 · truncated", "0 · cut"), "warn"], kind: "cut",
      out: [
        ["<em>auth.md:3</em>  Sign in with a passkey or GitHub."], ["<em>auth.md:12</em>  A session expires after 7 days."],
        ["<em>billing.md:8</em>  Only an admin can change auth."], ["<em>deploy.md:21</em>  Set AUTH_SECRET before you deploy."],
        [fs("… output cut at 5,000 characters · outputTruncated", "… cut at 5,000 chars"), "warn"],
      ],
    };
    cmds.push(...(blockFirst ? [block, rg] : [rg, block]));
    // Time each command: typing, a short wait, then the output lines.
    let t = 900, line = 0;
    const caps: [number, string][] = [[0, "The shell can run only ls, cat, and rg, on read-only Workspace files."]];
    const timed: TimedCmd[] = [];
    for (const [i, cmd] of cmds.entries()) {
      const typed = t + cmd.cmd.length * 55, done = typed + snap(350 + r() * 250);
      const c: TimedCmd = { ...cmd, at: t, line, typed, done, outAt: cmd.out.map((_, j) => done + j * 90) };
      timed.push(c);
      if (i === 0) caps.push([c.at, "Each command returns its output and its exit code."]);
      if (c.kind === "block") caps.push([c.done, `${c.name} is not in the list. The shell refuses it with exit code 126.`]);
      if (c.kind === "cut") caps.push([c.done, "rg finds many lines. The output stops at maxOutputLength, and the result says so."]);
      line += 1 + c.out.length;
      t = c.done + c.out.length * 90 + snap(900 + r() * 300);
    }
    const end = t;
    return TL().done(end + 2200, end, { cmds: timed, caps: caps.map(c => c[1]), step: caps.map((c, i): Timed<number> => [c[0], i]), lines: line });
  },
  render(stage) {
    stage.append(h(`<div class="shx">
      <div class="sh-chips"><span class="sh-chip c-cmd">commands: <b>ls cat rg</b></span><span class="sh-chip">${fs("fs: ", "")}<b>read-only /workspace</b></span><span class="sh-chip">timeout: <b>10s</b></span><span class="sh-chip c-out">${fs("maxOutputLength", "output")}: <b>5000</b></span></div>
      <div class="sh-term"><div class="sh-bar"><span>${fs("docsShell().exec()", "exec()")}</span><span>${fs("just-bash · no real processes", "just-bash")}</span></div><div class="sh-view"><div class="sh-body"></div></div></div>
    </div>`));
    const body = q(stage, ".sh-body"), cCmd = q(stage, ".c-cmd"), cOut = q(stage, ".c-out"), view = q(stage, ".sh-view");
    const pool = Array.from({ length: 14 }, () => { const el = h(`<div class="sh-ln"><span></span><span class="sh-x"></span></div>`); body.append(el); return el });
    return (t, p) => {
      let n = 0, shown = 0;
      for (const c of p.cmds) {
        const el = pool[n++]!, txt = q(el, "span"), x = q(el, ".sh-x");
        const chars = clamp(Math.floor((t - c.at) / 55), 0, c.cmd.length);
        const typing = t >= c.at && t < c.done;
        put(txt, `<i>$</i> ${c.cmd.slice(0, chars)}${typing ? `<span class="sh-caret"></span>` : ""}`);
        const cl = `sh-ln cmd${t >= c.at - 150 ? " on" : ""}`;
        if (el.className !== cl) el.className = cl;
        if (t >= c.at - 150) shown = n;
        put(x, `exit ${c.x[0]}`); x.className = `sh-x ${c.x[1]}${t >= c.done ? " on" : ""}`;
        c.out.forEach(([o, tone], j) => {
          const ol = pool[n++]!;
          put(q(ol, "span"), o); put(q(ol, ".sh-x"), "");
          const on = t >= c.outAt[j]!;
          const oc = `sh-ln ${tone ?? ""}${on ? " on" : ""}`;
          if (ol.className !== oc) ol.className = oc;
          if (on) shown = n;
        });
      }
      for (const el of pool.slice(n)) cls(el, "on", false);
      // Keep the newest lines in view.
      const rows = (view.clientHeight - 14) / 19 | 0 || VIEW;
      body.style.setProperty("--s", String(Math.max(0, shown - rows)));
      const block = p.cmds.find(c => c.kind === "block"), cut = p.cmds.find(c => c.kind === "cut");
      cls(cCmd, "err", block && t >= block.done && t < block.done + 1800);
      const cutAt = cut?.outAt.at(-1);
      cls(cOut, "warn", cutAt !== undefined && t >= cutAt && t < cutAt + 1800);
      return val(t, p.step, 0) ?? 0;
    };
  },
});
