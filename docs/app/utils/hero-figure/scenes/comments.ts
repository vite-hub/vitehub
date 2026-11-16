// Comments: a preview of a pull request. A tester clicks the page and a pin drops. The comment opens a thread, a
// teammate replies, and the tester resolves it. Each step also shows on the preview's pull request.
import { defineScene, clamp, lerp, snap, rng, pick, fs, icon, h, prog, q, qa, cls, put, type Point } from "../engine";

interface Thread {
  /** The `data-t` of the page element that gets the pin. */
  tgt: string;
  text: string;
  reply: string;
}
const THREADS: [Thread, Thread, Thread] = [
  { tgt: "price", text: "Team costs $24 now, not $29.", reply: "Fixed in the next commit." },
  { tgt: "head", text: "Can we call this page Plans?", reply: "Yes, renamed it in this branch." },
  { tgt: "cta", text: "This button has no link yet.", reply: "Fixed, it opens the contact form." },
];
const PEOPLE: [string, string][] = [["Ada", "Sam"], ["Lea", "Kai"], ["Mia", "Tom"]];
const POINTER = `<svg class="c-cur" viewBox="0 0 16 20" aria-hidden="true"><path d="M1 1v15l4-3.5 2.6 6 2.6-1.1-2.6-5.9H13z"/></svg>`;

interface CommentsPlan {
  len: number;
  end: number;
  th: Thread;
  a: string;
  b: string;
  num: number;
  click: number;
  open: number;
  type0: number;
  type1: number;
  post: number;
  gh1: number;
  think: number;
  reply: number;
  gh2: number;
  move: number;
  rclick: number;
  res: number;
  ghres: number;
}

