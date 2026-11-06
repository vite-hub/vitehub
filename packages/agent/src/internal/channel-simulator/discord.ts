import { escapeHtml, initialHtml } from "./html.ts"

import type { SimulatorConfig, SimulatorDocument, SimulatorSkin, SimulatorView } from "./types.ts"

// Inspired by a Discord direct message with an app, in the dark theme. No Discord logo, font, or asset is used.
const css = `
:root { --rail:#1e1f22; --side:#2b2d31; --chat:#313338; --input:#383a40; --panel:#232428; --hover:#2e3035; --sel:#404249; --side-hover:#35373c;
  --text:#dbdee1; --strong:#f2f3f5; --muted:#949ba4; --faint:#6d6f78; --line:#3f4147; --code:#2b2d31; --code-line:#1e1f22; --quote:#4e5058;
  --link:#00a8fc; --brand:#5865f2; --green:#23a55a; --plus:#b5bac1; --skel:#3f4147; color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { font: 16px/1.375 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--rail); color: var(--text); -webkit-font-smoothing: antialiased; overflow: hidden; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.app { display: flex; flex-direction: column; height: 100dvh; }
.titlebar { height: 22px; flex: none; display: flex; align-items: center; justify-content: center; gap: 12px; padding: 0 8px; font-size: 12px; font-weight: 600; color: var(--muted); white-space: nowrap; overflow: hidden; }
.cols { flex: 1; display: flex; min-height: 0; }
.av { --c: var(--brand); position: relative; flex: none; width: 32px; height: 32px; border-radius: 50%; background: var(--c); color: #fff; display: grid; place-items: center; font-weight: 600; font-size: 14px; user-select: none; }
.av.user { --c: #248046; }
.av.dot::after { content: ""; position: absolute; right: -3px; bottom: -3px; width: 10px; height: 10px; border-radius: 50%; background: var(--green); border: 3px solid var(--ring, var(--side)); }
.tag { display: inline-flex; align-items: center; height: 15px; padding: 0 4px; border-radius: 3px; background: var(--brand); color: #fff; font-size: 10px; font-weight: 600; line-height: 15px; vertical-align: 2px; margin-left: 4px; }
.rail { width: 72px; flex: none; display: flex; flex-direction: column; align-items: center; gap: 8px; padding-top: 12px; }
.rail .srv { position: relative; width: 48px; height: 48px; border-radius: 50%; background: var(--chat); display: grid; place-items: center; color: var(--green); font-size: 24px; }
.rail .srv.home { border-radius: 16px; background: var(--brand); color: #fff; }
.rail .srv.home::before { content: ""; position: absolute; left: -12px; width: 4px; height: 40px; border-radius: 0 4px 4px 0; background: var(--strong); }
.rail hr { width: 32px; height: 2px; border: 0; border-radius: 1px; background: var(--line); margin: 0; }
.dms { width: 240px; flex: none; background: var(--side); display: flex; flex-direction: column; border-top-left-radius: 8px; }
.find { height: 48px; flex: none; padding: 10px; box-shadow: 0 1px 0 rgb(4 4 5 / .2); }
.find div { height: 28px; border-radius: 4px; background: var(--rail); color: var(--muted); font-size: 14px; line-height: 28px; padding: 0 6px; }
.dms nav { padding: 8px; flex: 1; overflow: hidden; }
.item { display: flex; align-items: center; gap: 12px; height: 42px; padding: 0 8px; border-radius: 4px; color: var(--muted); font-weight: 500; margin-bottom: 2px; }
.item.sel { background: var(--sel); color: var(--strong); --ring: var(--sel); }
.item svg { width: 24px; height: 24px; margin: 0 4px; }
.dms h2 { display: flex; justify-content: space-between; margin: 16px 8px 4px 10px; font-size: 12px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--muted); }
.skel { display: flex; align-items: center; gap: 12px; height: 42px; padding: 0 8px; opacity: .7; }
.skel i { width: 32px; height: 32px; border-radius: 50%; background: var(--skel); }
.skel b { height: 18px; border-radius: 9px; background: var(--skel); }
.me { height: 52px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 8px; background: var(--panel); --ring: var(--panel); }
.me .who { flex: 1; min-width: 0; font-size: 14px; line-height: 18px; }
.me .who b { display: block; color: var(--strong); font-weight: 600; }
.me .who span { font-size: 12px; color: var(--muted); }
main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--chat); --ring: var(--chat); }
header { height: 48px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 16px; box-shadow: 0 1px 0 rgb(4 4 5 / .2), 0 2px 0 rgb(6 6 7 / .05); z-index: 1; }
header .av { width: 24px; height: 24px; font-size: 12px; margin-right: 4px; }
header .av.dot::after { width: 8px; height: 8px; border-width: 2px; right: -2px; bottom: -2px; }
header h1 { margin: 0; font-size: 16px; font-weight: 600; color: var(--strong); }
header .search { margin-left: auto; width: 144px; height: 24px; border-radius: 4px; background: var(--rail); color: var(--muted); font-size: 14px; line-height: 24px; padding: 0 6px; }
.scroll { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
.history { margin-top: auto; padding-bottom: 24px; }
.intro { padding: 16px; margin-bottom: 8px; }
.intro .av { width: 80px; height: 80px; font-size: 34px; }
.intro h2 { margin: 8px 0 0; font-size: 24px; line-height: 30px; color: var(--strong); }
.intro .handle { font-size: 20px; color: var(--strong); margin: 2px 0 16px; }
.intro p { margin: 0; color: var(--muted); }
.intro p b { color: var(--text); }
.divider { display: flex; align-items: center; margin: 24px 16px 8px; height: 0; border-top: 1px solid var(--line); justify-content: center; }
.divider span { background: var(--chat); padding: 0 4px; font-size: 12px; font-weight: 600; color: var(--muted); line-height: 13px; }
.row { position: relative; padding: 2px 48px 2px 72px; min-height: 22px; }
.row:hover { background: var(--hover); }
.row.head { margin-top: 17px; min-height: 44px; }
.row .av { position: absolute; left: 16px; top: 4px; width: 40px; height: 40px; font-size: 17px; }
.row .name { color: var(--strong); font-weight: 500; }
.row time { font-size: 12px; color: var(--muted); margin-left: 4px; }
.row .gutter { position: absolute; left: 0; width: 56px; text-align: right; font-size: 11px; line-height: 22px; margin: 0; visibility: hidden; }
.row:hover .gutter { visibility: visible; }
.body { overflow-wrap: anywhere; }
.body p, .body ul, .body ol, .body pre, .body blockquote { margin: 0; }
.body > * + * { margin-top: 4px; }
.body ul, .body ol { padding-left: 1.4em; }
.body a { color: var(--link); text-decoration: none; }
.body a:hover { text-decoration: underline; }
.body code { font: .85em/1.125rem ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: var(--code); padding: .2em; border-radius: 3px; }
.body pre { max-width: 90%; background: var(--code); border: 1px solid var(--code-line); border-radius: 4px; padding: .5em; margin-top: 6px; }
.body pre code { display: block; padding: 0; font-size: 14px; white-space: pre-wrap; background: none; }
.body blockquote { border-left: 4px solid var(--quote); border-radius: 4px 0 0 4px; padding-left: 12px; }
.composer { flex: none; margin: 0 16px; display: flex; align-items: flex-start; background: var(--input); border-radius: 8px; }
.composer .plus { flex: none; width: 24px; height: 24px; margin: 10px 16px; border-radius: 50%; background: var(--plus); color: var(--input); font-size: 20px; line-height: 24px; font-weight: 700; }
.composer textarea { flex: 1; min-height: 44px; max-height: 50vh; padding: 11px 10px 11px 0; border: 0; outline: 0; resize: none; background: none; color: var(--text); font: inherit; }
.composer textarea::placeholder { color: var(--faint); }
.composer .emoji { flex: none; margin: 10px 16px 10px 4px; width: 24px; height: 24px; color: var(--muted); }
.typing { height: 24px; flex: none; padding: 0 16px; display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--text); }
.dots { display: inline-flex; gap: 3px; margin-right: 2px; }
.dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--text); animation: blink 1.2s infinite ease-in-out; }
.dots i:nth-child(2) { animation-delay: .15s; } .dots i:nth-child(3) { animation-delay: .3s; }
@keyframes blink { 0%, 60%, 100% { opacity: .3; transform: scale(.8); } 30% { opacity: 1; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .dots i { animation: none; opacity: .7; } }
@media (max-width: 720px) { .rail, .dms { display: none; } header .search { display: none; } .row { padding-right: 16px; } }
@media (pointer: coarse) { .composer textarea { font-size: 16px; } }
`

