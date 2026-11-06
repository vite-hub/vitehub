import { escapeHtml, initialHtml } from "./html.ts"

import type { SimulatorConfig, SimulatorDocument, SimulatorSkin, SimulatorView } from "./types.ts"

// Inspired by a Slack direct message with an app. It follows the system theme. No Slack logo, font, or asset is used.
const css = `
:root { --frame:#350d36; --side:#3f0e40; --side-text:rgb(255 255 255 / .7); --side-strong:#fff; --side-hover:rgb(255 255 255 / .08); --sel:#1164a3;
  --main:#fff; --text:#1d1c1d; --muted:#616061; --line:rgb(29 28 29 / .13); --hover:#f8f8f8; --link:#1264a3; --tag:rgb(29 28 29 / .13);
  --code:rgb(29 28 29 / .04); --code-text:#e01e5a; --quote:#dddddd; --field:rgb(29 28 29 / .3); --send:#007a5a; --agent:#5b6ee1; --user:#c75a1b; color-scheme: light;
  --sim-strip-bg: var(--frame); --sim-strip-text: rgb(255 255 255 / .75); --sim-surface: var(--main); --sim-text: var(--text); --sim-line: var(--line); }
@media (prefers-color-scheme: dark) { :root { --frame:#121016; --side:#19171d; --side-hover:rgb(255 255 255 / .06);
  --main:#1a1d21; --text:#d1d2d3; --muted:#ababad; --line:rgb(232 232 232 / .13); --hover:#222529; --link:#1d9bd1; --tag:rgb(232 232 232 / .13);
  --code:rgb(232 232 232 / .04); --code-text:#e8912d; --quote:#4a4b4e; --field:rgb(232 232 232 / .3); color-scheme: dark; } }
* { box-sizing: border-box; }
body { font: 15px/22px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--frame); -webkit-font-smoothing: antialiased; }
.sim-root { display: grid; grid-template-rows: 40px minmax(0, 1fr); }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.top { display: grid; grid-template-columns: 1fr minmax(0, 560px) 1fr; align-items: center; gap: 16px; padding: 0 12px; }
.top .search { height: 26px; border-radius: 6px; background: rgb(255 255 255 / .16); color: rgb(255 255 255 / .8); display: flex; align-items: center; gap: 8px; padding: 0 10px; font-size: 13px; }
.top .search svg { width: 14px; height: 14px; }
.app { display: grid; grid-template-columns: 70px 260px minmax(0, 1fr); min-height: 0; padding: 0 4px 4px 0; }
.rail { display: flex; flex-direction: column; align-items: center; gap: 12px; padding-top: 8px; color: #fff; }
.rail .ws { width: 36px; height: 36px; border-radius: 8px; background: #fff; color: var(--frame); display: grid; place-items: center; font-weight: 800; font-size: 18px; }
.rail .tab { display: grid; justify-items: center; gap: 2px; font-size: 11px; font-weight: 600; line-height: 14px; }
.rail .tab i { width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center; }
.rail .tab.on i { background: rgb(255 255 255 / .2); }
.panel { display: contents; }
.side { background: var(--side); color: var(--side-text); border-radius: 8px 0 0 8px; border: 1px solid rgb(255 255 255 / .06); border-right: 0; overflow: hidden; display: flex; flex-direction: column; }
.side-h { height: 49px; flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 12px 0 16px; color: var(--side-strong); }
.side-h b { font-size: 18px; font-weight: 800; display: flex; align-items: center; gap: 4px; }
.side-h b svg { width: 14px; height: 14px; }
.side-h span { width: 32px; height: 32px; border-radius: 6px; display: grid; place-items: center; background: rgb(255 255 255 / .12); }
.side nav { padding: 8px 8px; overflow: auto; }
.side h2 { display: flex; align-items: center; gap: 6px; margin: 12px 0 2px; padding: 0 8px; font-size: 15px; font-weight: 500; }
.side h2 svg { width: 12px; height: 12px; }
.item { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px 0 16px; border-radius: 6px; white-space: nowrap; overflow: hidden; }
.item .label { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item .hash { width: 20px; text-align: center; opacity: .9; }
.item.on { background: var(--sel); color: #fff; font-weight: 600; }
.av { flex: none; position: relative; width: 20px; height: 20px; border-radius: 4px; background: var(--agent); color: #fff; display: grid; place-items: center; font-size: 11px; font-weight: 700; user-select: none; }
.av.user { background: var(--user); }
.av.dot::after { content: ""; position: absolute; right: -3px; bottom: -3px; width: 9px; height: 9px; border-radius: 50%; background: #2bac76; border: 2px solid var(--ring, var(--side)); }
.item.on .av.dot::after { --ring: var(--sel); }
.tag { display: inline-block; margin-left: 4px; padding: 0 3px; border-radius: 2px; background: var(--tag); color: var(--muted); font-size: 10px; font-weight: 700; line-height: 15px; vertical-align: 1px; }
.item .tag { background: rgb(255 255 255 / .2); color: inherit; }
main { background: var(--main); border-radius: 0 8px 8px 0; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
header { flex: none; border-bottom: 1px solid var(--line); padding: 0 20px; }
header .title { height: 49px; display: flex; align-items: center; gap: 8px; }
header .title .av { width: 24px; height: 24px; font-size: 12px; --ring: var(--main); }
header h1 { min-width: 0; margin: 0; font-size: 18px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
header .title .tag { flex: none; }
header .tabs { display: flex; gap: 20px; font-size: 13px; color: var(--muted); }
header .tabs span { padding-bottom: 8px; }
header .tabs .on { color: var(--text); font-weight: 600; box-shadow: inset 0 -2px 0 var(--text); }
.scroll { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
.history { margin-top: auto; padding-bottom: 12px; }
.intro { padding: 20px 20px 8px; }
.intro .av { width: 72px; height: 72px; border-radius: 12px; font-size: 32px; }
.intro h2 { margin: 12px 0 4px; font-size: 22px; line-height: 28px; font-weight: 800; }
.intro p { margin: 0; color: var(--muted); max-width: 560px; }
.intro p b { color: var(--link); font-weight: 400; }
.day { position: relative; margin: 16px 0 4px; height: 28px; display: grid; place-items: center; }
.day::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; border-top: 1px solid var(--line); }
.day span { position: relative; padding: 0 16px; height: 28px; line-height: 26px; border: 1px solid var(--line); border-radius: 24px; background: var(--main); font-size: 13px; font-weight: 700; }
.day[hidden] { display: none; }
.row { position: relative; padding: 4px 20px 4px 72px; }
.row:hover { background: var(--hover); }
.row.head { margin-top: 4px; padding-top: 8px; min-height: 52px; }
.row .av { position: absolute; left: 20px; top: 8px; width: 36px; height: 36px; border-radius: 8px; font-size: 16px; }
.row .name { font-weight: 800; }
.row time { margin-left: 6px; font-size: 12px; color: var(--muted); }
.row .gutter { position: absolute; left: 0; width: 64px; margin: 0; text-align: right; line-height: 22px; visibility: hidden; }
.row:hover .gutter { visibility: visible; }
.body { overflow-wrap: anywhere; }
.body p, .body ul, .body ol, .body pre, .body blockquote { margin: 0; }
.body > * + * { margin-top: 4px; }
.body ul, .body ol { padding-left: 28px; }
.body a { color: var(--link); text-decoration: none; }
.body a:hover { text-decoration: underline; }
.body code { font: 12px/18px ui-monospace, Menlo, Consolas, monospace; color: var(--code-text); background: var(--code); border: 1px solid var(--line); border-radius: 3px; padding: 2px 3px 1px; }
.body pre { margin-top: 4px; background: var(--code); border: 1px solid var(--line); border-radius: 4px; padding: 8px; overflow-x: auto; }
.body pre code { display: block; color: var(--text); background: none; border: 0; padding: 0; white-space: pre-wrap; }
.body blockquote { border-left: 4px solid var(--quote); padding-left: 16px; }
.compose { flex: none; margin: 0 20px; border: 1px solid var(--field); border-radius: 8px; background: var(--main); }
.compose:focus-within { border-color: var(--muted); box-shadow: 0 0 0 1px var(--muted); }
.compose .bar { display: flex; gap: 2px; padding: 4px 6px 0; color: var(--muted); }
.compose .bar span, .compose .tools span { width: 28px; height: 28px; border-radius: 4px; display: grid; place-items: center; font-size: 14px; }
.compose .bar .sep { width: 1px; height: 20px; margin: 4px 4px; background: var(--line); }
.compose textarea { display: block; width: 100%; min-height: 40px; max-height: 200px; padding: 9px 12px; border: 0; outline: 0; resize: none; background: none; color: var(--text); font: inherit; }
.compose textarea::placeholder { color: var(--muted); }
.compose .tools { display: flex; align-items: center; gap: 2px; padding: 0 6px 6px; color: var(--muted); }
.compose .tools .plus { border-radius: 50%; background: var(--line); }
.compose .send { margin-left: auto; width: 32px; height: 28px; border-radius: 4px; display: grid; place-items: center; background: var(--send); color: #fff; }
.compose:has(textarea:placeholder-shown) .send { background: none; color: var(--muted); }
.compose .send svg { fill: currentColor; stroke: none; }
.typing { height: 24px; flex: none; padding: 2px 20px 0; font-size: 12px; color: var(--muted); }
.typing b { font-weight: 700; }
@media (max-width: 760px) { .sim-root { grid-template-rows: minmax(0, 1fr); } .app { grid-template-columns: minmax(0, 1fr); padding: 0; } .top, .rail, .side { display: none; } main { border-radius: 0; } }
[data-embed] .sim-root { grid-template-rows: minmax(0, 1fr); }
[data-embed] .app { grid-template-columns: minmax(0, 1fr); padding: 0; }
[data-embed] .top, [data-embed] .rail, [data-embed] .side { display: none; }
[data-embed] main { border-radius: 0; }
@media (pointer: coarse) { .compose textarea { font-size: 16px; } .compose .send { width: 44px; height: 44px; } }
`

