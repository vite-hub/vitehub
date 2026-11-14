---
title: i18n capability
description: Let an Agent find missing translations, save drafts, and publish them, with approval before the site changes.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-languages
---

`i18n()` gives an Agent tools to read translation coverage, list the messages that a locale does not translate, save translations as drafts, and publish them. The translations live in the Workspace of [`i18n.workspace`](/docs/i18n/configure#store-translations-in-a-workspace), so a published translation is live without a deploy. Publishing asks for approval by default.

The [server API](/docs/i18n/server-api#usetranslations) covers application code. This page covers the Agent tools.

## Add the Capability

Set `i18n.workspace` to a Workspace with retained history, then add `i18n()` to the Agent:

```ts [server/agents/translator.ts]
import { defineAgent } from 'vite-hub/agent'
import { i18n } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Translate the missing messages of each locale. Keep the tone short and friendly.',
  },
  capabilities: [i18n()],
})
```

ViteHub passes `agentI18n` from `vite-hub/i18n/server` to the Capability as the `i18n` primitive when `i18n` is on. A custom route that calls `runAgent()` passes it in the runtime context as `capabilities: { i18n: agentI18n }`.

The build gives the server every message of the code, with its source text, context, and `file:line` places. The Agent sees the same messages that the site shows.

## Tools

| Tool | Operation | Default policy | Effect |
| --- | --- | --- | --- |
| `i18n_status` | `read` | `allow` | For each translated locale: `messages`, `published`, `drafted`, and `missing`. |
| `i18n_list_missing` | `read` | `allow` | Messages that a locale does not translate, published or drafted, with `source`, `context`, `origins`, and `previous`. Pages of `limit` (default 50, at most 200), with `cursor`. |
| `i18n_save_translation` | `write` | `allow` | Saves one translation to the `draft` ref, with `review: "machine"` and the Invoker as `by`. |
| `i18n_publish` | `publish` | `require-approval` | Copies every changed draft to the `published` ref in one revision. |

`previous` is the translation of an older version of the message, when its source text changed a little. The Agent can edit it instead of starting again.

`i18n_save_translation` refuses a translation that is not valid ICU MessageFormat, or that drops or adds a `{placeholder}`, a plural argument, or a `<0>` tag. It returns `ok: false` with [`I18N_INVALID_TRANSLATION`](/docs/i18n/limits-and-errors#i18n_invalid_translation) and the reason, so the Agent can fix the translation and save it again.

## Options

```ts
import { i18n } from 'vite-hub/agent/capabilities'

i18n({ operations: ['read', 'write'] })
i18n({ policy: 'require-approval' })
```

| Option | Default | Meaning |
| --- | --- | --- |
| `operations` | `["read", "write", "publish"]` | Tool groups to expose. Leave out `publish` to keep a person in charge of publishing, from your own route. |
| `policy` | save `allow`, publish `require-approval` | A decision or a function `({ name, input }) => decision` for `i18n_save_translation` and `i18n_publish`. It replaces both defaults. |

## Limits

- **A Workspace is required.** Without `i18n.workspace`, every tool fails with [`I18N_NO_WORKSPACE`](/docs/i18n/limits-and-errors#i18n_no_workspace). Translations in `locales/` change only through a commit, or through [`vitehub pull`](/docs/i18n/configure#bring-workspace-translations-into-locales) from the Workspace.
- **`i18n_publish` publishes every changed draft.** It does not pin the drafts that the approver saw. A draft that someone saves during the approval goes out with it.
- **Development reads the messages once.** In development, the server reads the messages of the code when it starts. Restart it to show a message that you added after that.
