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

/**
 * The chat page of a simulated Channel, in the look of its platform, or `undefined` when the kind has no page.
 * The page POSTs AI SDK chat requests to `route` and streams the reply. It loads no network fonts, images, or scripts.
 */
export function renderChannelSimulatorPage(kind: string, options: { agent: string, route: string }): string | undefined {
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
<style>${skin.css}</style>
</head>
<body>
${skin.body(config)}
<script type="module">${script}</script>
</body>
</html>
`
}
