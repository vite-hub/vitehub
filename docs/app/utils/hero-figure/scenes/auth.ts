// Auth: a bento grid of what Better Auth gives the app from server/auth.ts. Sign-in methods on the left, plugins
// in the bottom row, and a protected /admin page tile. The user signs in with one method, the page tile opens and
// greets them, then plugin tiles light up one by one and add what they give to the page. Each loop uses another
// sign-in method, user, and plugin order.
import { defineScene, snap, rng, pick, fs, TL, icon, h, cls, put, q, qa, type TimelinePlan } from "../engine";

type Method = "mail" | "gh" | "gg" | "pk";
type Plugin = "tf" | "ml" | "org" | "adm";
type TileId = Method | Plugin;
/** A tile: its label and the config key it shows. A sign-in method also says how the user signs in. */
interface Tile {
  label: string;
  conf: string;
  how?: string;
}
const T: Record<TileId, Tile> = {
  mail: { label: fs("Email and password", "Email"), conf: "emailAndPassword", how: "an email and a password" },
  gh: { label: "GitHub", conf: "socialProviders", how: "GitHub" },
  gg: { label: "Google", conf: "socialProviders", how: "Google" },
  pk: { label: "Passkey", conf: "passkey()", how: "a passkey" },
  tf: { label: fs("Two-factor", "2FA"), conf: "twoFactor()" },
  ml: { label: fs("Magic link", "Link"), conf: "magicLink()" },
  org: { label: fs("Organizations", "Orgs"), conf: "organization()" },
  adm: { label: "Admin", conf: "admin()" },
};
const ICON: Record<TileId, string> = { mail: icon("lucide:mail", 14), gh: icon("simple-icons:github", 13), gg: icon("simple-icons:google", 13), pk: icon("lucide:fingerprint", 14), tf: icon("lucide:shield-check", 14), ml: icon("lucide:wand-sparkles", 14), org: icon("lucide:users", 14), adm: icon("lucide:user-cog", 14) };
const RES: Record<Plugin, string> = { tf: "code ok", ml: "link sent", org: "Acme team", adm: "role: admin" };
const CHIP: Partial<Record<Plugin, string>> = { tf: "2FA", org: "Acme", adm: "admin" };
const METHODS: Method[] = ["gh", "mail", "gg", "pk"];
const PLUGINS: Plugin[] = ["tf", "ml", "org", "adm"];
const TILES: TileId[] = ["mail", "gh", "gg", "pk", "tf", "ml", "org", "adm"];

interface Times {
  go: number;
  in: number;
  open: number;
  /** Each plugin and the time it lights up, in order. */
  plug: [Plugin, number][];
  last: number;
}
type AuthPlan = TimelinePlan<{ via: Method; name: string; order: Plugin[]; A: Times }>;