function body(config: SimulatorConfig, switcher: string): string {
  const agent = escapeHtml(config.agent)
  const user = escapeHtml(config.user)
  const handle = escapeHtml(config.agent.toLowerCase().replace(/\s+/g, ""))
  return `<div class="app">
  <div class="titlebar"><span>Unofficial simulator · not affiliated with ${escapeHtml(config.platform)}</span>${switcher}</div>
  <div class="cols">
    <nav class="rail" aria-hidden="true">
      <div class="srv home"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-4 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg></div>
      <hr><div class="srv"></div><div class="srv"></div><div class="srv">+</div>
    </nav>
    <aside class="dms" aria-label="Direct messages">
      <div class="find"><div>Find or start a conversation</div></div>
      <nav>
        <div class="item"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="8" r="4"/><path d="M1 20c0-4 4-6 8-6s8 2 8 6z"/><circle cx="17" cy="9" r="3" opacity=".6"/></svg>Friends</div>
        <h2>Direct Messages <span aria-hidden="true">+</span></h2>
        <div class="item sel" aria-current="page"><div class="av dot" aria-hidden="true">${initialHtml(config.agent)}</div><span>${agent}</span><span class="tag">APP</span></div>
        <div class="skel" aria-hidden="true"><i></i><b style="width:110px"></b></div>
        <div class="skel" aria-hidden="true" style="opacity:.45"><i></i><b style="width:80px"></b></div>
      </nav>
      <div class="me"><div class="av user dot" aria-hidden="true">${initialHtml(config.user)}</div><div class="who"><b>${user}</b><span>Online</span></div></div>
    </aside>
    <main>
      <header><div class="av dot" aria-hidden="true">${initialHtml(config.agent)}</div><h1>${agent}</h1><span class="tag">APP</span><div class="search" aria-hidden="true">Search</div></header>
      <div class="scroll" id="scroll">
        <div class="history">
          <div class="intro"><div class="av" aria-hidden="true">${initialHtml(config.agent)}</div><h2>${agent}</h2><div class="handle">${handle}</div>
            <p>This is the beginning of your direct message history with <b>${agent}</b>.</p></div>
          <div id="list" role="log" aria-live="polite" aria-label="Messages"></div>
        </div>
      </div>
      <form class="composer" id="form">
        <span class="plus" aria-hidden="true">+</span>
        <label for="input" class="sr">Message ${agent}</label>
        <textarea id="input" rows="1" enterkeyhint="send" autocomplete="off" placeholder="Message @${agent}"></textarea>
        <svg class="emoji" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 14c1 1.5 2.5 2 4 2s3-.5 4-2"/><circle cx="9" cy="10" r=".5"/><circle cx="15" cy="10" r=".5"/></svg>
      </form>
      <div class="typing" id="typing" aria-hidden="true"></div>
    </main>
  </div>
</div>`
}

