// i18n: a small page switches locale. The source has only English text inside t``, with no key. Each locale has
// its own record of the message. One record is missing, so the page shows the source text. A translator fills it,
// and after the next build the page shows it in that locale.
import { defineScene, clamp, lerp, snap, rng, fs, h, q, qa, prog, cls, put } from "../engine";

type Loc = "en" | "es" | "fr" | "ja";
type Other = Exclude<Loc, "en">;
/** One text per locale, in the order of LOCS. */
type PerLoc = [string, string, string, string];
/** A heading and a button text. */
interface Message {
  h: PerLoc;
  b: PerLoc;
}
interface I18nPlan {
  len: number;
  end: number;
  m: Message;
  /** [time, locale]: when the page switches to a locale. */
  visits: [number, Loc][];
  miss: Other;
  tMiss: number;
  tType: number;
  tTyped: number;
  tBuild: number;
  tDone: number;
}

const LOCS: Loc[] = ["en", "es", "fr", "ja"];
const MSGS: Message[] = [
  { h: ["Your trip is booked", "Tu viaje está reservado", "Votre voyage est réservé", "旅行の予約が完了しました"], b: ["Save changes", "Guardar cambios", "Enregistrer", "変更を保存"] },
  { h: ["Welcome back, Ana", "Hola de nuevo, Ana", "Bon retour, Ana", "おかえりなさい、Ana"], b: ["Sign in", "Iniciar sesión", "Se connecter", "ログイン"] },
  { h: ["Your order has shipped", "Tu pedido está en camino", "Votre commande est partie", "ご注文の商品を発送しました"], b: ["Track order", "Seguir pedido", "Suivre la commande", "注文を追跡"] },
];
const NAMES: Record<Other, string> = { es: "Spanish", fr: "French", ja: "Japanese" };