function body(config: SimulatorConfig): string {
  const agent = escapeHtml(config.agent)
  const user = escapeHtml(config.user)
  const agentInitial = initialHtml(config.agent)
  const workspace = "ViteHub dev"
  const caret = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M6 9l6 6 6-6\"/></svg>"
  return `<header class="top">
  <span></span>
  <div class="search" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>Search ${workspace}</div>
</header>
<div class="app">
  <nav class="rail" aria-hidden="true">
    <div class="ws">V</div>
    <div class="tab on"><i><svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/></svg></i>Home</div>
    <div class="tab"><i><svg viewBox="0 0 24 24"><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z"/></svg></i>DMs</div>
    <div class="tab"><i><svg viewBox="0 0 24 24"><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20.5a2 2 0 0 0 4 0"/></svg></i>Activity</div>
    <div class="tab"><i><svg viewBox="0 0 24 24"><path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="2.5"/></svg></i>More</div>
  </nav>
  <aside class="side" aria-label="Sidebar">
    <div class="side-h"><b>${workspace}${caret}</b><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-8M18 3l3 3-8 8h-3v-3z"/></svg></span></div>
    <nav>
      <h2>${caret}Channels</h2>
      <div class="item"><span class="hash">#</span>general</div>
      <div class="item"><span class="hash">#</span>random</div>
      <h2>${caret}Direct messages</h2>
      <div class="item"><span class="av user dot" aria-hidden="true">${initialHtml(config.user)}</span>${user} <span style="opacity:.6">you</span></div>
      <h2>${caret}Apps</h2>
      <div class="item on" aria-current="page"><span class="av dot" aria-hidden="true">${agentInitial}</span><span class="label">${agent}</span></div>
    </nav>
  </aside>
  <main>
    <header>
      <div class="title"><span class="av dot" aria-hidden="true">${agentInitial}</span><h1>${agent}</h1><span class="tag">APP</span></div>
      <div class="tabs" aria-hidden="true"><span class="on">Messages</span><span>About</span></div>
    </header>
    <div class="scroll" id="scroll">
      <div class="history">
        <div class="intro"><div class="av" aria-hidden="true">${agentInitial}</div><h2>${agent}<span class="tag">APP</span></h2>
          <p>This is the very beginning of your direct message history with <b>@${agent}</b>. Messages you send here go to the Agent through its Slack Channel.</p></div>
        <div class="day" id="day" hidden><span>Today</span></div>
        <div id="list" role="log" aria-live="polite" aria-label="Messages"></div>
      </div>
    </div>
    <form class="compose" id="form">
      <div class="bar" aria-hidden="true"><span><b>B</b></span><span><i>I</i></span><span><s>S</s></span><span class="sep"></span><span><svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg></span><span><svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" stroke-width="2"/></svg></span><span class="sep"></span><span>&lt;/&gt;</span></div>
      <label for="input" class="sr">Message ${agent}</label>
      <textarea id="input" rows="1" placeholder="Message ${agent}" enterkeyhint="send" autocomplete="off"></textarea>
      <div class="tools"><span class="plus" aria-hidden="true">+</span><span aria-hidden="true">Aa</span><span aria-hidden="true">@</span>
        <button class="send" type="submit" aria-label="Send now"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.4l17.4-7.5a1 1 0 0 0 0-1.8L3.4 3.6a.7.7 0 0 0-1 .8L4.5 11l9 1-9 1-2.1 6.6a.7.7 0 0 0 1 .8z"/></svg></button></div>
    </form>
    <div class="typing" id="typing" aria-hidden="true"></div>
  </main>
</div>`
}