function discordMessage(view: SimulatorView, index: number): string {
  const message = view.messages[index]
  const previous = index > 0 ? view.messages[index - 1] : undefined
  const head = !previous || previous.role !== message.role || message.at.getTime() - previous.at.getTime() > 7 * 60_000
  const agent = message.role === "assistant"
  const name = agent ? view.config.agent : view.config.user
  const initial = view.escape((name.trim().charAt(0) || "?").toUpperCase())
  const stamp = message.at.toISOString()
  const divider = index === 0 ? `<div class="divider" role="separator"><span>${view.escape(message.at.toLocaleDateString("en-US", { dateStyle: "long" }))}</span></div>` : ""
  const meta = head
    ? `<div class="av${agent ? "" : " user"}" aria-hidden="true">${initial}</div><div><span class="name">${view.escape(name)}</span>${agent ? "<span class=\"tag\">APP</span>" : ""}<time datetime="${stamp}">Today at ${view.time(message.at)}</time></div>`
    : `<time class="gutter" datetime="${stamp}">${view.time(message.at)}</time>`
  return `${divider}<div class="row${head ? " head" : ""}">${meta}<div class="body">${view.markdown(message.text)}</div></div>`
}

function discordUpdate(view: SimulatorView, document: SimulatorDocument): void {
  const typing = document.getElementById("typing")
  if (typing) typing.innerHTML = view.busy ? `<span class="dots"><i></i><i></i><i></i></span><span><b>${view.escape(view.config.agent)}</b> is typing…</span>` : ""
}

export const discordSkin: SimulatorSkin = { body, css, message: discordMessage, platform: "Discord", update: discordUpdate }
