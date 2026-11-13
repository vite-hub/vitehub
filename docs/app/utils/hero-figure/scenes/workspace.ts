// Workspace: one folder for the server and an Agent. Each path has a rule: docs/ is read-only, drafts/ and reports/
// are writable. The server and the Agent write files, a write to docs/ fails, and diff() lists each change.
import { defineScene, clamp, snap, rng, pick, fs, icon, h, q, qa, cls, put } from "../engine";

interface WorkspacePlan {
  len: number;
  end: number;
  draft: string;
  deny: string;
  report: string;
  /** The times of the four writes. */
  w: [number, number, number, number];
  done: number;
}
/** A row of the tree: a folder with its rule, a file that is there from the start, or a new file with the index of its write. */
type TreeRow = ["dir", string, "ro" | "rw"] | ["file", string] | ["new", string, number];

/** A write: its tree row, who writes, their icon, and whether the path allows it. */
type Write = [number, string, string, boolean];

const SERVER = icon("lucide:server", 12), BOT = icon("lucide:bot", 12), FOLDER = icon("lucide:folder", 13), FILE = icon("lucide:file", 13);
const LOCK = icon("lucide:lock", 11), PEN = icon("lucide:pencil", 11);

const css = `.vh-hero-workspace svg.icon{position:static;inset:auto;width:auto;height:auto}.vh-hero-workspace svg.icon path{fill:inherit;stroke:inherit;stroke-width:inherit;stroke-dasharray:none;vector-effect:none}
.vh-hero-workspace .w-root{position:absolute;inset:0;display:grid;grid-template-columns:56% 1fr;gap:24px}
.vh-hero-workspace .w-card{display:flex;flex-direction:column;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden;min-width:0}
.vh-hero-workspace .w-hd{height:32px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 12px;box-shadow:inset 0 -1px 0 var(--line);font:11px var(--mono);color:var(--muted);white-space:nowrap}
.vh-hero-workspace .w-hd b{font-weight:400;color:var(--fg)}
.vh-hero-workspace .w-tree{padding:6px 0}
.vh-hero-workspace .w-rw{display:grid;grid-template-rows:0fr;transition:grid-template-rows 420ms var(--out)}
.vh-hero-workspace .w-rw.on{grid-template-rows:1fr}
.vh-hero-workspace .w-r{min-height:0;overflow:hidden}
.vh-hero-workspace .w-row{height:24px;display:flex;align-items:center;gap:7px;padding:0 10px 0 12px;font:12px var(--mono);color:var(--fg);white-space:nowrap;transition:background-color 300ms ease,color 300ms ease;will-change:transform}
.vh-hero-workspace .w-row.in{padding-left:32px}
.vh-hero-workspace .w-row>svg{color:var(--muted);flex-shrink:0}
.vh-hero-workspace .w-row.ok{background:color-mix(in oklab,var(--ok) 10%,transparent)}
.vh-hero-workspace .w-row.err{background:color-mix(in oklab,var(--err) 10%,transparent);color:var(--err)}
.vh-hero-workspace .w-row.new>.w-nm{color:var(--ok)}
.vh-hero-workspace .w-rule{margin-left:auto;display:inline-flex;align-items:center;gap:4px;font:11px var(--mono);color:var(--muted);transition:color 300ms ease}
.vh-hero-workspace .w-rule.err{color:var(--err)}
.vh-hero-workspace .w-pill{margin-left:auto;display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:99px;background:var(--fg);color:transparent;font:11px/1 var(--mono);white-space:nowrap;clip-path:inset(calc(50% - 4px) calc(50% - 4px) round 99px);opacity:0;transition:clip-path 550ms cubic-bezier(.65,0,.35,1) 80ms,color 120ms ease-out,background-color 300ms ease,opacity 250ms ease}
.vh-hero-workspace .w-pill.vis{opacity:1}
.vh-hero-workspace .w-pill.open{color:var(--bg);clip-path:inset(0 round 99px);transition:clip-path 650ms cubic-bezier(.65,0,.35,1),color 250ms ease-out 350ms,background-color 300ms ease,opacity 250ms ease}
.vh-hero-workspace .w-pill.ok{background:var(--ok)}.vh-hero-workspace .w-pill.err{background:var(--err)}
.vh-hero-workspace .w-pill svg{color:inherit}
.vh-hero-workspace .w-pl{display:inline-flex;align-items:center;gap:5px}
.vh-hero-workspace .w-list{padding:6px 0}
.vh-hero-workspace .w-ch{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows 420ms var(--out),opacity 300ms ease}
.vh-hero-workspace .w-ch.on{grid-template-rows:1fr;opacity:1}
.vh-hero-workspace .w-ci{min-height:0;overflow:hidden}
.vh-hero-workspace .w-c{height:30px;display:flex;align-items:center;gap:8px;padding:0 12px;font:12px var(--mono);white-space:nowrap}
.vh-hero-workspace .w-c i{font-style:normal;color:var(--ok);width:10px}
.vh-hero-workspace .w-c span{overflow:hidden;text-overflow:ellipsis}
.vh-hero-workspace .w-c em{margin-left:auto;font-style:normal;display:inline-flex;align-items:center;gap:5px;color:var(--muted);font-size:11px}
.vh-hero-workspace .w-empty{padding:8px 12px;font:11px var(--mono);color:var(--dim)}
@container (max-width:640px){.vh-hero-workspace .w-root{grid-template-columns:58% 1fr;gap:18px}.vh-hero-workspace .w-hd{padding:0 10px}}
@container (max-width:560px){
 .vh-hero-workspace .w-root{grid-template-columns:1fr;grid-template-rows:auto}
 .vh-hero-workspace .w-card+.w-card{display:none}
 .vh-hero-workspace .w-row{font-size:11px}
}`;