const css = `.vh-hero-i18n .i-root{position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:stretch}
.vh-hero-i18n .i-left{display:flex;flex-direction:column;gap:12px;min-width:0}
.vh-hero-i18n .i-seg{position:relative;display:flex;align-self:flex-start;padding:3px;border-radius:99px;box-shadow:inset 0 0 0 1px var(--line)}
.vh-hero-i18n .i-seg span{position:relative;z-index:1;width:40px;text-align:center;font:12px/22px var(--mono);color:var(--muted);transition:color 250ms ease}
.vh-hero-i18n .i-seg span.on{color:var(--bg)}
.vh-hero-i18n .i-thumb{position:absolute;left:3px;top:3px;width:40px;height:22px;border-radius:99px;background:var(--fg)}
.vh-hero-i18n .i-app{position:relative;flex:1;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);padding:18px 18px 16px;display:flex;flex-direction:column;justify-content:space-between;min-height:0}
.vh-hero-i18n .i-url{font:11px var(--mono);color:var(--dim)}
.vh-hero-i18n .i-h{margin:6px 0 0;font-size:20px;line-height:1.25;font-weight:600;letter-spacing:-.01em;min-height:50px}
.vh-hero-i18n .i-h>span,.vh-hero-i18n .i-btn>span{display:inline-block;animation:vh-fig-c 280ms var(--out)}
.vh-hero-i18n .i-row{display:flex;align-items:center;gap:10px}
.vh-hero-i18n .i-btn{display:inline-flex;align-items:center;height:32px;padding:0 14px;border-radius:8px;background:var(--fg);color:var(--bg);font-size:13px;font-weight:500;white-space:nowrap;transition:background-color 300ms ease,box-shadow 300ms ease}
.vh-hero-i18n .i-btn.src{background:none;color:var(--fg);box-shadow:inset 0 0 0 1px var(--warn)}
.vh-hero-i18n .i-note{font:11px var(--mono);color:var(--warn);opacity:0;transition:opacity 250ms ease}
.vh-hero-i18n .i-note.on{opacity:1}
.vh-hero-i18n .i-pill{position:absolute;right:14px;top:14px;display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:99px;background:var(--fg);color:transparent;font:11px/1 var(--mono);white-space:nowrap;clip-path:inset(calc(50% - 4px) calc(50% - 4px) round 99px);opacity:0;transition:clip-path 550ms cubic-bezier(.65,0,.35,1) 80ms,color 120ms ease-out,background-color 300ms ease,opacity 250ms ease}
.vh-hero-i18n .i-pill.vis{opacity:1}
.vh-hero-i18n .i-pill.open{color:var(--bg);clip-path:inset(0 round 99px);transition:clip-path 650ms cubic-bezier(.65,0,.35,1),color 250ms ease-out 350ms,background-color 300ms ease,opacity 250ms ease}
.vh-hero-i18n .i-pill.ok{background:var(--ok)}
.vh-hero-i18n .i-right{display:flex;flex-direction:column;min-width:0}
.vh-hero-i18n .i-file{font:11px var(--mono);color:var(--muted);height:28px;display:flex;align-items:center}
.vh-hero-i18n .i-card{flex:1;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden;display:flex;flex-direction:column}
.vh-hero-i18n .i-src{padding:11px 14px;font:12px var(--mono);color:var(--fg);box-shadow:inset 0 -1px 0 var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vh-hero-i18n .i-src i{font-style:normal;color:var(--muted)}
.vh-hero-i18n .i-tr{flex:1;display:grid;grid-template-rows:repeat(4,1fr)}
.vh-hero-i18n .i-rec{display:grid;grid-template-columns:28px 1fr auto;align-items:center;gap:8px;padding:0 14px;font-size:13px;transition:background-color 250ms ease}
.vh-hero-i18n .i-rec+.i-rec{box-shadow:inset 0 1px 0 var(--soft)}
.vh-hero-i18n .i-rec.cur{background:var(--soft)}
.vh-hero-i18n .i-loc{font:11px var(--mono);color:var(--muted)}
.vh-hero-i18n .i-txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--fg)}
.vh-hero-i18n .i-txt.miss{color:var(--warn);font:11px var(--mono)}
.vh-hero-i18n .i-caret{display:inline-block;width:1px;height:14px;margin-left:1px;vertical-align:-2px;background:var(--fg);opacity:0}
.vh-hero-i18n .i-caret.on{opacity:1;animation:i18nblink 900ms steps(1) infinite}
@keyframes i18nblink{50%{opacity:0}}
.vh-hero-i18n .i-tag{font:11px var(--mono);color:var(--dim);transition:color 300ms ease}
.vh-hero-i18n .i-tag.ok{color:var(--ok)}.vh-hero-i18n .i-tag.warn{color:var(--warn)}
@container (max-width:640px){
 .vh-hero-i18n .i-root{gap:22px}
 .vh-hero-i18n .i-src{padding:11px 10px;font-size:11px}
}
@container (max-width:560px){
 .vh-hero-i18n .lane{height:236px!important}
 .vh-hero-i18n .i-root{display:flex;flex-direction:column;gap:10px}
 .vh-hero-i18n .i-left{gap:10px}
 .vh-hero-i18n .i-seg span{width:34px}.vh-hero-i18n .i-thumb{width:34px}
 .vh-hero-i18n .i-app{flex:none;padding:12px 14px;gap:10px}
 .vh-hero-i18n .i-h{margin-top:4px;font-size:15px;min-height:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .vh-hero-i18n .i-btn{height:28px;padding:0 10px;font-size:12px}
 .vh-hero-i18n .i-pill{top:auto;bottom:14px;right:12px}
 .vh-hero-i18n .i-note{display:none}
 .vh-hero-i18n .i-file{position:absolute;right:2px;top:0;height:28px}
 .vh-hero-i18n .i-right{flex:1}
 .vh-hero-i18n .i-card{flex:none}
 .vh-hero-i18n .i-src{padding:8px 12px;font-size:11px}
 .vh-hero-i18n .i-tr{grid-template-rows:none;grid-template-columns:1fr 1fr}
 .vh-hero-i18n .i-rec{height:30px;grid-template-columns:20px 1fr auto;padding:0 12px;gap:6px;font-size:12px}
 .vh-hero-i18n .i-rec+.i-rec{box-shadow:none}
 .vh-hero-i18n .i-rec:nth-child(n+3){box-shadow:inset 0 1px 0 var(--soft)}
 .vh-hero-i18n .i-rec:nth-child(odd){border-right:1px solid var(--soft)}
 .vh-hero-i18n .i-tag{font-size:10.5px}
}
@container (max-width:420px){
 .vh-hero-i18n .i-tag{display:none}
 .vh-hero-i18n .i-rec{grid-template-columns:20px 1fr;padding:0 10px}
}`;

