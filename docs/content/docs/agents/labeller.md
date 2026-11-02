---
title: Gmail Labeller preset
description: Label Gmail messages with ordered rules and a constrained Jev fallback.
navigation.order: 81
navigation.group: Recipes
icon: i-lucide-tags
navigation.kind: Guides
---

`labeller` composes the Gmail Channel with ordered rules, a constrained Jev label choice, and allowlisted message actions. The application supplies labels and rules; Gmail OAuth, Pub/Sub, history, and message methods remain owned by ViteHub.

```ts [server/agents/inbox.ts]
import { defineAgent } from 'vite-hub/agent'
import { labeller } from '@vite-hub/presets/labeller'

export default defineAgent({
  extends: labeller,
  options: {
    labels: {
      Work: {
        description: 'Colleagues and work systems',
        color: { textColor: '#000000', backgroundColor: '#fad165' },
      },
      Receipts: {
        description: 'Purchases and invoices',
        color: { textColor: '#ffffff', backgroundColor: '#16a766' },
      },
      Newsletters: { description: 'Mailing lists and product updates' },
    },
    rules: {
      receipts: {
        from: ['/billing\\./i'],
        subject: ['invoice', 'receipt'],
        label: 'Receipts',
        archive: true,
      },
    },
    actions: { Newsletters: { archive: true } },
  },
})
```

Rules are evaluated in object insertion order. A matching rule with a `label` finishes without calling Jev; messages without a matching rule use Jev to choose one declared label or `none`. Model labels require the configured `minConfidence` (default `0.6`). Unknown labels are ignored and never sent to Gmail.

Labels accept the Gmail Channel's `color`, `labelListVisibility`, and `messageListVisibility` settings. Colors must come from Gmail's label palette; the preset fails when you define the Agent with another color. See [Label colors and visibility](/docs/agents/gmail#label-colors-and-visibility).

## Synchronize the labels

`vitehub channels sync` creates the declared labels and updates their color and visibility in Gmail. It prints the plan first and changes Gmail only with `--apply`:

```sh
vitehub channels sync --stage production --channel gmail
vitehub channels sync --stage production --channel gmail --apply
```

Set `hideUnmanagedLabels: true` in `options` to also hide the Gmail labels that `labels` does not declare from the sidebar. Messages keep those labels.

## Defaults

The preset defaults to `dryRun: true`, `minConfidence: 0.6`, `hideUnmanagedLabels: false`, and `trashEnabled: false`. Set `dryRun: false` only when the Gmail writes are intended. Enabling trash requires both `trashEnabled: true` and a rule or label action with `trash: true`.

## Label older mail

The Gmail Channel already exposes history replay, so no application script is needed. Start with a dry run:

```sh
vitehub channels replay \
  --agent inbox \
  --channel gmail \
  --query 'in:inbox older_than:30d' \
  --limit 100 \
  --dry-run
```

Inspect the result before any live run. `channels replay` is live when `--dry-run` is absent, so remove that flag only for an intentional apply. `--force` is only for intentionally repeating completed invocations. Replay uses the same Gmail history collection and trigger as new mail, and the CLI reports IDs and statuses without printing message bodies.

The preset sends bounded message bodies to the configured Jev provider. Treat email as untrusted data; Gmail Channel instructions explicitly prevent email content from becoming Agent instructions.
