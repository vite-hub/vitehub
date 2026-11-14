---
title: Where does a UI bug or feature belong?
description: "Find the layer that owns a ViteHub UI bug or feature: its package, its docs page, and the test that catches it."
navigation.title: Where does it belong?
navigation.order: 3
navigation.group: Start
icon: i-lucide-signpost
---

Each bug or feature belongs to one layer, and each layer has one test that catches it. Fix a problem at the first layer where it is wrong. If no test caught it, the fix adds one. Each test name links to its file.

Name the layer in the issue or the pull request title, such as `fix(kit): keep the last tag after Backspace`.

## Layers

| Layer | Owner | Docs | Test that catches it | A bug goes here when |
| --- | --- | --- | --- | --- |
| Behavior | `@ui-sdk/vue` | [ui-sdk docs](https://ui-sdk.dev/docs) | [Parity harness](https://github.com/vite-hub/vitehub/blob/main/packages/ui/test/browser/parity.browser.mjs) | Focus, keyboard, ARIA, or state is wrong with no styles loaded. |
| Gap parts | `@vite-hub/kit` | [Kit parts](https://github.com/vite-hub/vitehub/tree/main/packages/kit#components-we-add) | [TagsInput test](https://github.com/vite-hub/vitehub/blob/main/packages/kit/test/tags-input.test.ts) | A part that ui-sdk does not have, such as `TagsInput`, is wrong. |
| Look | `@vite-hub/kit/styles` | [Kit styles](https://github.com/vite-hub/vitehub/tree/main/packages/kit#styles) | [Style check](https://github.com/vite-hub/vitehub/blob/main/packages/kit/test/browser/styles.browser.mjs) | A part works but looks wrong, or a token is wrong in dark mode. |
| Forms | `@vite-hub/forms` | [Forms in Vue](/docs/forms/vue) | [Surface test](https://github.com/vite-hub/vitehub/blob/main/packages/forms/test/every-surface.test.ts) | A field or an error is wrong, or a surface gives a different error. |
| Specs | `vite-hub/agent/ui` | [Agent UI](https://github.com/vite-hub/vitehub/blob/main/packages/agent/README.md#ui-that-an-agent-sends) | [Catalog test](https://github.com/vite-hub/vitehub/blob/main/packages/agent/test/ui-catalog.test.ts) | The catalog refuses a good spec, accepts a bad one, or draws it wrong. |
| Page work | `vite-hub/agent/page` | [Page](/docs/agents/capabilities/page) | [Page test](https://github.com/vite-hub/vitehub/blob/main/packages/agent/test/page-capability.test.ts) | The Agent cannot change the open page, a rule does not apply, or undo fails. |
| Chat surfaces | `vite-hub/agent/channels` | [Channels](/docs/agents/channels) | [Simulator test](https://github.com/vite-hub/vitehub/blob/main/packages/agent/test/channel-simulation.test.ts) | A card, a button, or a modal is wrong in a chat app or the web chat. |
| AI components | `@vite-hub/ui` | [AI components](/docs/ui/ai-components) | [UI tests](https://github.com/vite-hub/vitehub/tree/main/packages/ui/test) | A chat, session, trace, or code view part is wrong. |
| Docs and playground | `docs/content/docs/ui` | [Playground](/playground?template=ui) | [Section test](https://github.com/vite-hub/vitehub/blob/main/docs/test/ui-section.test.ts) and the snippet gate | An example fails, a link is broken, or the playground does not start. |

## Common symptoms

- **A dialog does not give focus back to its trigger after Escape.** Behavior. Check it with no styles loaded, add a parity script, and send the fix as a draft on the [ui-sdk fork](https://github.com/onmax/ui-sdk). ViteHub does not patch ui-sdk.
- **Backspace in an empty `TagsInput` removes no tag.** Gap parts.
- **A menu is too narrow, or a border is invisible in dark mode.** Look. Change the token or the family rule, not the part.
- **The web form accepts a value that the Slack modal refuses.** Forms.
- **The model sends the same bad spec again after a diagnostic.** Specs. Make the `fix` text of the diagnostic clearer.
- **The Agent says that it changed a field, but the page shows the old value.** Page work.
- **The approval card has no buttons in Teams.** Chat surfaces.
- **The chat jumps to the top while a reply streams.** AI components.
- **A code block on this site does not type-check, or the playground shows an empty page.** Docs and playground.

## Add a part

Go through the layers in order, and stop at the first one that has the part:

1. Use the ui-sdk part when it exists, such as `@ui-sdk/vue/rating`.
2. Add a kit part only when it owns state, focus, ARIA, or announcements, and no ui-sdk part does the same job. Build it on `definePrimitive` from `@ui-sdk/core`.
3. Add its rules to the style family, by `data-slot` and state attributes.
4. Add a catalog entry only when Agents send it in a spec.
5. Document it, and add it to the playground when people will try it.