export default defineScene<I18nPlan>({
  css,
  key: "i18n",
  name: "i18n",
  label: "A small page has a heading and a button. The source code has only the English text inside t, with no key. The locale changes from English to Spanish, French, and Japanese, and the page text changes with it. One translation is missing, so the button shows the English source text. A translator writes the missing text, and after the next build the page shows it.",
  H: 220,
  steps: p => [
    "Write the text in your own language with t``. There is no key to name.",
    "Each locale has a record of the message. The page shows the text of the selected locale.",
    `The ${NAMES[p.miss]} record is missing, so the button shows the source text. vitehub i18n status lists it.`,
    "A translator writes the missing text in its record.",
    `After the next build, the page shows the button in ${NAMES[p.miss]} too.`,
  ],
  summary: "The page text is written once in English, with no keys. Each locale shows its own translation, and a missing one shows the source text until a translator writes it.",
  plan(k) {
    const r = rng(k + 4111);
    const m = MSGS[k % MSGS.length]!;
    const rest: Other[] = ["es", "fr", "ja"];
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [rest[i], rest[j]] = [rest[j]!, rest[i]!] }
    const gap = snap(2200 + r() * 400);
    const visits: [number, Loc][] = [[0, "en"]];
    let t = 1600;
    for (const l of rest) { visits.push([t, l]); t += gap }
    // The last locale has no record of the button.
    const miss = rest[2]!, tMiss = 1600 + 2 * gap;
    const tType = tMiss + 1900, tTyped = tType + 1400, tBuild = tTyped + 700, tDone = tBuild + 1400;
    return { len: tDone + 2600, end: tDone + 1200, m, visits, miss, tMiss, tType, tTyped, tBuild, tDone };
  },
  frame: () => ({ tok: {} }), // the lane checker reads it; the stage draws through render
  render(stage) {
    const root = h(`<div class="i-root">
      <div class="i-left">
        <div class="i-seg"><b class="i-thumb"></b>${LOCS.map(l => `<span>${l}</span>`).join("")}</div>
        <div class="i-app">
          <span class="i-pill"><span class="i-pl"></span></span>
          <div><div class="i-url">/trips</div><p class="i-h"></p></div>
          <div class="i-row"><span class="i-btn"></span><span class="i-note">source text</span></div>
        </div>
      </div>
      <div class="i-right">
        <div class="i-file">src/App.vue</div>
        <div class="i-card">
          <div class="i-src"></div>
          <div class="i-tr">${LOCS.map(l => `<div class="i-rec"><span class="i-loc">${l}</span><span class="i-txt"></span><span class="i-tag"></span></div>`).join("")}</div>
        </div>
      </div>
    </div>`);
    stage.append(root);
    const $ = (s: string) => q(root, s);
    const seg = qa(root, ".i-seg span"), thumb = $(".i-thumb"), head = $(".i-h"), btn = $(".i-btn"), note = $(".i-note");
    const pill = $(".i-pill"), pl = $(".i-pl"), src = $(".i-src"), recs = qa(root, ".i-rec");
    return (t, p, still) => {
      root.style.opacity = still ? "1" : (1 - clamp((t - (p.len - 500)) / 500)).toFixed(3);
      // Which locale is selected, and the thumb that slides between chips.
      let li = 0, from = 0, at = 0;
      for (const [vt, l] of p.visits) if (t >= vt) { from = li; li = LOCS.indexOf(l); at = vt }
      const w = seg[0]?.offsetWidth || 40;
      thumb.style.transform = `translateX(${(lerp(from, li, prog(t, at, at + 450)) * w).toFixed(2)}px)`;
      seg.forEach((s, i) => cls(s, "on", i === li && t >= at + 200));
      const loc = LOCS[li], mi = LOCS.indexOf(p.miss);
      const filled = t >= p.tTyped, built = t >= p.tDone;
      put(head, `<span>${p.m.h[li]}</span>`);
      const showSrc = loc === p.miss && !built;
      put(btn, `<span>${showSrc ? p.m.b[0] : p.m.b[li]}</span>`);
      cls(btn, "src", showSrc);
      cls(note, "on", showSrc);
      // The rebuild pill.
      const building = t >= p.tBuild && t < p.tDone + 900;
      cls(pill, "vis", building);
      cls(pill, "open", building && t < p.tDone + 300);
      cls(pill, "ok", t >= p.tDone - 200);
      put(pl, t >= p.tDone - 200 ? "built ✓" : "vite build");
      put(src, fs(`<i>&lt;button&gt;</i>{{ t\`${p.m.b[0]}\` }}<i>&lt;/button&gt;</i>`, `t\`${p.m.b[0]}\``));
      recs.forEach((rec, i) => {
        const txt = q(rec, ".i-txt"), tag = q(rec, ".i-tag");
        cls(rec, "cur", i === li && t >= at + 200);
        if (i === 0) { put(txt, p.m.b[0]); put(tag, "source"); cls(tag, "ok", false); cls(txt, "miss", false); return }
        if (i !== mi) { put(txt, p.m.b[i] ?? ""); put(tag, "✓"); cls(tag, "ok", true); cls(tag, "warn", false); cls(txt, "miss", false); return }
        if (t < p.tType) {
          put(txt, "no translation"); cls(txt, "miss", true); put(tag, "missing"); cls(tag, "warn", true); cls(tag, "ok", false);
          return;
        }
        const full = [...p.m.b[i] ?? ""], n = Math.round(clamp((t - p.tType) / (p.tTyped - p.tType - 200)) * full.length);
        cls(txt, "miss", false);
        put(txt, `${full.slice(0, n).join("")}<span class="i-caret ${filled ? "" : "on"}"></span>`);
        put(tag, filled ? "human ✓" : "editing");
        cls(tag, "warn", !filled); cls(tag, "ok", filled);
      });
      if (t >= p.tDone) return 4;
      if (t >= p.tType) return 3;
      if (t >= p.tMiss) return 2;
      if (t >= (p.visits[1]?.[0] ?? 0)) return 1;
      return 0;
    };
  },
});
