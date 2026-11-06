import { escapeHtml, initialHtml } from "./html.ts"

import type { SimulatorConfig, SimulatorDocument, SimulatorSkin, SimulatorView } from "./types.ts"

// Inspired by a Telegram Web chat with a bot. It follows the system theme. No Telegram logo, font, or asset is used.
const css = `
:root {
  --side: #fff; --text: #000; --muted: #707579; --accent: #1f74c9; --link: #1f74c9; --hover: #f4f4f5; --line: #dadce0;
  --in: #fff; --out: #eeffde; --out-accent: #2f7d2e; --in-meta: #67737e; --out-meta: #2f7d2e;
  --service: rgba(70, 110, 70, .42);
  --wall: linear-gradient(135deg, #dbddbb 0%, #6ba587 35%, #d5d88d 70%, #88b884 100%);
  --dots: rgba(255, 255, 255, .22);
  --sim-strip-bg: var(--side); --sim-strip-text: var(--muted); --sim-surface: var(--side); --sim-text: var(--text); --sim-line: var(--line);
}
@media (prefers-color-scheme: dark) {
  :root {
    --side: #212121; --text: #fff; --muted: #aaa; --accent: #6356bd; --link: #9d8cf0; --hover: #2c2c2c; --line: #0f0f0f;
    --in: #212121; --out: #6356bd; --out-accent: #fff; --in-meta: #8a8a8a; --out-meta: rgba(255, 255, 255, .85);
    --service: rgba(0, 0, 0, .35);
    --wall: linear-gradient(135deg, #1c2a24 0%, #24352c 40%, #182520 70%, #2a3a2e 100%);
    --dots: rgba(255, 255, 255, .05);
  }
}
* { box-sizing: border-box; }
body { font: 15px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--side); -webkit-font-smoothing: antialiased; }
.sim-root { display: flex; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.icon { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; color: var(--muted); flex: none; }
.icon svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.avatar { width: 54px; height: 54px; border-radius: 50%; flex: none; display: grid; place-items: center; color: #fff; font-weight: 600; font-size: 20px; background: linear-gradient(#72d5fd, #2a9ef1); }
aside { width: 340px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--line); background: var(--side); }
.side-top { display: flex; align-items: center; gap: 8px; padding: 6px 12px 6px 8px; height: 56px; }
.search { flex: 1; display: flex; align-items: center; gap: 8px; height: 42px; border-radius: 22px; background: var(--hover); color: var(--muted); font-size: 16px; padding: 0 12px; }
.search svg { width: 24px; height: 24px; fill: none; stroke: var(--muted); stroke-width: 1.8; stroke-linecap: round; }
.chats { flex: 1; padding: 0 8px; overflow: auto; }
.chat-item { display: flex; gap: 10px; align-items: center; padding: 9px; border-radius: 12px; background: var(--accent); color: #fff; }
.chat-item .row { display: flex; justify-content: space-between; gap: 8px; }
.chat-item .body { flex: 1; min-width: 0; }
.chat-item b { font-weight: 600; font-size: 16px; }
.chat-item .tag { font-size: 11px; font-weight: 600; text-transform: uppercase; border: 1px solid rgba(255, 255, 255, .7); border-radius: 4px; padding: 0 4px; margin-left: 6px; vertical-align: 2px; }
.chat-item small { font-size: 12px; opacity: .85; }
.preview { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .9; margin-top: 2px; }
.side-foot { padding: 10px 16px; font-size: 13px; color: var(--muted); }
main { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; background: var(--wall); }
main::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .7;
  background: radial-gradient(circle at 14px 18px, var(--dots) 2px, transparent 2.6px) 0 0 / 58px 62px,
              radial-gradient(circle at 44px 40px, transparent 5px, var(--dots) 5.5px, var(--dots) 6.6px, transparent 7.1px) 0 0 / 86px 78px,
              radial-gradient(ellipse 9px 4px at 30px 70px, transparent 6px, var(--dots) 6.5px, transparent 8px) 0 0 / 104px 96px; }
header { position: relative; z-index: 1; height: 56px; flex: none; display: flex; align-items: center; gap: 12px; padding: 0 8px 0 16px; background: var(--side); }
header .avatar { width: 42px; height: 42px; font-size: 17px; }
header .who { flex: 1; min-width: 0; }
header .name { min-width: 0; font-weight: 600; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
header .status { font-size: 14px; color: var(--muted); }
header .status.typing { color: var(--link); }
.typing i { display: inline-block; width: 3px; height: 3px; margin-left: 1px; border-radius: 50%; background: currentColor; animation: blink 1.2s infinite; }
.typing i:nth-child(2) { animation-delay: .2s; } .typing i:nth-child(3) { animation-delay: .4s; }
@keyframes blink { 0%, 60%, 100% { opacity: .2; } 30% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .typing i { animation: none; } }
#scroll { position: relative; flex: 1; overflow-y: auto; padding: 0 16px 8px; }
.column { max-width: 728px; margin: 0 auto; display: flex; flex-direction: column; }
.day { position: sticky; top: 8px; z-index: 1; align-self: center; margin: 8px 0; padding: 2px 9px; border-radius: 13px; font-size: 14px; font-weight: 500; color: #fff; background: var(--service); }
.empty { align-self: center; margin-top: 30vh; padding: 12px 18px; border-radius: 16px; color: #fff; text-align: center; background: var(--service); }
.day[hidden], .empty[hidden] { display: none; }
.msg { display: flex; margin-top: 2px; }
.msg.first { margin-top: 8px; }
.msg.user { justify-content: flex-end; }
.bubble { position: relative; display: flow-root; max-width: min(480px, 85%); padding: 6px 9px 7px 10px; border-radius: 12px; background: var(--in); overflow-wrap: anywhere; filter: drop-shadow(0 1px 1px rgba(16, 35, 47, .14)); --a: var(--link); }
.user .bubble { background: var(--out); --a: var(--out-accent); }
.assistant:not(.first) .bubble { border-top-left-radius: 6px; }
.assistant:not(.last) .bubble { border-bottom-left-radius: 6px; }
.user:not(.first) .bubble { border-top-right-radius: 6px; }
.user:not(.last) .bubble { border-bottom-right-radius: 6px; }
.last .bubble::before { content: ""; position: absolute; bottom: 0; width: 9px; height: 17px; }
.assistant.last .bubble { border-bottom-left-radius: 0; }
.assistant.last .bubble::before { left: -8.6px; background: radial-gradient(ellipse 9px 17px at 0 0, transparent 97%, var(--in) 100%); }
.user.last .bubble { border-bottom-right-radius: 0; }
.user.last .bubble::before { right: -8.6px; background: radial-gradient(ellipse 9px 17px at 100% 0, transparent 97%, var(--out) 100%); }
.bubble p { margin: 0; }
.bubble p + *, .bubble * + p, .bubble ul, .bubble ol, .bubble pre, .bubble blockquote { margin: 6px 0 0; }
.bubble > :first-child { margin-top: 0; }
.bubble ul, .bubble ol { padding-left: 22px; }
.bubble a { color: var(--a); text-decoration: none; } .bubble a:hover { text-decoration: underline; }
.bubble code { font: 14px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: color-mix(in srgb, var(--a) 12%, transparent); border-radius: 4px; padding: 0 3px; }
.bubble pre { border-left: 3px solid var(--a); border-radius: 6px; padding: 5px 8px 6px; background: color-mix(in srgb, var(--a) 10%, transparent); overflow-x: auto; }
.bubble pre[data-lang]::before { content: attr(data-lang); display: block; color: var(--a); font-size: 13px; font-weight: 600; margin-bottom: 2px; }
.bubble pre code { display: block; background: none; padding: 0; font-size: 13.5px; white-space: pre; }
.bubble blockquote { border-left: 3px solid var(--a); border-radius: 4px; padding: 3px 8px; background: color-mix(in srgb, var(--a) 10%, transparent); }
.meta { float: right; position: relative; top: 6px; margin-left: 12px; font-size: 12px; line-height: 16px; color: var(--in-meta); white-space: nowrap; user-select: none; }
.user .meta { color: var(--out-meta); }
.checks { margin-left: 3px; letter-spacing: -5px; padding-right: 5px; font-size: 13px; }
form { position: relative; z-index: 1; flex: none; display: flex; align-items: flex-end; gap: 8px; width: 100%; max-width: 760px; margin: 0 auto; padding: 0 16px 16px; }
.box { position: relative; flex: 1; display: flex; align-items: flex-end; min-height: 54px; padding: 7px 4px; border-radius: 16px 16px 0 16px; background: var(--side); box-shadow: 0 1px 2px rgba(16, 35, 47, .15); }
.box:focus-within { box-shadow: 0 0 0 2px var(--accent), 0 1px 2px rgba(16, 35, 47, .15); }
.box::after { content: ""; position: absolute; right: -8.6px; bottom: 0; width: 9px; height: 17px; background: radial-gradient(ellipse 9px 17px at 100% 0, transparent 97%, var(--side) 100%); }
textarea { flex: 1; min-width: 0; resize: none; border: 0; outline: none; background: none; color: var(--text); font: inherit; font-size: 16px; line-height: 22px; padding: 9px 4px; height: 40px; max-height: 160px; }
textarea::placeholder { color: var(--muted); }
.send { width: 54px; height: 54px; border-radius: 50%; display: grid; place-items: center; flex: none; background: var(--side); color: var(--accent); box-shadow: 0 1px 2px rgba(16, 35, 47, .15); }
.send svg { width: 26px; height: 26px; fill: currentColor; }
.send:hover { background: var(--accent); color: #fff; }
.sim-error { width: min(728px, 100% - 32px); margin: 8px auto; }
@media (max-width: 720px) { aside { display: none; } }
[data-embed] aside { display: none; }
`

