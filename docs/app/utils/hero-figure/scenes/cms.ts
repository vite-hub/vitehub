// CMS: the Console editor beside the site preview. An editor changes a published post. Each save keeps a draft in
// the history. Publish updates the site, or (with publish: 'pr') opens a pull request that updates the site when it
// merges. The loop alternates between the two.
import { defineScene, clamp, snap, rng, pick, fs, icon, h, q, qa, cls, put } from "../engine";

interface Post {
  title: string;
  slug: string;
  site: string;
  body: string;
  /** The text the editor adds, in two bursts of typing. */
  add: [string, string];
}
const POSTS: [Post, Post, Post] = [
  { title: "Autumn rides", slug: "autumn-rides", site: "Eastside Cycling Club", body: "We ride every Saturday in November.", add: ["Meet at the north end of the bridge", ", and bring lights."] },
  { title: "Spring menu", slug: "spring-menu", site: "Café Lindo", body: "The new menu starts on Monday.", add: ["We added two vegan dishes", " and a lemon tart."] },
  { title: "Office hours", slug: "office-hours", site: "Northgate Library", body: "The help desk is open from 9 to 5.", add: ["On Fridays we close at 3", ", starting next week."] },
];

interface CmsPlan {
  len: number;
  end: number;
  post: Post;
  pr: boolean;
  num: number;
  a1: number;
  b1: number;
  s1: number;
  a2: number;
  b2: number;
  s2: number;
  press: number;
  pub: number;
  merge: number;
  live: number;
  done: number;
}

