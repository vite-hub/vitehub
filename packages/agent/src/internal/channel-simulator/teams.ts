import { escapeHtml, initialHtml } from "./html.ts"

import type { SimulatorConfig, SimulatorDocument, SimulatorSkin, SimulatorView } from "./types.ts"

// Inspired by a Microsoft Teams chat with a bot. It follows the system theme. No Microsoft logo, font, or asset is used.
const css = `
:root{--brand:#5b5fc7;--bar:#ebebeb;--list:#f5f5f5;--main:#fff;--line:#e0e0e0;--text:#242424;--muted:#616161;--soft:#8a8a8a;--in:#f5f5f5;--out:#e8ebfa;--sel:#fff;--hover:#e0e0e0;--code:#fafafa;--link:#4f52b2;--input:#fff;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--brand:#7f85f5;--bar:#0a0a0a;--list:#1f1f1f;--main:#292929;--line:#3d3d3d;--text:#fff;--muted:#adadad;--soft:#858585;--in:#333;--out:#3a3b66;--sel:#333;--hover:#2e2e2e;--code:#1f1f1f;--link:#a7abff;--input:#1f1f1f;color-scheme:dark}}
*{box-sizing:border-box;margin:0}
body{height:100vh;height:100dvh;display:grid;grid-template-rows:48px minmax(0,1fr);font:14px/20px system-ui,"Segoe UI",sans-serif;color:var(--text);background:var(--bar);-webkit-font-smoothing:antialiased}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;flex:none}
.top{display:grid;grid-template-columns:minmax(max-content,1fr) minmax(0,480px) 1fr;align-items:center;gap:16px;padding:0 12px}
.top .l,.top .r{display:flex;align-items:center;gap:8px;min-width:0}
.top .r{justify-content:flex-end}
.unofficial{white-space:nowrap;font-size:11px;line-height:13px;color:var(--muted);border:1px dashed var(--soft);border-radius:4px;padding:1px 6px}
.search{height:32px;border-radius:4px;background:var(--main);display:flex;align-items:center;gap:8px;padding:0 10px;color:var(--soft);border:1px solid var(--line)}
.search svg{width:16px;height:16px}
.app{display:grid;grid-template-columns:68px 320px minmax(0,1fr);min-height:0}
.rail{display:flex;flex-direction:column;align-items:center;gap:2px;padding-top:4px}
.rail span{width:60px;height:56px;display:grid;place-items:center;align-content:center;gap:2px;font-size:10px;line-height:14px;color:var(--muted);border-radius:6px;position:relative}
.rail .on{color:var(--brand);font-weight:600}
.rail .on svg{fill:currentColor;fill-opacity:.18}
.rail .on::before{content:"";position:absolute;left:-4px;top:18px;bottom:18px;width:3px;border-radius:2px;background:var(--brand)}
.chats{background:var(--list);border-radius:8px 0 0 0;border-right:1px solid var(--line);overflow:auto}
.chats-h{display:flex;align-items:center;justify-content:space-between;height:56px;padding:0 12px 0 20px}
.chats-h>span{display:flex}
.chats-h h2{font-size:18px;font-weight:700}
.sec{padding:8px 20px 4px;font-size:12px;color:var(--muted);font-weight:600}
.chat{display:flex;gap:10px;align-items:center;margin:0 8px;padding:8px 12px;border-radius:6px}
.chat.on{background:var(--sel);box-shadow:0 1px 2px rgb(0 0 0/.1)}
.chat .t{flex:1;min-width:0}
.row{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.chat .n,.chat .p{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chat .n{font-weight:600}
.chat .p,.chat time{font-size:12px;color:var(--muted)}
.av{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:600;background:#cfe4fa;color:#0f548c;flex:none;position:relative}
.av.sm{width:24px;height:24px;font-size:10px}
.av.bot{border-radius:6px;background:var(--brand);color:#fff}
.pr{position:absolute;right:-3px;bottom:-3px;width:12px;height:12px;border-radius:50%;background:#6bb700;border:2px solid var(--main)}
.chats .pr{border-color:var(--list)}.chat.on .pr{border-color:var(--sel)}
.pane{background:var(--main);display:flex;flex-direction:column;min-width:0;min-height:0}
.ch{display:flex;align-items:center;gap:10px;height:56px;padding:0 16px 0 20px;border-bottom:1px solid var(--line);flex:none}
.ch h1{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{font-size:10px;font-weight:600;line-height:16px;padding:0 5px;border-radius:4px;color:var(--muted);border:1px solid var(--line);flex:none}
.tabs{display:flex;margin-left:8px;align-self:stretch}
.tabs span{display:flex;align-items:center;padding:0 10px;color:var(--muted);position:relative}
.tabs .on{color:var(--text);font-weight:600}
.tabs .on::after{content:"";position:absolute;left:10px;right:10px;bottom:0;height:3px;border-radius:2px 2px 0 0;background:var(--brand)}
.ch .r{margin-left:auto;display:flex;gap:2px}
.ib{width:32px;height:32px;display:grid;place-items:center;border-radius:4px;color:var(--muted);background:none;border:0;padding:0;cursor:pointer}
.ib:hover{background:var(--hover);color:var(--brand)}
.ib:focus-visible{outline:2px solid var(--brand);outline-offset:1px}
.list{flex:1;overflow-y:auto;padding:8px 20px 4px;display:flex;flex-direction:column}
.empty{margin:auto;text-align:center;color:var(--muted)}
.empty .av{width:72px;height:72px;font-size:28px;border-radius:12px;margin:0 auto 12px}
.empty b{display:block;color:var(--text);font-size:16px;margin-bottom:4px}
.day{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--muted);margin:8px 0}
.day::before,.day::after{content:"";flex:1;border-top:1px solid var(--line)}
.day[hidden],.empty[hidden]{display:none}
.msg{display:flex;gap:8px;margin-top:16px}
.msg.g{margin-top:2px}
.me{justify-content:flex-end}
.body{max-width:75%;min-width:0;display:flex;flex-direction:column;align-items:flex-start}
.me .body{align-items:flex-end}
.meta{display:flex;gap:8px;font-size:12px;color:var(--muted);margin-bottom:2px}
.meta b{font-weight:600;color:var(--text)}
.gap{width:32px;flex:none}
.bubble{background:var(--in);border-radius:6px;padding:8px 16px;overflow-wrap:anywhere;max-width:100%}
.me .bubble{background:var(--out)}
.bubble>*+*{margin-top:8px}
.bubble ul,.bubble ol{padding-left:20px}
.bubble a{color:var(--link)}
.bubble code{font:13px/18px ui-monospace,"Cascadia Code",Consolas,monospace;background:var(--code);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.bubble pre{border:1px solid var(--line);border-radius:6px;background:var(--code);overflow-x:auto;min-width:min(360px,100%)}
.bubble pre::before{content:"Code";display:block;padding:2px 12px;font:12px/20px system-ui,"Segoe UI",sans-serif;color:var(--muted);border-bottom:1px solid var(--line)}
.bubble pre[data-lang]::before{content:attr(data-lang)}
.bubble pre code{display:block;border:0;padding:8px 12px;background:none;white-space:pre}
blockquote{border-left:3px solid var(--soft);padding-left:10px;color:var(--muted)}
.seen{align-self:flex-end;color:var(--brand);margin-left:-4px}
.seen svg{width:14px;height:14px}
.typing{height:24px;padding:0 20px 0 60px;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;flex:none}
.typing[hidden]{display:flex;visibility:hidden}
.dots{display:flex;gap:3px}
.dots i{width:5px;height:5px;border-radius:50%;background:currentColor;animation:b 1.2s infinite}
.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
@keyframes b{0%,60%,100%{opacity:.35;transform:none}30%{opacity:1;transform:translateY(-2px)}}
.compose{margin:0 20px 16px;display:flex;align-items:flex-end;gap:2px;background:var(--input);border:1px solid var(--line);border-radius:6px;padding:4px 6px 4px 12px;flex:none}
.compose:focus-within{border-bottom-color:var(--brand);box-shadow:inset 0 -1px 0 var(--brand)}
textarea{flex:1;resize:none;border:0;outline:0;background:none;color:inherit;font:inherit;padding:6px 0;height:32px;max-height:160px}
textarea::placeholder{color:var(--soft)}
.send{color:var(--brand)}
.compose:has(textarea:placeholder-shown) .send{color:var(--soft)}
.sep{width:1px;height:20px;background:var(--line);margin:6px 4px}
@media (pointer:coarse){textarea{font-size:16px}}
@media (prefers-reduced-motion:reduce){.dots i{animation:none}}
@media (max-width:760px){.app{grid-template-columns:minmax(0,1fr)}.rail,.chats,.search,.tabs{display:none}.top{grid-template-columns:1fr auto}}
`