function body(config: SimulatorConfig): string {
  const agent = escapeHtml(config.agent)
  const initial = initialHtml(config.agent)
  return `<aside aria-label="Chats">
  <div class="side-top">
    <span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg></span>
    <div class="search" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>Search</div>
  </div>
  <div class="chats">
    <div class="chat-item" aria-current="true">
      <div class="avatar" aria-hidden="true">${initial}</div>
      <div class="body">
        <div class="row"><span><b>${agent}</b><span class="tag">bot</span></span><small id="preview-time"></small></div>
        <div class="preview" id="preview">bot</div>
      </div>
    </div>
  </div>
  <div class="side-foot">Signed in as <strong>${escapeHtml(config.user)}</strong></div>
</aside>
<main>
  <header>
    <div class="avatar" aria-hidden="true">${initial}</div>
    <div class="who"><div class="name">${agent}</div><div class="status" id="status">bot</div></div>
    <span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="5.5" r=".6"/><circle cx="12" cy="12" r=".6"/><circle cx="12" cy="18.5" r=".6"/></svg></span>
  </header>
  <div id="scroll">
    <div class="column" id="list" role="log" aria-live="polite" aria-label="Messages">
      <div class="empty" id="empty">No messages here yet…<br>Say hi to your Agent.</div>
      <div class="day" id="day" hidden>Today</div>
    </div>
  </div>
  <form id="form">
    <div class="box">
      <span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5v.5M15 9.5v.5"/></svg></span>
      <label for="input" class="sr-only">Message ${agent}</label>
      <textarea id="input" rows="1" placeholder="Message" enterkeyhint="send" autocomplete="off"></textarea>
      <span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M19 11.5l-7.1 7.1a4.6 4.6 0 0 1-6.5-6.5l7.4-7.4a3 3 0 0 1 4.3 4.3l-7.2 7.2a1.5 1.5 0 0 1-2.1-2.1l6.6-6.6"/></svg></span>
    </div>
    <button class="send" type="submit" aria-label="Send message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.4l17.4-7.5a1 1 0 0 0 0-1.8L3.4 3.6a.7.7 0 0 0-1 .8L4.5 11l9 1-9 1-2.1 6.6a.7.7 0 0 0 1 .8z"/></svg></button>
  </form>
</main>`
}