const css = `.vh-hero-cms svg.icon{position:static;inset:auto;width:auto;height:auto}.vh-hero-cms svg.icon path{fill:inherit;stroke:inherit;stroke-width:inherit;stroke-dasharray:none;vector-effect:none}
.vh-hero-cms .m-win{position:absolute;inset:0;display:grid;grid-template-columns:40px 1fr 1fr;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.vh-hero-cms .m-rail{display:flex;flex-direction:column;align-items:center;gap:12px;padding:12px 0;box-shadow:inset -1px 0 0 var(--line);color:var(--dim)}
.vh-hero-cms .m-rail .on{color:var(--fg)}
.vh-hero-cms .m-mark{width:14px;height:14px;border-radius:4px;background:var(--fg);margin-bottom:4px}
.vh-hero-cms .m-ed,.vh-hero-cms .m-pv{position:relative;display:flex;flex-direction:column;min-width:0}
.vh-hero-cms .m-pv{box-shadow:inset 1px 0 0 var(--line);background:var(--soft)}
.vh-hero-cms .m-bar{height:40px;flex-shrink:0;display:flex;align-items:center;gap:8px;padding:0 10px 0 14px;box-shadow:inset 0 -1px 0 var(--line);font-size:13px;white-space:nowrap}
.vh-hero-cms .m-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;min-width:0}
.vh-hero-cms .m-st{display:inline-flex;align-items:center;gap:6px;font:11px var(--mono);color:var(--muted);transition:color 300ms ease}
.vh-hero-cms .m-st>span{display:inline-block;animation:vh-fig-c 250ms var(--out)}
.vh-hero-cms .m-dot{width:6px;height:6px;border-radius:99px;background:var(--dim);transition:background-color 300ms ease}
.vh-hero-cms .m-st.ok{color:var(--ok)}.vh-hero-cms .m-st.ok .m-dot{background:var(--ok)}
.vh-hero-cms .m-st.warn{color:var(--warn)}.vh-hero-cms .m-st.warn .m-dot{background:var(--warn)}
.vh-hero-cms .m-st.fg{color:var(--fg)}.vh-hero-cms .m-st.fg .m-dot{background:var(--fg)}
.vh-hero-cms .m-pub{margin-left:auto;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:7px;background:var(--fg);color:var(--bg);font-size:12px;font-weight:500;opacity:0;transform:scale(.96);transition:opacity 250ms ease,transform 160ms var(--out)}
.vh-hero-cms .m-pub.on{opacity:1;transform:none}.vh-hero-cms .m-pub.press{transform:scale(.94)}
.vh-hero-cms .m-pub .spin{display:none}.vh-hero-cms .m-pub.busy .spin{display:inline-block}
.vh-hero-cms .m-page{flex:1;padding:14px 16px 0;overflow:hidden}
.vh-hero-cms .m-title{font-size:17px;font-weight:600;letter-spacing:-.01em}
.vh-hero-cms .m-meta{margin:6px 0 10px;font:11px var(--mono);color:var(--dim)}
.vh-hero-cms .m-body{font-size:13px;line-height:1.55;color:var(--muted);margin:0}
.vh-hero-cms .m-new{color:var(--fg)}
.vh-hero-cms .m-caret{display:inline-block;width:1px;height:14px;margin-left:1px;vertical-align:-2px;background:var(--fg);opacity:0}
.vh-hero-cms .m-caret.on{opacity:1}
.vh-hero-cms .m-hist{height:34px;flex-shrink:0;display:flex;align-items:center;gap:7px;padding:0 16px;font:11px var(--mono);color:var(--dim)}
.vh-hero-cms .m-v{width:7px;height:7px;border-radius:99px;background:var(--dim);transform:scale(0);transition:transform 450ms cubic-bezier(.34,1.56,.64,1),background-color 300ms ease,box-shadow 300ms ease}
.vh-hero-cms .m-v.on{transform:none}
.vh-hero-cms .m-v.ok{background:var(--ok);box-shadow:0 0 0 3px color-mix(in oklab,var(--ok) 18%,transparent)}
.vh-hero-cms .m-v.cur{background:var(--fg)}
.vh-hero-cms .m-addr{display:flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:99px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);font:11px var(--mono);color:var(--muted);min-width:0;overflow:hidden}
.vh-hero-cms .m-addr b{font-weight:400;color:var(--ok)}
.vh-hero-cms .m-rl{color:var(--dim);display:inline-flex}
.vh-hero-cms .m-rl.spin2 svg{animation:vh-fig-s 600ms linear infinite}
.vh-hero-cms .m-site{flex:1;margin:12px 12px 0;padding:14px 14px 0;border-radius:8px 8px 0 0;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.vh-hero-cms .m-sn{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:12px}
.vh-hero-cms .m-sn b{font-weight:500;color:var(--fg)}
.vh-hero-cms .m-stitle{font-size:16px;font-weight:600;margin:0 0 6px}
.vh-hero-cms .m-sbody{font-size:12.5px;line-height:1.55;color:var(--muted);margin:0}
.vh-hero-cms .m-snew{display:inline;color:var(--fg);border-radius:3px;transition:background-color 900ms ease,opacity 400ms ease}
.vh-hero-cms .m-snew.hide{opacity:0}
.vh-hero-cms .m-snew.flash{background:color-mix(in oklab,var(--ok) 20%,transparent)}
.vh-hero-cms .m-pr{position:absolute;left:12px;right:12px;bottom:12px;display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:9px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);font-size:12px;white-space:nowrap;opacity:0;transform:translateY(8px);transition:opacity 300ms ease,transform 400ms var(--out),box-shadow 300ms ease}
.vh-hero-cms .m-pr.on{opacity:1;transform:none}
.vh-hero-cms .m-pr.ok{box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--ok) 50%,transparent)}
.vh-hero-cms .m-prt{overflow:hidden;text-overflow:ellipsis;min-width:0}
.vh-hero-cms .m-prt i{font-style:normal;color:var(--muted)}
.vh-hero-cms .m-prs{margin-left:auto;display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:99px;font:11px var(--mono);color:var(--warn);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--warn) 45%,transparent);transition:color 300ms,box-shadow 300ms}
.vh-hero-cms .m-pr.ok .m-prs{color:var(--ok);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--ok) 45%,transparent)}
@container (max-width:640px){
 .vh-hero-cms .m-bar{position:relative}
 .vh-hero-cms .m-pub{position:absolute;right:10px;top:7px}
 .vh-hero-cms .m-pr{left:8px;right:8px;padding:8px 9px;gap:6px}
 .vh-hero-cms .m-prs{padding:2px 6px}
}
@container (max-width:560px){
 .vh-hero-cms .m-pub{right:8px}
 .vh-hero-cms .m-win{grid-template-columns:1fr 1fr}
 .vh-hero-cms .m-rail,.vh-hero-cms .m-name,.vh-hero-cms .m-meta{display:none}
 .vh-hero-cms .m-bar{padding:0 8px;gap:6px}
 .vh-hero-cms .m-page{padding:10px 10px 0}
 .vh-hero-cms .m-title{font-size:14px;margin-bottom:6px}
 .vh-hero-cms .m-body{font-size:11.5px}
 .vh-hero-cms .m-hist{padding:0 10px}
 .vh-hero-cms .m-pub{padding:0 8px;font-size:11px}
 .vh-hero-cms .m-site{margin:8px 8px 0;padding:10px 10px 0}
 .vh-hero-cms .m-sn{display:none}
 .vh-hero-cms .m-stitle{font-size:14px}.vh-hero-cms .m-sbody{font-size:11.5px}
 .vh-hero-cms .m-pr{left:8px;right:8px;bottom:8px;padding:7px 8px;gap:6px}
 .vh-hero-cms .m-addr{padding:0 8px}
}`;