const css = `.vh-hero-auth svg.icon{position:static;width:auto;height:auto}
.vh-hero-auth .icon path{stroke-dasharray:none;vector-effect:none;transition:none;fill:inherit;stroke:inherit;stroke-width:inherit}
.vh-hero-auth .icon path[fill="none"],.vh-hero-auth .icon g[fill="none"] path{fill:none;stroke:currentColor;stroke-width:2}
.vh-hero-auth .au{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px}
.vh-hero-auth .au-h{display:flex;align-items:center;gap:8px;height:20px;flex-shrink:0;padding:0 2px;font:12px var(--mono);color:var(--muted);white-space:nowrap}
.vh-hero-auth .au-h b{font-weight:500;color:var(--fg);font-family:var(--font-sans);font-size:13px}
.vh-hero-auth .au-h .r{margin-left:auto}
.vh-hero-auth .au-g{flex:1;display:grid;gap:8px;grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr));
  grid-template-areas:"mail gh page page" "gg pk page page" "tf ml org adm"}
.vh-hero-auth .tl{position:relative;display:flex;flex-direction:column;justify-content:center;gap:3px;padding:0 12px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);background:var(--bg);min-width:0;transition:background-color 300ms ease}
.vh-hero-auth .tl:before{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px var(--fg);opacity:0;transition:opacity 300ms ease}
.vh-hero-auth .tl.on:before{opacity:1}
.vh-hero-auth .tl.on{background:var(--soft)}
.vh-hero-auth .tl .lb{display:flex;align-items:center;gap:7px;font-size:13px;white-space:nowrap;color:var(--muted);transition:color 300ms ease}
.vh-hero-auth .tl .lb .icon{flex-shrink:0}
.vh-hero-auth .tl.on .lb,.vh-hero-auth .tl.used .lb{color:var(--fg)}
.vh-hero-auth .tl .sub{font:11px var(--mono);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vh-hero-auth .tl .sub>span{display:inline-block;animation:vh-fig-c 250ms var(--out)}
.vh-hero-auth .tl .sub .ok{color:var(--ok)}
.vh-hero-auth .tl .st{position:absolute;top:8px;right:9px;display:flex;color:var(--ok)}
.vh-hero-auth .sp{display:inline-block;width:10px;height:10px;border:1.5px solid var(--line);border-top-color:var(--fg);border-radius:99px;animation:vh-fig-s 700ms linear infinite}
.vh-hero-auth .pg{grid-area:page;position:relative;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);background:var(--bg);overflow:hidden}
.vh-hero-auth .pg:before{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px var(--ok);opacity:0;transition:opacity 400ms ease}
.vh-hero-auth .pg.flash:before{opacity:1}
.vh-hero-auth .pg-u{position:absolute;top:10px;left:12px;display:flex;align-items:center;gap:6px;font:12px var(--mono);color:var(--muted)}
.vh-hero-auth .pg-v{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:26px 10px 8px;text-align:center;transition:opacity 400ms var(--out),transform 400ms var(--out)}
.vh-hero-auth .pg-v.off{opacity:0;transform:translateY(6px)}
.vh-hero-auth .pg-v .lk{display:flex;color:var(--dim)}
.vh-hero-auth .pg-v .m{font-size:12px;color:var(--muted)}
.vh-hero-auth .pg-v .hi{font-size:15px;font-weight:500}
.vh-hero-auth .pg-v .via{display:flex;align-items:center;gap:5px;font:11px var(--mono);color:var(--muted)}
.vh-hero-auth .chips{display:flex;gap:5px;height:20px;margin-top:2px}
.vh-hero-auth .chip{display:flex;align-items:center;padding:0 7px;border-radius:99px;box-shadow:inset 0 0 0 1px var(--line);font:11px/20px var(--mono);color:var(--fg);white-space:nowrap}
.vh-hero-auth .chip{opacity:0;transform:scale(.85);transition:opacity 300ms var(--out),transform 300ms var(--out)}
.vh-hero-auth .chip.on{opacity:1;transform:none}
.vh-hero-auth.fading .chip,.vh-hero-auth.fading .tl .st{opacity:0;transition:opacity 400ms}
@container (max-width:640px){
  .vh-hero-auth .tl[data-id="mail"] .lb .full{display:none}.vh-hero-auth .tl[data-id="mail"] .lb .short{display:inline}
}
@container (max-width:560px){
  .vh-hero-auth .au-g{gap:6px}
  .vh-hero-auth .tl{padding:0 8px;gap:2px}
  .vh-hero-auth .tl .lb{font-size:12px;gap:5px}
  .vh-hero-auth .tl .sub{font-size:10px;opacity:0}
  .vh-hero-auth .tl .sub.res{opacity:1}
  .vh-hero-auth .tl .st{top:6px;right:6px}
  .vh-hero-auth .pg-v .hi{font-size:14px}
  .vh-hero-auth .chip{padding:0 6px;font-size:10px}
}
@container (max-width:400px){ .vh-hero-auth .tl .lb .icon{display:none} .vh-hero-auth .au-h .r .full{display:none} }`;