const css = `.vh-hero-comments svg.icon{position:static;inset:auto;width:auto;height:auto}.vh-hero-comments svg.icon path{fill:inherit;stroke:inherit;stroke-width:inherit;stroke-dasharray:none;vector-effect:none}
.vh-hero-comments .c-root{position:absolute;inset:0}
.vh-hero-comments .c-win{position:absolute;left:0;top:0;bottom:0;width:62%;display:flex;flex-direction:column;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.vh-hero-comments .c-bar{height:34px;flex-shrink:0;display:flex;align-items:center;gap:10px;padding:0 12px;box-shadow:inset 0 -1px 0 var(--line);background:var(--soft)}
.vh-hero-comments .c-lights{display:flex;gap:5px}.vh-hero-comments .c-lights i{width:8px;height:8px;border-radius:99px;box-shadow:inset 0 0 0 1px var(--line);background:var(--bg)}
.vh-hero-comments .c-url{flex:1;min-width:0;height:22px;display:flex;align-items:center;gap:6px;padding:0 10px;border-radius:99px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);font:11px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden}
.vh-hero-comments .c-page{position:relative;flex:1;padding:16px 18px}
.vh-hero-comments .c-h{display:inline-block;font-size:18px;font-weight:600;letter-spacing:-.01em}
.vh-hero-comments .c-sub{margin:2px 0 14px;font-size:12.5px;color:var(--muted)}
.vh-hero-comments .c-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.vh-hero-comments .c-card{padding:10px 11px;border-radius:9px;box-shadow:inset 0 0 0 1px var(--line);font-size:12px;color:var(--muted)}
.vh-hero-comments .c-card b{display:block;font-weight:500;color:var(--fg)}
.vh-hero-comments .c-price{display:inline-block;margin:4px 0 6px;font-size:17px;font-weight:600;color:var(--fg);font-variant-numeric:tabular-nums}
.vh-hero-comments .c-price small{font-size:11px;font-weight:400;color:var(--muted)}
.vh-hero-comments .c-cta{display:inline-block;margin-top:8px;padding:3px 8px;border-radius:6px;box-shadow:inset 0 0 0 1px var(--line);font-size:11px;color:var(--fg)}
.vh-hero-comments .c-tgt{border-radius:5px;transition:box-shadow 250ms ease}
.vh-hero-comments .c-tgt.hl{box-shadow:0 0 0 2px color-mix(in oklab,var(--fg) 22%,transparent)}
.vh-hero-comments .c-ov{position:absolute;inset:0;pointer-events:none}
.vh-hero-comments .c-pin{position:absolute;z-index:2;left:0;top:0;width:22px;height:22px;margin:-22px 0 0 0;border-radius:11px 11px 11px 2px;background:var(--fg);color:var(--bg);display:flex;align-items:center;justify-content:center;font:600 11px Geist,sans-serif;transform:scale(0);transform-origin:0 100%;transition:transform 420ms cubic-bezier(.34,1.56,.64,1),background-color 300ms ease}
.vh-hero-comments .c-pin.on{transform:scale(1)}.vh-hero-comments .c-pin.ok{background:var(--ok)}
.vh-hero-comments .c-ring{position:absolute;left:0;top:0;width:24px;height:24px;margin:-12px;border-radius:99px;box-shadow:0 0 0 1.5px var(--fg);opacity:0}
.vh-hero-comments .c-bub{position:absolute;left:0;top:0;width:208px;padding:10px;border-radius:10px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line),0 6px 20px -8px color-mix(in oklab,var(--fg) 25%,transparent);opacity:0;transform:scale(.92);transition:opacity 220ms ease,transform 380ms var(--out)}
.vh-hero-comments .c-bub.on{opacity:1;transform:none}
.vh-hero-comments .c-msg{display:grid;grid-template-columns:20px 1fr;gap:7px;font-size:12px;line-height:1.4;opacity:0;transform:translateY(4px);transition:opacity 250ms ease,transform 300ms var(--out)}
.vh-hero-comments .c-msg.on{opacity:1;transform:none}
.vh-hero-comments .c-m2w{display:grid;grid-template-rows:0fr;transition:grid-template-rows 380ms var(--out)}.vh-hero-comments .c-m2w.on{grid-template-rows:1fr}.vh-hero-comments .c-m2w>.c-msg{overflow:hidden;min-height:0}.vh-hero-comments .c-m2{padding-top:9px}
.vh-hero-comments .c-av{width:20px;height:20px;border-radius:99px;display:flex;align-items:center;justify-content:center;font:600 10px Geist,sans-serif;background:var(--fg);color:var(--bg)}
.vh-hero-comments .c-av.b{background:var(--soft);color:var(--fg);box-shadow:inset 0 0 0 1px var(--line)}
.vh-hero-comments .c-who{font-weight:500}.vh-hero-comments .c-who i{font-style:normal;font-weight:400;color:var(--dim);margin-left:4px;font-size:11px}
.vh-hero-comments .c-txt{color:var(--fg);min-height:17px}
.vh-hero-comments .c-dots{display:inline-flex;gap:3px;padding:6px 0}.vh-hero-comments .c-dots i{width:4px;height:4px;border-radius:99px;background:var(--dim);animation:cmtb 900ms ease-in-out infinite}
.vh-hero-comments .c-dots i:nth-child(2){animation-delay:150ms}.vh-hero-comments .c-dots i:nth-child(3){animation-delay:300ms}
@keyframes cmtb{50%{opacity:.25}}
.vh-hero-comments .c-caret{display:inline-block;width:1px;height:13px;margin-left:1px;vertical-align:-2px;background:var(--fg)}
.vh-hero-comments .c-foot{display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:8px;box-shadow:inset 0 1px 0 var(--soft);font:11px var(--mono);color:var(--dim)}
.vh-hero-comments .c-foot>span{display:inline-flex;align-items:center;gap:5px;transition:color 300ms ease}
.vh-hero-comments .c-foot>span.ok{color:var(--muted)}
.vh-hero-comments .c-res{padding:3px 8px;border-radius:6px;box-shadow:inset 0 0 0 1px var(--line);color:var(--fg);font:500 11px Geist,sans-serif;transition:transform 150ms var(--out),background-color 250ms,color 250ms}
.vh-hero-comments .c-res.press{transform:scale(.94)}.vh-hero-comments .c-res.ok{background:var(--ok);color:var(--bg);box-shadow:none}
.vh-hero-comments .c-cur{position:absolute;left:0;top:0;width:16px;height:20px;color:var(--fg);z-index:3;will-change:transform}
.vh-hero-comments .c-cur path{fill:var(--fg);stroke:var(--bg);stroke-width:1.2;stroke-dasharray:none;vector-effect:none}
.vh-hero-comments .c-gh{position:absolute;right:0;top:0;bottom:0;width:34%;display:flex;flex-direction:column;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.vh-hero-comments .c-ghh{padding:10px 12px;box-shadow:inset 0 -1px 0 var(--line);font-size:12.5px;font-weight:500;display:flex;align-items:center;gap:7px;white-space:nowrap;overflow:hidden}
.vh-hero-comments .c-ghh i{font-style:normal;font-weight:400;color:var(--muted)}
.vh-hero-comments .c-ghs{padding:7px 12px 0;font:11px var(--mono);color:var(--dim)}
.vh-hero-comments .c-list{flex:1;padding:8px 10px;display:flex;flex-direction:column;gap:7px}
.vh-hero-comments .c-it{padding:8px 9px;border-radius:8px;box-shadow:inset 0 0 0 1px var(--line);font-size:11.5px;line-height:1.4;opacity:0;transform:translateY(6px);transition:opacity 300ms ease,transform 400ms var(--out),box-shadow 300ms ease}
.vh-hero-comments .c-it.on{opacity:1;transform:none}
.vh-hero-comments .c-it.res{box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--ok) 45%,transparent)}
.vh-hero-comments .c-ith{display:flex;align-items:center;gap:6px;color:var(--muted);white-space:nowrap;overflow:hidden}
.vh-hero-comments .c-ith .c-av{width:16px;height:16px;font-size:9px;flex-shrink:0}
.vh-hero-comments .c-ith b{font-weight:500;color:var(--fg)}
.vh-hero-comments .c-itt{margin-top:4px;color:var(--fg);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.vh-hero-comments .c-dep .c-itt{font:11px var(--mono);color:var(--muted)}
.vh-hero-comments .c-itt.res{color:var(--ok);font:11px var(--mono)}
@container (max-width:640px){
 .vh-hero-comments .c-bub{width:178px}
 .vh-hero-comments .c-foot{gap:6px;white-space:nowrap;font-size:10.5px}.vh-hero-comments .c-res{padding:3px 7px}.vh-hero-comments .c-pn .to{display:none}
 .vh-hero-comments .c-gw .full{display:none}.vh-hero-comments .c-gw .short{display:inline}
}
@container (max-width:560px){
 .vh-hero-comments .c-win{width:100%}
 .vh-hero-comments .c-gh{display:none}
 .vh-hero-comments .c-lights{display:none}
 .vh-hero-comments .c-page{padding:12px}
 .vh-hero-comments .c-cards{gap:6px}
 .vh-hero-comments .c-card{padding:8px}
 .vh-hero-comments .c-price{font-size:14px}
 .vh-hero-comments .c-sub{margin-bottom:10px}
 .vh-hero-comments .c-bub{width:178px}
}`;


