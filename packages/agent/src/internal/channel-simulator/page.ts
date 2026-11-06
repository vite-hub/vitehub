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

// Each skin puts the switcher in its own top bar, so the links take the color of that bar.
const switcherCss = `
.switch { display: inline-flex; align-items: center; gap: 2px; min-width: 0; overflow-x: auto; font-size: 12px; line-height: 18px; font-weight: 400; white-space: nowrap; }
.switch a { padding: 0 6px; border-radius: 4px; color: inherit; text-decoration: none; opacity: .7; }
.switch a[href]:hover { opacity: 1; text-decoration: underline; }
.switch a[aria-current] { opacity: 1; font-weight: 600; }
`

/** Links to the chat pages of all simulated Channels of the Agent. Empty when the Agent has only one. */
function switcherHtml(current: string, channels: readonly SimulatorChannelLink[]): string {
  const links = channels.flatMap(({ id, kind, route }) => {
    const platform = skins.get(kind)?.platform
    if (!platform) return []
    const label = escapeHtml(id === kind ? platform : `${platform} (${id})`)
    return [id === current ? `<a aria-current="page">${label}</a>` : `<a href="${escapeHtml(route)}">${label}</a>`]
  })
  return links.length < 2 ? "" : `<nav class="switch" aria-label="Simulated Channels">${links.join("")}</nav>`
}

/**
 * The chat page of a simulated Channel, in the look of its platform, or `undefined` when the kind has no page.
 * The page POSTs AI SDK chat requests to `route` and streams the reply. It loads no network fonts, images, or scripts.
 * `channels` are the simulated Channels of the Agent, which the page links so that one page reaches all of them.
 */
export function renderChannelSimulatorPage(kind: string, options: { agent: string, channel: string, channels: readonly SimulatorChannelLink[], route: string }): string | undefined {
  const skin = skins.get(kind)
  if (!skin) return undefined
  const config: SimulatorConfig = { agent: options.agent, platform: skin.platform, route: options.route, user: simulatedChatUserId }
  // Each function is self-contained, so its source runs as is in the browser.
  const script = `(${channelSimulatorClient.toString()})(${scriptJson(config)}, { message: ${skin.message.toString()}, update: ${skin.update.toString()} }, document)`
    .replace(/<\/(script)/gi, "<\\/$1")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(`${options.agent} · ${skin.platform} simulator (unofficial)`)}</title>
<style>${skin.css}${switcherCss}</style>
</head>
<body>
${skin.body(config, switcherHtml(options.channel, options.channels))}
<script type="module">${script}</script>
</body>
</html>
`
}