export default defineScene<AuthPlan>({
  css,
  key: "auth",
  name: "Auth",
  label: "One block with what Better Auth gives the app from server/auth.ts: sign-in with email and password, GitHub, Google, or a passkey, plugins for two-factor, magic links, organizations, and admin, and a protected /admin page. The page is locked. The user signs in with one method, and the page opens and greets the user. Then plugins light up one by one.",
  H: 214,
  steps: p => [
    "server/auth.ts sets up Better Auth. Pages under /admin stay locked.",
    `The user signs in with ${T[p.via].how}.`,
    "withAuth() lets the request in, and the page opens.",
    "Add Better Auth plugins, such as two-factor, in the same file.",
  ],
  summary: "server/auth.ts sets up Better Auth with sign-in methods and plugins. The user signs in, and the protected /admin page opens.",
  plan(k) {
    const r = rng(k + 601);
    const via = METHODS[k % 4] ?? "gh";
    const name = pick(r, ["Ada", "Lin", "Sam", "Noor"]);
    const order = PLUGINS.map((x): [Plugin, number] => [x, r()]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
    const go = 900 + snap(r() * 200);
    const open = go + 1100 + 300;
    const plug = order.map((id, i): [Plugin, number] => [id, open + 1600 + i * 1000]);
    const last = open + 1600 + (order.length - 1) * 1000 + 900;
    const A: Times = { go, in: go + 1100, open, plug, last };
    return TL().done(A.last + 2400, A.last, { via, name, order, A });
  },
  render(stage) {
    const tile = (id: TileId) => `<div class="tl" data-id="${id}" style="grid-area:${id}"><span class="lb">${ICON[id]}<span>${T[id].label}</span></span><span class="sub"></span><span class="st"></span></div>`;
    stage.append(h(`<div class="au">
      <div class="au-h">${icon("simple-icons:betterauth", 13)}<b>Better Auth</b><span class="r">${fs("server/", "")}auth.ts</span></div>
      <div class="au-g">${TILES.map(tile).join("")}
        <div class="pg"><span class="pg-u"></span>
          <div class="pg-v lkd"><span class="lk">${icon("lucide:lock", 26)}</span><span class="m">Sign in to see this page</span></div>
          <div class="pg-v opn"><span class="hi"></span><span class="via"></span><span class="chips"></span></div>
        </div></div>
    </div>`));
    const $ = (s: string) => q(stage, s);
    const tiles = qa(stage, ".tl").map((el, i) => ({ el, id: TILES[i] ?? "mail", sub: q(el, ".sub"), st: q(el, ".st") }));
    const pg = $(".pg"), url = $(".pg-u"), lkd = $(".lkd"), opn = $(".opn"), hi = $(".hi"), via = $(".via");
    const chips = $(".chips");
    return (t, p) => {
      const A = p.A, open = t >= A.open;
      for (const { el, id, sub, st } of tiles) {
        const pl = A.plug.find(x => x[0] === id);
        if (id === p.via) {
          cls(el, "on", t >= A.go && t < A.in + 500); cls(el, "used", t >= A.go);
          put(st, t >= A.in ? icon("lucide:check", 13) : t >= A.go ? `<i class="sp"></i>` : "");
          put(sub, T[id].conf); cls(sub, "res", false);
        } else if (pl) {
          const [plugin, at] = pl;
          cls(el, "on", t >= at && t < at + 900); cls(el, "used", t >= at);
          put(st, t >= at + 500 ? icon("lucide:check", 13) : t >= at ? `<i class="sp"></i>` : "");
          put(sub, t >= at + 500 ? `<span class="ok">${RES[plugin]}</span>` : T[id].conf); cls(sub, "res", t >= at + 500);
        } else {
          cls(el, "on", false); cls(el, "used", false); put(st, ""); put(sub, T[id].conf); cls(sub, "res", false);
        }
      }
      put(url, `${icon(open ? "lucide:lock-open" : "lucide:lock", 12)}/admin`);
      cls(lkd, "off", open); cls(opn, "off", !open);
      cls(pg, "flash", open && t < A.open + 1200);
      put(hi, `Hello, ${p.name}`);
      put(via, `${ICON[p.via]}${p.name.toLowerCase()}@acme.dev`);
      // Each plugin with something to show on the page adds a chip, in the order it lights up.
      const mine = A.plug.filter(([id]) => CHIP[id]);
      put(chips, mine.map(([id]) => `<span class="chip">${CHIP[id]}</span>`).join(""));
      const els = qa(chips, ".chip");
      mine.forEach(([, at], i) => {
        const el = els[i];
        if (el) cls(el, "on", t >= at + 500);
      });
      const first = A.plug[0]?.[1] ?? A.last;
      return t < A.go ? 0 : t < A.open ? 1 : t < first ? 2 : 3;
    };
  },
});