function telegramMessage(view: SimulatorView, index: number): string {
  const message = view.messages[index]
  const previous = index > 0 ? view.messages[index - 1] : undefined
  const next = index + 1 < view.messages.length ? view.messages[index + 1] : undefined
  const first = previous === undefined || previous.role !== message.role
  const last = next === undefined || next.role !== message.role
  const read = view.messages.slice(index + 1).some(later => later.role === "assistant")
  const checks = message.role === "user" ? `<span class="checks" aria-label="${read ? "Read" : "Sent"}">${read ? "✓✓" : "✓"}</span>` : ""
  const meta = `<span class="meta">${view.time(message.at)}${checks}</span>`
  const html = view.markdown(message.text)
  const content = html.endsWith("</p>") ? `${html.slice(0, -4)}${meta}</p>` : `${html}${meta}`
  return `<div class="msg ${message.role}${first ? " first" : ""}${last ? " last" : ""}"><div class="bubble">${content}</div></div>`
}

function telegramUpdate(view: SimulatorView, document: SimulatorDocument): void {
  const last = view.messages.at(-1)
  const empty = document.getElementById("empty")
  const day = document.getElementById("day")
  const status = document.getElementById("status")
  const preview = document.getElementById("preview")
  const previewTime = document.getElementById("preview-time")
  if (empty) empty.hidden = last !== undefined
  if (day) day.hidden = last === undefined
  if (status) {
    status.setAttribute("class", view.busy ? "status typing" : "status")
    status.innerHTML = view.busy ? "typing<i></i><i></i><i></i>" : "bot"
  }
  if (preview) {
    const line = last?.text.replace(/[*_`>#]/g, "").split("\n").find(text => text.trim()) ?? ""
    preview.textContent = view.busy ? "typing…" : last ? `${last.role === "user" ? "You: " : ""}${line}` : "bot"
  }
  if (previewTime) previewTime.textContent = last ? view.time(last.at) : ""
}

export const telegramSkin: SimulatorSkin = { body, css, message: telegramMessage, platform: "Telegram", update: telegramUpdate }