export default defineScene<CmsPlan>({
  css,
  key: "cms",
  name: "CMS",
  label: "The Console editor sits beside a preview of the site. An editor adds a sentence to a published post. Each save keeps a draft, and the history shows one dot for each version. The editor clicks Publish. The site shows the new sentence, or, with publish set to pr, a pull request opens and the site shows the new sentence when it merges.",
  H: 240,
  steps: p => [
    "An editor changes a published post in the Console. The site still shows the published version.",
    "Each save keeps a draft. Every version stays in the history.",
    p.pr ? "With publish: 'pr', Publish opens a pull request into main. The post stays pending." : "The editor clicks Publish. The draft becomes the published version.",
    p.pr ? "The pull request merges, and the site shows the new version." : "The site shows the new version. The drafts stay in the history.",
  ],
  summary: "An editor changes a post in the Console. Each save keeps a draft, and Publish updates the site or opens a pull request.",
  plan(k) {
    const r = rng(k + 2203);
    const post = POSTS[k % POSTS.length] ?? POSTS[0], pr = k % 2 === 1, num = pick(r, [212, 214, 219, 231]);
    const j = () => snap(r() * 300);
    const a1 = 900, b1 = a1 + 1700 + j(), s1 = b1 + 600;
    const a2 = s1 + 700, b2 = a2 + 1200 + j(), s2 = b2 + 600;
    const press = s2 + 1100, pub = press + 900;
    const merge = pr ? pub + 2600 + j() : pub;
    const live = merge + 400, done = live + 1500;
    return { len: done + 2400, end: done + 1000, post, pr, num, a1, b1, s1, a2, b2, s2, press, pub, merge, live, done };
  },
  frame: () => ({ tok: {} }), // the lane checker reads it; the stage draws through render
  render(stage) {
    const root = h(`<div class="m-win">
      <div class="m-rail"><span class="m-mark"></span><span class="on">${icon("lucide:newspaper", 15)}</span><span>${icon("lucide:database", 15)}</span><span>${icon("lucide:settings", 15)}</span></div>
      <div class="m-ed">
        <div class="m-bar"><span class="m-name"></span><span class="m-st"><i class="m-dot"></i><span></span></span><span class="m-pub">Publish<span class="spin"></span></span></div>
        <div class="m-page"><div class="m-title"></div><div class="m-meta">posts/<span class="m-slug"></span>.md</div><p class="m-body"><span class="m-old"></span> <span class="m-new"></span></p></div>
        <div class="m-hist">history <span class="m-v"></span><span class="m-v"></span><span class="m-v"></span></div>
      </div>
      <div class="m-pv">
        <div class="m-bar"><span class="m-rl">${icon("lucide:rotate-cw", 13)}</span><span class="m-addr">${icon("lucide:globe", 12)}<span class="m-url"></span></span></div>
        <div class="m-site"><div class="m-sn"><b class="m-sname"></b><span>Posts · About</span></div><p class="m-stitle"></p><p class="m-sbody"><span class="m-sold"></span> <span class="m-snew"></span></p></div>
        <div class="m-pr">${icon("simple-icons:github", 14)}<span class="m-prt"></span><span class="m-prs"></span></div>
      </div>
    </div>`);
    stage.append(root);
    const $ = (s: string) => q(root, s);
    const st = $(".m-st"), stl = $(".m-st span"), pubBtn = $(".m-pub"), vs = qa(root, ".m-v");
    const nw = $(".m-new"), snew = $(".m-snew"), rl = $(".m-rl"), pr = $(".m-pr"), prt = $(".m-prt"), prs = $(".m-prs");
    const name = $(".m-name"), title = $(".m-title"), slug = $(".m-slug"), old = $(".m-old");
    const sname = $(".m-sname"), stitle = $(".m-stitle"), sold = $(".m-sold"), url = $(".m-url");
    return (t, p, still) => {
      root.style.opacity = still ? "1" : (1 - clamp((t - (p.len - 500)) / 500)).toFixed(3);
      const P = p.post;
      put(name, P.title); put(title, P.title); put(slug, P.slug); put(old, P.body);
      put(sname, P.site); put(stitle, P.title); put(sold, P.body);
      put(url, fs(`/posts/${P.slug}`, `/${P.slug}`));
      // Typing in two bursts.
      const n1 = P.add[0].length, n2 = P.add[1].length;
      const typed = Math.round(clamp((t - p.a1) / (p.b1 - p.a1)) * n1) + Math.round(clamp((t - p.a2) / (p.b2 - p.a2)) * n2);
      const text = (P.add[0] + P.add[1]).slice(0, typed);
      const typing = (t >= p.a1 && t < p.b1 + 300) || (t >= p.a2 && t < p.b2 + 300);
      put(nw, `${text}<span class="m-caret ${typing || (t >= p.a1 && t < p.press) ? "on" : ""}"></span>`);
      // Status in the editor bar: its text and its tone.
      let s: [string, string] = ["Published", "ok"];
      if (t >= p.a1) s = ["Editing", "fg"];
      if (t >= p.s1 && t < p.a2) s = ["Draft saved", ""];
      if (t >= p.a2) s = ["Editing", "fg"];
      if (t >= p.s2) s = ["Draft saved", ""];
      if (t >= p.press) s = ["Publishing", "fg"];
      if (t >= p.pub && p.pr) s = [fs(`Pending · #${p.num}`, `#${p.num}`), "warn"];
      if (t >= p.live) s = ["Published", "ok"];
      put(stl, s[0]);
      for (const c of ["ok", "warn", "fg"]) cls(st, c, s[1] === c);
      cls(pubBtn, "on", t >= p.s1 && t < p.pub + 300);
      cls(pubBtn, "press", t >= p.press && t < p.press + 160);
      cls(pubBtn, "busy", t >= p.press && t < p.pub);
      // One dot per version: the published one, then each saved draft. The live one turns green.
      const saved = [0, p.s1, p.s2];
      vs.forEach((v, i) => {
        const at = saved[i] ?? Infinity;
        cls(v, "on", t >= at);
        const live = t >= p.live ? i === 2 : i === 0;
        cls(v, "ok", live);
        cls(v, "cur", !live && t >= at && i === (t >= p.s2 ? 2 : 1) && t < p.live);
      });
      // The pull request.
      cls(pr, "on", p.pr && t >= p.pub && t < p.done + 600);
      cls(pr, "ok", t >= p.merge);
      put(prt, `<i>#${p.num}</i> ${fs(`Publish ${P.slug}`, "")}`);
      put(prs, t >= p.merge ? `${icon("lucide:git-merge", 11)}merged` : `${icon("lucide:git-pull-request", 11)}open`);
      // The site.
      cls(rl, "spin2", t >= p.live - 400 && t < p.live);
      put(snew, P.add[0] + P.add[1]);
      cls(snew, "hide", t < p.live);
      cls(snew, "flash", t >= p.live && t < p.live + 1200);
      if (t >= p.merge + (p.pr ? 0 : 1e9) || t >= p.live + 900) return 3;
      if (t >= p.press) return 2;
      if (t >= p.s1) return 1;
      return 0;
    };
  },
});