export default defineScene<CommentsPlan>({
  css,
  key: "comments",
  name: "Comments",
  label: "A tester opens a preview of a pull request. They click an element of the page, and a pin drops there. They write a comment, and a teammate replies. They resolve the thread, and the pin turns green. Each comment, the reply, and the resolve also show on the pull request.",
  H: 260,
  steps: p => [
    `${p.a} opens the preview and clicks the page. A pin drops on that element.`,
    "The comment opens a thread. Comments posts it to the preview's pull request.",
    `${p.b} replies. The reply shows on the page and on the pull request.`,
    `${p.a} resolves the thread. The pin turns green, and the pull request hides the comment as resolved.`,
  ],
  summary: "A pin on the page holds a thread with a comment and a reply. The thread is resolved, and the pull request shows the same thread.",
  plan(k) {
    const r = rng(k + 5303);
    const th = THREADS[k % THREADS.length] ?? THREADS[0], [a, b] = pick(r, PEOPLE), num = pick(r, [214, 218, 226, 231]);
    const j = () => snap(r() * 300);
    const click = 1700 + j(), open = click + 350, type0 = open + 400, type1 = type0 + 1500, post = type1 + 300;
    const gh1 = post + 600, think = gh1 + 700 + j(), reply = think + 1300, gh2 = reply + 600;
    const move = gh2 + 500, rclick = move + 1100, res = rclick + 250, ghres = res + 600;
    return { len: ghres + 3000, end: ghres + 1500, th, a, b, num, click, open, type0, type1, post, gh1, think, reply, gh2, move, rclick, res, ghres };
  },
  frame: () => ({ tok: {} }), // the lane checker reads it; the stage draws through render
  render(stage) {
    const root = h(`<div class="c-root">
      <div class="c-win">
        <div class="c-bar"><span class="c-lights"><i></i><i></i><i></i></span><span class="c-url">${icon("lucide:lock", 11)}<span class="c-host"></span></span></div>
        <div class="c-page">
          <div class="c-h c-tgt" data-t="head">Pricing</div>
          <div class="c-sub">One plan for each team size.</div>
          <div class="c-cards">
            <div class="c-card"><b>Starter</b><span class="c-price">$9<small>/mo</small></span><br>1 project</div>
            <div class="c-card"><b>Team</b><span class="c-price c-tgt" data-t="price">$29<small>/mo</small></span><br>10 projects</div>
            <div class="c-card"><b>Business</b><span class="c-price">$99<small>/mo</small></span><br><span class="c-cta c-tgt" data-t="cta">Contact us</span></div>
          </div>
          <div class="c-ov">
            <span class="c-ring"></span>
            <span class="c-pin">1</span>
            <div class="c-bub">
              <div class="c-msg c-m1"><span class="c-av"></span><div><div class="c-who"></div><div class="c-txt"></div></div></div>
              <div class="c-m2w"><div class="c-msg c-m2"><span class="c-av b"></span><div><div class="c-who"></div><div class="c-txt"></div></div></div></div>
              <div class="c-foot"><span class="c-posted">${icon("simple-icons:github", 11)}<span class="c-pn"></span></span><span class="c-res">Resolve</span></div>
            </div>
            ${POINTER}
          </div>
        </div>
      </div>
      <div class="c-gh">
        <div class="c-ghh">${icon("simple-icons:github", 14)}<span class="c-ght"></span></div>
        <div class="c-ghs">Conversation</div>
        <div class="c-list">
          <div class="c-it on c-dep"><div class="c-ith">${icon("lucide:rocket", 13)}<span>Preview deployed</span></div><div class="c-itt c-dpu"></div></div>
          <div class="c-it c-g1"><div class="c-ith"><span class="c-av"></span><span class="c-gw"></span></div><div class="c-itt"></div></div>
          <div class="c-it c-g2"><div class="c-ith"><span class="c-av b"></span><span class="c-gw"></span></div><div class="c-itt"></div></div>
        </div>
      </div>
    </div>`);
    stage.append(root);
    const $ = (s: string) => q(root, s);
    const page = $(".c-page"), pin = $(".c-pin"), ring = $(".c-ring"), bub = $(".c-bub"), cur = q<SVGSVGElement>(root, ".c-cur");
    const m1 = $(".c-m1"), m2 = $(".c-m2"), m2w = $(".c-m2w"), res = $(".c-res"), posted = $(".c-posted"), g1 = $(".c-g1"), g2 = $(".c-g2");
    const host = $(".c-host"), ght = $(".c-ght"), pn = $(".c-pn"), dpu = $(".c-dpu");
    const tgts = qa(root, ".c-tgt");
    // Offset of an element inside the page, without transforms.
    const off = (from: HTMLElement): Point => {
      let x = 0, y = 0;
      let el: Element | null = from;
      while (el instanceof HTMLElement && el !== page) {
        x += el.offsetLeft; y += el.offsetTop;
        el = el.offsetParent;
      }
      return [x, y];
    };
    return (t, p, still) => {
      root.style.opacity = still ? "1" : (1 - clamp((t - (p.len - 500)) / 500)).toFixed(3);
      put(host, fs(`pr-${p.num}.shop-preview.dev/pricing`, `pr-${p.num}…/pricing`));
      put(ght, `<i>#${p.num}</i> Update pricing page`);
      const W = page.clientWidth, H = page.clientHeight;
      const tgt = q(root, `.c-tgt[data-t="${p.th.tgt}"]`);
      tgts.forEach(e => cls(e, "hl", e === tgt && t >= p.click - 500 && t < p.open + 300));
      const [tx, ty] = off(tgt), pt: Point = [W < 400 ? tx - 3 : tx + tgt.offsetWidth + 3, ty + tgt.offsetHeight * 0.4];
      // The pin and its thread.
      pin.style.transform = "";
      pin.style.left = `${pt[0].toFixed(1)}px`; pin.style.top = `${pt[1].toFixed(1)}px`;
      cls(pin, "on", t >= p.click);
      cls(pin, "ok", t >= p.res);
      put(pin, t >= p.res ? icon("lucide:check", 12) : "1");
      const rp = clamp((t - p.click) / 500);
      ring.style.transform = `translate(${pt[0].toFixed(1)}px,${pt[1].toFixed(1)}px) scale(${(0.4 + rp * 1.2).toFixed(3)})`;
      ring.style.opacity = t >= p.click && rp < 1 ? (1 - rp).toFixed(3) : "0";
      cls(bub, "on", t >= p.open && t < p.res + 500);
      cls(m1, "on", t >= p.open);
      put(q(m1, ".c-av"), p.a.charAt(0));
      put(q(m1, ".c-who"), `${p.a}<i>${t >= p.post ? "now" : ""}</i>`);
      const n = Math.round(clamp((t - p.type0) / (p.type1 - p.type0)) * p.th.text.length);
      put(q(m1, ".c-txt"), t >= p.post ? p.th.text : `${p.th.text.slice(0, n)}<span class="c-caret"></span>`);
      cls(m2, "on", t >= p.think); cls(m2w, "on", t >= p.think);
      put(q(m2, ".c-av"), p.b.charAt(0));
      put(q(m2, ".c-who"), p.b);
      put(q(m2, ".c-txt"), t >= p.reply ? p.th.reply : `<span class="c-dots"><i></i><i></i><i></i></span>`);
      const bw = bub.offsetWidth, bh = bub.offsetHeight - m2w.offsetHeight + m2.scrollHeight;
      const right = pt[0] + 34 + bw < W - 6, left = pt[0] - bw - 14 > 6;
      const bx = right ? pt[0] + 30 : left ? pt[0] - bw - 14 : clamp(pt[0] - bw / 2, 6, W - bw - 6);
      const by = right || left ? clamp(pt[1] - 16, 6, Math.max(6, H - bh - 10)) : clamp(pt[1] + 8, 6, H - bh - 8);
      bub.style.left = `${bx.toFixed(1)}px`; bub.style.top = `${by.toFixed(1)}px`;
      bub.style.transformOrigin = right ? "0 0" : left ? "100% 0" : "50% 0";
      cls(posted, "ok", t >= p.gh1);
      put(pn, t >= p.gh1 ? fs(`posted <span class="to">to </span>#${p.num}`, `#${p.num}`) : t >= p.post ? "posting…" : "draft");
      cls(res, "press", t >= p.rclick && t < p.rclick + 150);
      cls(res, "ok", t >= p.res);
      put(res, t >= p.res ? "Resolved" : "Resolve");
      // The cursor: in from the corner, to the element, aside while they talk, then to Resolve.
      const [rx, ry] = off(res), rpos: Point = [rx + res.offsetWidth * 0.5, ry + res.offsetHeight * 0.6];
      const rest: Point = [right ? Math.min(W - 24, bx + bw + 10) : Math.max(10, bx - 30), by + 28];
      const start: Point = [W + 20, H + 10], gone: Point = [W + 20, rpos[1] + 30];
      const P: [number, Point][] = [[0, start], [p.click - 1100, start], [p.click - 100, pt], [p.post + 200, pt], [p.post + 900, rest], [p.move, rest], [p.rclick - 100, rpos], [p.ghres + 400, rpos], [p.ghres + 1600, gone]];
      const k = P.findIndex(([at], i) => i > 0 && t < at);
      const from = P[k - 1], to = P[k];
      let c = gone;
      if (from && to) {
        const u = prog(t, from[0], to[0]);
        c = [lerp(from[1][0], to[1][0], u), lerp(from[1][1], to[1][1], u)];
      }
      cur.style.transform = `translate(${(c[0] - 1).toFixed(1)}px,${(c[1] - 1).toFixed(1)}px)`;
      cur.style.opacity = still ? "0" : "1";
      // The pull request.
      cls(g1, "on", t >= p.gh1); cls(g2, "on", t >= p.gh2); cls(g1, "res", t >= p.ghres);
      put(q(g1, ".c-av"), p.a.charAt(0)); put(q(g2, ".c-av"), p.b.charAt(0));
      put(q(g1, ".c-gw"), `<b>${p.a}</b> ${fs("commented on the preview", "commented")}`);
      put(q(g2, ".c-gw"), `<b>${p.b}</b> replied`);
      const gt = q(g1, ".c-itt");
      put(gt, t >= p.ghres ? "✓ resolved, hidden" : p.th.text);
      cls(gt, "res", t >= p.ghres);
      put(q(g2, ".c-itt"), p.th.reply);
      put(dpu, `pr-${p.num}.shop-preview.dev`);
      if (t >= p.rclick) return 3;
      if (t >= p.think) return 2;
      if (t >= p.post) return 1;
      return 0;
    };
  },
});
