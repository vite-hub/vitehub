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
      Work: { description: 'Colleagues and work systems' },
      Receipts: { description: 'Purchases and invoices' },
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

The preset defaults to `dryRun: true`, `minConfidence: 0.6`, and `trashEnabled: false`. Set `dryRun: false` only when the Gmail writes are intended. Enabling trash requires both `trashEnabled: true` and a rule or label action with `trash: true`.

## Clean up old mail

`cleanup` moves labelled mail to Trash after a number of days. Each rule names a declared label and an age in days. Starred mail stays. Cleanup is off by default: `cleanup` is empty.

```ts [server/agents/inbox.ts]
export default defineAgent({
  extends: labeller,
  options: {
    labels: { Promotions: { description: 'Sales and offers' } },
    cleanup: {
      promotions: { label: 'Promotions', olderThan: 14 },
    },
  },
})
```

Run the rules from a daily [Schedule](/docs/schedule) with `cleanupLabeller()`:

```ts [server/schedules/cleanup.ts]
import { defineSchedule } from 'vite-hub/schedule'
import { cleanupLabeller } from '@vite-hub/presets/labeller'
import inbox from '../agents/inbox'

export default defineSchedule({
  cron: '0 4 * * *',
  manual: true,
  async handler() {
    await cleanupLabeller(inbox, { apply: true })
  },
})
```

`cleanupLabeller()` searches `label:"<label>" older_than:<days>d -is:starred -in:trash` for each rule and returns the matching message IDs. It moves them to Trash only when you pass `apply: true` and the Agent has `dryRun: false`. Otherwise the result is a preview. `trashEnabled` does not affect cleanup; it gates only the `trash` action of rules and labels.

Each run moves at most 500 messages per rule, so a large backlog takes several runs. `manual: true` lets `vitehub schedule run cleanup` start a run now. To use the rules with another Gmail Channel, call `cleanupGmailChannel(channel, { rules, apply })` from `vite-hub/agent/channels`.

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