export default defineScene<WorkspacePlan>({
  css,
  key: "workspace",
  name: "Workspace",
  label: "A Workspace named docs has three folders. docs is read-only, and drafts and reports are writable. A route writes a draft. An Agent writes a summary, then tries to change a file in docs, and the write fails because the path is read-only. The Agent writes a report. diff lists the three new files.",
  H: 236,
  steps: p => [
    "A Workspace is one folder for your server and Agents. Each path has a rule.",
    `A route writes drafts/${p.draft}. The path is writable, so the file is saved.`,
    "An Agent writes files with its Workspace tools, under the same rules.",
    `The Agent tries to change docs/${p.deny}. The path is read-only, so the write fails.`,
    "diff() lists each change since the start. The read-only files did not change.",
  ],
  summary: "A route and an Agent write files in a Workspace. A write to a read-only path fails, and diff() lists each change.",
  plan(k) {
    const r = rng(k + 9119);
    const draft = pick(r, ["hello.md", "launch.md", "faq.md"]), deny = pick(r, ["intro.md", "guide.md"]);
    const report = pick(r, ["weekly.md", "2026-11.md"]);
    const gap = () => 1900 + snap(r() * 300);
    const w1 = 1400, w2 = w1 + gap(), w3 = w2 + gap(), w4 = w3 + gap(), done = w4 + 1500;
    return { len: done + 2600, end: done + 1200, draft, deny, report, w: [w1, w2, w3, w4], done };
  },
  render(stage) {
    // [kind, name, rule or new-at index]
    const TREE: TreeRow[] = [["dir", "docs/", "ro"], ["file", "intro.md"], ["file", "guide.md"], ["dir", "drafts/", "rw"], ["new", "draft", 0], ["new", "summary.md", 1], ["dir", "reports/", "rw"], ["new", "report", 3]];
    const root = h(`<div class="w-root">
      <div class="w-card"><div class="w-hd"><span>useWorkspace(<b>'docs'</b>)</span><span class="w-tp"></span></div><div class="w-tree">${TREE.map(([kind, , rule]) => `<div class="w-rw"><div class="w-r"><div class="w-row ${kind === "dir" ? "" : "in"}">${kind === "dir" ? FOLDER : FILE}<span class="w-nm"></span>${kind === "dir" ? `<span class="w-rule">${rule === "ro" ? `${LOCK}read-only` : `${PEN}writable`}</span>` : `<span class="w-pill"><span class="w-pl"></span></span>`}</div></div></div>`).join("")}</div></div>
      <div class="w-card"><div class="w-hd"><span><b>docs.diff()</b></span><span class="w-n"></span></div><div class="w-list"><div class="w-empty">no changes</div>${[0, 1, 2].map(() => `<div class="w-ch"><div class="w-ci"><div class="w-c"><i>+</i><span></span><em></em></div></div></div>`).join("")}</div></div>
    </div>`);
    stage.append(root);
    const wraps = qa(root, ".w-tree .w-rw"), rows = wraps.map(w => q(w, ".w-row"));
    const chs = qa(root, ".w-ch"), empty = q(root, ".w-empty"), count = q(root, ".w-n"), top = q(root, ".w-tp");
    return (t, p, still) => {
      root.style.opacity = still ? "1" : (1 - clamp((t - (p.len - 500)) / 500)).toFixed(3);
      const names: Record<string, string> = { draft: p.draft, report: p.report };
      // The writes: [row index, who, ok]. Row 1 or 2 is the denied docs file.
      const denyRow = p.deny === "intro.md" ? 1 : 2;
      const W: Write[] = [[4, "route", SERVER, true], [5, "Agent", BOT, true], [denyRow, "Agent", BOT, false], [7, "Agent", BOT, true]];
      TREE.forEach((node, i) => {
        const row = rows[i]!, at = node[0] === "new" ? p.w[node[2]] ?? 0 : 0;
        put(q(row, ".w-nm"), names[node[1]] ?? node[1]);
        cls(wraps[i]!, "on", node[0] !== "new" || t >= at - 100);
        cls(row, "new", node[0] === "new" && t >= at + 700 && t < at + 2400);
      });
      rows.forEach((row, i) => {
        const wi = W.findIndex(w => w[0] === i), write = W[wi];
        let ok = false, err = false, shake = 0;
        if (write) {
          const pill = q(row, ".w-pill"), at = p.w[wi] ?? 0, [, who, ic, good] = write;
          const keep = still && !good;
          const vis = keep || (t >= at && t < at + 1700);
          cls(pill, "vis", vis);
          cls(pill, "open", keep || (vis && t < at + 1300));
          cls(pill, "ok", good && t >= at + 700);
          cls(pill, "err", !good && t >= at + 700);
          put(q(pill, ".w-pl"), t >= at + 700 ? (good ? `${ic}${fs(`${who} · saved`, "saved")}` : `${ic}${fs("denied: read-only", "denied")}`) : `${ic}${fs(`${who} · writeFile`, "write")}`);
          ok = good && t >= at + 700 && t < at + 1500;
          err = !good && t >= at + 700 && (still || t < at + 1900);
          if (!good && t >= at + 700 && t < at + 1200) { const u = (t - at - 700) / 500; shake = Math.sin(u * Math.PI * 6) * 5 * (1 - u) }
        }
        cls(row, "ok", ok); cls(row, "err", err);
        row.style.transform = shake ? `translateX(${shake.toFixed(2)}px)` : "";
      });
      // The read-only rule turns red while the write fails.
      cls(q(root, ".w-rule"), "err", t >= p.w[2] + 700 && (still || t < p.w[2] + 1900));
      // diff(): one line per saved file.
      const saved: [number, string, string][] = [[0, `drafts/${p.draft}`, SERVER], [1, "drafts/summary.md", BOT], [3, `reports/${p.report}`, BOT]];
      const added = (wi: number) => t >= (p.w[wi] ?? 0) + 900;
      saved.forEach(([wi, path], i) => {
        const ch = chs[i]!;
        cls(ch, "on", added(wi));
        put(q(ch, "span"), path);
        put(q(ch, "em"), "added");
      });
      const n = saved.filter(([wi]) => added(wi)).length;
      empty.style.display = n > 0 ? "none" : "";
      put(count, n ? `${n} added` : "");
      put(top, fs("server/workspaces/docs.ts", n ? `diff: ${n} added` : ""));
      if (t >= p.done) return 4;
      if (t >= p.w[2]) return 3;
      if (t >= p.w[1]) return 2;
      if (t >= p.w[0]) return 1;
      return 0;
    };
  },
});
