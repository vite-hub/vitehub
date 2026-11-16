// Env: settings are declared once, with a type and a side. The host gives text. Each row turns that text into the
// declared type, then the value goes to the browser and the server, or only to the server. A secret stays on the
// server and prints as <redacted>.
import { defineScene, snap, rng, pick, fs, TL, icon, h, q, cls, put } from "../engine";
import type { TimelinePlan } from "../engine";

interface Row {
  name: string;
  kind: string;
  raw: string;
  typed: string;
  type: string;
  pub?: boolean;
  secret?: boolean;
  /** When the row starts. */
  at: number;
}
type EnvPlan = TimelinePlan<{ rows: Row[] }>;

const css = `.vh-hero-env svg.icon{position:static;width:auto;height:auto}
.vh-hero-env .icon path{stroke-dasharray:none;vector-effect:none;transition:none;fill:inherit;stroke:inherit;stroke-width:inherit}
.vh-hero-env .icon path[fill="none"]{fill:none;stroke:currentColor;stroke-width:2}
.vh-hero-env .ev{position:absolute;inset:0;font:12px var(--mono)}
.vh-hero-env .ev-g{display:grid;grid-template-columns:30% 26% 20% 24%;align-items:center}
.vh-hero-env .ev-h{height:30px;color:var(--muted);font-size:11px;box-shadow:inset 0 -1px 0 var(--line)}
.vh-hero-env .ev-h span{padding:0 12px;display:flex;align-items:center;gap:6px}
.vh-hero-env .ev-r{position:relative;height:44px;border-radius:8px;transition:background-color 400ms ease}
.vh-hero-env .ev-r.cur{background:var(--soft)}
.vh-hero-env .ev-r>div{padding:0 12px;min-width:0;white-space:nowrap}
.vh-hero-env .ev-r small{display:block;margin-top:3px;font-size:11px;color:var(--muted)}
.vh-hero-env .ev-d b{font-weight:400;color:var(--fg)}
.vh-hero-env .ev-v{position:relative;height:44px}
.vh-hero-env .ev-v>span{position:absolute;left:12px;top:8px;transition:opacity 350ms var(--out),transform 350ms var(--out)}
.vh-hero-env .ev-v .s{color:var(--muted);opacity:0;transform:translateY(4px)}
.vh-hero-env .ev-v .s.on{opacity:1;transform:none}
.vh-hero-env .ev-v .s.on.gone{opacity:0;transform:translateY(-8px)}
.vh-hero-env .ev-v .ty{color:var(--fg);opacity:0;transform:translateY(8px)}
.vh-hero-env .ev-v .ty.on{opacity:1;transform:none}
.vh-hero-env .ev-v small{color:var(--dim)}
.vh-hero-env .ev-v .ty small{color:var(--muted)}
.vh-hero-env .ev-c{display:flex;align-items:center;gap:6px;opacity:0;transform:translateX(-6px);transition:opacity 350ms var(--out),transform 350ms var(--out)}
.vh-hero-env .ev-c.on{opacity:1;transform:none}
.vh-hero-env .ev-c.ok .m{color:var(--ok)}
.vh-hero-env .ev-c.no{color:var(--dim)}
.vh-hero-env .ev-c .x{overflow:hidden;text-overflow:ellipsis}
.vh-hero-env.fading .ev-c,.vh-hero-env.fading .ev-v>span{opacity:0!important;transition:opacity 400ms}
@container (max-width:560px){
  .vh-hero-env .ev{font-size:11px}
  .vh-hero-env .ev-g{grid-template-columns:30% 24% 20% 26%}
  .vh-hero-env .ev-h span,.vh-hero-env .ev-r>div{padding:0 5px}
  .vh-hero-env .ev-v>span{left:5px}
  .vh-hero-env .ev-r small{font-size:10px}
  .vh-hero-env .ev-c .no-t,.vh-hero-env .ev-h svg,.vh-hero-env .ev-c .m{display:none}
  .vh-hero-env .ev-h{font-size:10px}
}`;

