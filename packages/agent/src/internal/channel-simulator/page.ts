import { simulatedChatUserId } from "../channel-simulation.ts"
import { channelSimulatorClient } from "./client.ts"
import { discordSkin } from "./discord.ts"
import { escapeHtml } from "./html.ts"
import { slackSkin } from "./slack.ts"
import { teamsSkin } from "./teams.ts"
import { telegramSkin } from "./telegram.ts"

import type { SimulatorConfig, SimulatorSkin } from "./types.ts"

const skins: ReadonlyMap<string, SimulatorSkin> = new Map([
  ["discord", discordSkin],
  ["slack", slackSkin],
  ["teams", teamsSkin],
  ["telegram", telegramSkin],
])

/** JSON that is safe inside a `<script>` element: `<` cannot start `</script>` or `<!--`. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

/** A simulated Channel of the Agent and the path of its chat page. */
export interface SimulatorChannelLink {
  id: string
  kind: string
  route: string
}

// The page owns the strip with the unofficial label, the failure notice, and the busy send button, so every skin
// shows them the same way. Each skin sets the `--sim-*` colors, lays out `.sim-root`, and can override these rules.
const sharedCss = `
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
.sim-strip { flex: none; display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 8px; font-size: 11px; line-height: 14px; white-space: nowrap; background: var(--sim-strip-bg); color: var(--sim-strip-text); }
.sim-strip .sim-label { flex: none; }
[data-embed] .sim-strip { height: 20px; }
.sim-root { flex: 1; min-height: 0; }
.sim-error { display: flex; align-items: center; gap: 12px; margin: 8px 16px; padding: 8px 12px; border: 1px solid var(--sim-line); border-left: 4px solid #d93f3f; border-radius: 6px; background: var(--sim-surface); color: var(--sim-text); font-size: 14px; line-height: 20px; overflow-wrap: anywhere; }
.sim-error:empty { display: none; }
.sim-error button { flex: none; margin-left: auto; min-height: 32px; padding: 0 12px; border: 1px solid currentColor; border-radius: 6px; background: none; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.sim-error button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
form[aria-busy="true"] .send { opacity: .4; cursor: progress; }
@media (pointer: coarse) { .sim-error button { min-height: 44px; } }
.sim-switch { display: flex; align-items: center; min-width: 0; margin-left: auto; overflow-x: auto; }
.sim-switch .sim-links { display: flex; }
.sim-switch a { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; color: inherit; text-decoration: none; }
.sim-switch a[href]:hover { text-decoration: underline; }
.sim-switch a[aria-current] { font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
.sim-switch select { display: none; max-width: 100%; height: 20px; padding: 0 2px; border: 1px solid currentColor; border-radius: 4px; background: none; color: inherit; font: inherit; }
.sim-switch select option { color: initial; }
@media (pointer: coarse) { .sim-strip:has(.sim-switch) { height: auto; min-height: 44px; } .sim-switch a, .sim-switch select { min-height: 44px; } }
@media (max-width: 480px) { .sim-switch .sim-links { display: none; } .sim-switch select { display: block; } .sim-strip:has(.sim-switch) .sim-optional { display: none; } }
[data-embed] .sim-switch { display: none; }
[data-embed] .sim-strip .sim-optional { display: inline; }
`

// Runs before the first paint, so an embedded page never shows its app chrome.
const embedScript = "<script>if(self!==top)document.documentElement.dataset.embed=\"\"</script>"

/**
 * Links to the chat pages of all simulated Channels of the Agent, in the strip. A narrow screen gets a native select.
 * Empty when the Agent has only one. An embedded page hides it, because the Console lists the Channels.
 */
function switcherHtml(current: string, channels: readonly SimulatorChannelLink[]): string {
  const entries = channels.flatMap(({ id, kind, route }) => {
    const platform = skins.get(kind)?.platform
    return platform ? [{ current: id === current, label: escapeHtml(id === kind ? platform : `${platform} (${id})`), route: escapeHtml(route) }] : []
  })
  if (entries.length < 2) return ""
  const links = entries.map(entry => entry.current ? `<a aria-current="page">${entry.label}</a>` : `<a href="${entry.route}">${entry.label}</a>`).join("")
  const options = entries.map(entry => `<option value="${entry.route}"${entry.current ? " selected" : ""}>${entry.label}</option>`).join("")
  return `<nav class="sim-switch" aria-label="Simulated Channels"><span class="sim-links">${links}</span><select aria-label="Simulated Channel" onchange="location.href=this.value">${options}</select></nav>`
}

/**
 * The chat page of a simulated Channel, in the look of its platform, or `undefined` when the kind has no page.
 * The page POSTs AI SDK chat requests to `route` and streams the reply. It loads no network fonts, images, or scripts.
 * `channels` are the simulated Channels of the Agent, which the page links so that one page reaches all of them.
 * In an iframe, such as the Console, the page hides the fake app chrome and tells its parent when a reply ends.
 */
export function renderChannelSimulatorPage(kind: string, options: { agent: string, channel: string, channels: readonly SimulatorChannelLink[], route: string }): string | undefined {
  const skin = skins.get(kind)
  if (!skin) return undefined
  const config: SimulatorConfig = { agent: options.agent, platform: skin.platform, route: options.route, user: simulatedChatUserId }
  // Each function is self-contained, so its source runs as is in the browser.
  const script = `(${channelSimulatorClient.toString()})(${scriptJson(config)}, { message: ${skin.message.toString()}, update: ${skin.update.toString()} }, document, window)`
    .replace(/<\/(script)/gi, "<\\/$1")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(`${options.agent} · ${skin.platform} simulator (unofficial)`)}</title>
${embedScript}
<style>${sharedCss}${skin.css}</style>
</head>
<body>
<div class="sim-strip"><span class="sim-label">Unofficial <span class="sim-optional">simulator </span>· not affiliated with ${escapeHtml(skin.platform)}</span>${switcherHtml(options.channel, options.channels)}</div>
<div class="sim-root">
${skin.body(config)}
</div>
<script type="module">${script}</script>
</body>
</html>
`
}