function slackMessage(view: SimulatorView, index: number): string {
  const message = view.messages[index]
  const previous = index > 0 ? view.messages[index - 1] : undefined
  const head = previous === undefined || previous.role !== message.role || message.at.getTime() - previous.at.getTime() > 5 * 60_000
  const agent = message.role === "assistant"
  const name = agent ? view.config.agent : view.config.user
  const initial = view.escape((name.trim().charAt(0) || "?").toUpperCase())
  const stamp = message.at.toISOString()
  const meta = head
    ? `<div class="av${agent ? "" : " user"}" aria-hidden="true">${initial}</div><div><span class="name">${view.escape(name)}</span>${agent ? "<span class=\"tag\">APP</span>" : ""}<time datetime="${stamp}">${view.time(message.at)}</time></div>`
    : `<time class="gutter" datetime="${stamp}">${view.time(message.at)}</time>`
  return `<div class="row${head ? " head" : ""}">${meta}<div class="body">${view.markdown(message.text)}</div></div>`
}

function slackUpdate(view: SimulatorView, document: SimulatorDocument): void {
  const day = document.getElementById("day")
  const typing = document.getElementById("typing")
  if (day) day.hidden = view.messages.length === 0
  if (typing) typing.innerHTML = view.busy ? `<b>${view.escape(view.config.agent)}</b> is typing…` : ""
}

export const slackSkin: SimulatorSkin = { body, css, message: slackMessage, platform: "Slack", update: slackUpdate }