export default defineScene<EnvPlan>({
  css,
  key: "env",
  name: "Env",
  label: "Four declared settings. The host gives each one as text. ViteHub turns the text into the declared type, so the text 3000 becomes the number 3000 and the text false becomes the boolean false. The public appName goes to the browser and the server. Server values stay on the server, and the secret token prints as redacted.",
  H: 216,
  steps: [
    "You declare each setting once. A public value goes to the browser and the server.",
    "The host gives text. env.number() turns it into a number.",
    "env.boolean() gives a real boolean. Server values never reach the browser.",
    "A secret stays on the server. It prints as <redacted> until you call unseal().",
  ],
  summary: "You declare each setting once, with its type. Host text becomes a number, a boolean, or a secret. Public values reach the browser, and server values and secrets stay on the server.",
  plan(k) {
    const r = rng(k + 503);
    const app = pick(r, ["Acme", "Nimbus", "Orbit", "Pebble"]);
    const port = pick(r, ["3000", "8080", "4321", "5173"]);
    const dry = pick(r, ["true", "false"]);
    const tok = pick(r, ["ghp_9fK2", "ghp_x81Q", "ghp_Lm4c"]);
    const t0 = 600, gap = 2300;
    const rows: Row[] = ([
      { name: "appName", kind: fs("env()", "env()"), raw: `"${app}"`, typed: `'${app}'`, type: "string", pub: true },
      { name: "port", kind: "env.number()", raw: `"${port}"`, typed: port, type: "number" },
      { name: "dryRun", kind: fs("env.boolean()", "boolean()"), raw: `"${dry}"`, typed: dry, type: "boolean" },
      { name: "github.token", kind: fs("env({ secret: true })", "secret"), raw: `"${tok}…"`, typed: "&lt;redacted&gt;", type: "SecretEnv", secret: true },
    ] satisfies Omit<Row, "at">[]).map((x, i) => ({ ...x, at: t0 + i * gap + (i ? snap(r() * 200) : 0) }));
    const last = rows.at(-1)?.at ?? t0;
    return TL().done(last + 4300, last + 2400, { rows });
  },
  render(stage) {
    stage.append(h(`<div class="ev">
      <div class="ev-g ev-h"><span>declared</span><span>value</span><span>${icon("lucide:globe", 12)}browser</span><span>${icon("lucide:server", 12)}server</span></div>
      <div class="ev-rows"></div>
    </div>`));
    const body = q(stage, ".ev-rows");
    const R = [...Array(4)].map(() => {
      const el = h(`<div class="ev-g ev-r"><div class="ev-d"></div><div class="ev-v"><span class="s"></span><span class="ty"></span></div><div class="ev-c b"></div><div class="ev-c sv"></div></div>`);
      body.append(el); return el;
    });
    const no = `${icon("lucide:lock", 12)}<span class="no-t">server only</span>`;
    return (t, p, still) => {
      let step = 0;
      p.rows.forEach((x, i) => {
        const el = R[i]!, d = q(el, ".ev-d"), b = q(el, ".ev-c.b"), s = q(el, ".ev-c.sv"), raw = q(el, ".ev-v .s"), ty = q(el, ".ev-v .ty");
        const next = p.rows[i + 1]?.at ?? p.len;
        const typed = t >= x.at + 900, out = t >= x.at + 1500;
        if (t >= x.at) step = i;
        cls(el, "cur", !still && t >= x.at && t < next);
        put(d, `<b>${x.pub ? fs("public.appName", "appName") : x.name}</b><small>${x.kind}</small>`);
        put(raw, `${x.raw}<small>string</small>`.replace("<small>", "<small style=\"display:block\">"));
        put(ty, `${x.typed}<small style="display:block">${x.type}</small>`);
        cls(raw, "on", t >= x.at); cls(raw, "gone", typed); cls(ty, "on", typed);
        put(b, x.pub ? `<span class="m">${icon("lucide:check", 13)}</span><span class="x">${x.typed}</span>` : no);
        put(s, `<span class="m">${icon("lucide:check", 13)}</span><span class="x">${x.typed}</span>`);
        b.className = `ev-c b ${x.pub ? "ok" : "no"}${out ? " on" : ""}`;
        s.className = `ev-c sv ok${out ? " on" : ""}`;
      });
      return step;
    };
  },
});