const icon = (path: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`
const dots = icon("<path d=\"M6 12h.01M12 12h.01M18 12h.01\" stroke-width=\"2.5\"/>")

function body(config: SimulatorConfig, switcher: string): string {
  const agent = escapeHtml(config.agent)
  const user = escapeHtml(config.user)
  const agentInitial = initialHtml(config.agent)
  return `<header class="top">
  <div class="l"><span class="unofficial">Unofficial simulator · not affiliated with ${escapeHtml(config.platform)}</span>${switcher}</div>
  <div class="search" aria-hidden="true">${icon("<circle cx=\"10\" cy=\"10\" r=\"6\"/><path d=\"M15 15l5 5\"/>")}Search</div>
  <div class="r"><span class="ib" aria-hidden="true">${dots}</span><span class="av sm" aria-hidden="true">${initialHtml(config.user)}</span></div>
</header>
<div class="app">
  <nav class="rail" aria-hidden="true">
    <span>${icon("<path d=\"M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20.5a2 2 0 0 0 4 0\"/>")}Activity</span>
    <span class="on">${icon("<path d=\"M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z\"/>")}Chat</span>
    <span>${icon("<circle cx=\"9\" cy=\"8\" r=\"3\"/><path d=\"M3 19c0-3 2.7-5 6-5s6 2 6 5M16 5.5a2.5 2.5 0 0 1 0 5M17 14c2.4.3 4 2 4 4\"/>")}Teams</span>
    <span>${icon("<rect x=\"4\" y=\"5\" width=\"16\" height=\"15\" rx=\"2\"/><path d=\"M4 10h16M8 3v4M16 3v4\"/>")}Calendar</span>
    <span>${dots}</span>
  </nav>
  <aside class="chats" aria-label="Chats">
    <div class="chats-h"><h2>Chat</h2><span aria-hidden="true"><span class="ib">${icon("<path d=\"M4 6h16M7 12h10M10 18h4\"/>")}</span><span class="ib">${icon("<path d=\"M14 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-8M18 3l3 3-8 8h-3v-3z\"/>")}</span></span></div>
    <div class="sec">Recent</div>
    <div class="chat on" aria-current="true"><span class="av bot" aria-hidden="true">${agentInitial}<span class="pr"></span></span><div class="t"><div class="row"><span class="n">${agent}</span><time id="preview-time"></time></div><div class="p" id="preview">Say hi to start</div></div></div>
    <div class="chat"><span class="av" aria-hidden="true">${initialHtml(config.user)}</span><div class="t"><div class="row"><span class="n">${user} (You)</span></div><div class="p">Notes to self</div></div></div>
  </aside>
  <main class="pane">
    <header class="ch">
      <span class="av bot" aria-hidden="true">${agentInitial}<span class="pr"></span></span>
      <h1>${agent}</h1><span class="badge">Bot</span>
      <nav class="tabs" aria-hidden="true"><span class="on">Chat</span><span>Files</span><span>+</span></nav>
      <div class="r" aria-hidden="true"><span class="ib">${icon("<rect x=\"3\" y=\"7\" width=\"12\" height=\"10\" rx=\"2\"/><path d=\"M15 11l6-3v8l-6-3\"/>")}</span><span class="ib">${icon("<path d=\"M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z\"/>")}</span><span class="ib">${dots}</span></div>
    </header>
    <div class="list" id="scroll">
      <div class="empty" id="empty"><div class="av bot" aria-hidden="true">${agentInitial}</div><b>${agent}</b>Say hi to start chatting with this Agent.</div>
      <div class="day" id="day" hidden>Today</div>
      <div id="list" role="log" aria-live="polite" aria-label="Messages"></div>
    </div>
    <div class="typing" id="typing" hidden><span class="dots"><i></i><i></i><i></i></span><span>${agent} is typing</span></div>
    <form class="compose" id="form">
      <label class="sr" for="input">Message ${agent}</label>
      <textarea id="input" rows="1" placeholder="Type a message" enterkeyhint="send" autocomplete="off"></textarea>
      <span class="ib" aria-hidden="true">${icon("<path d=\"M5 18l5-12 5 12M7 13h6M16 19l4-4\"/>")}</span>
      <span class="ib" aria-hidden="true">${icon("<circle cx=\"12\" cy=\"12\" r=\"8\"/><path d=\"M9 14a4 4 0 0 0 6 0M9.5 9.5h.01M14.5 9.5h.01\"/>")}</span>
      <span class="ib" aria-hidden="true">${icon("<path d=\"M12 5v14M5 12h14\"/>")}</span>
      <span class="sep"></span>
      <button class="ib send" type="submit" aria-label="Send">${icon("<path d=\"M4 20l17-8L4 4l2.5 8zM6.5 12H12\"/>")}</button>
    </form>
  </main>
</div>`
}

function teamsMessage(view: SimulatorView, index: number): string {
  const message = view.messages[index]
  const previous = index > 0 ? view.messages[index - 1] : undefined
  const grouped = previous !== undefined && previous.role === message.role && message.at.getTime() - previous.at.getTime() < 5 * 60_000
  const mine = message.role === "user"
  const author = mine ? `<span class="sr">${view.escape(view.config.user)}</span>` : `<b>${view.escape(view.config.agent)}</b>`
  const meta = grouped ? "" : `<div class="meta">${author}<time>${view.time(message.at)}</time></div>`
  const content = `<div class="body">${meta}<div class="bubble">${view.markdown(message.text)}</div></div>`
  if (!mine) {
    const avatar = grouped ? "<span class=\"gap\"></span>" : `<span class="av bot" aria-hidden="true">${view.escape((view.config.agent.trim().charAt(0) || "?").toUpperCase())}</span>`
    return `<div class="msg${grouped ? " g" : ""}">${avatar}${content}</div>`
  }
  const lastMine = !view.messages.slice(index + 1).some(next => next.role === "user")
  const seen = lastMine ? "<span class=\"seen\" title=\"Seen\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M8 12.5l2.5 2.5L16 9.5\"/></svg></span>" : ""
  return `<div class="msg me${grouped ? " g" : ""}">${content}${seen}</div>`
}

function teamsUpdate(view: SimulatorView, document: SimulatorDocument): void {
  const last = view.messages.at(-1)
  const plain = (text: string): string => text.replace(/^>.*$/gm, "").replace(/```[\w+-]*|[`*_>#[\]]/g, "").replace(/\s+/g, " ").trim()
  const empty = document.getElementById("empty")
  const day = document.getElementById("day")
  const typing = document.getElementById("typing")
  const preview = document.getElementById("preview")
  const previewTime = document.getElementById("preview-time")
  if (empty) empty.hidden = last !== undefined
  if (day) day.hidden = last === undefined
  if (typing) typing.hidden = !view.busy
  if (preview) preview.textContent = last ? `${last.role === "user" ? "You: " : ""}${plain(last.text)}` : "Say hi to start"
  if (previewTime) previewTime.textContent = last ? view.time(last.at) : ""
}

export const teamsSkin: SimulatorSkin = { body, css, message: teamsMessage, platform: "Microsoft Teams", update: teamsUpdate }
