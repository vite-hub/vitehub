---
title: Gmail Labeller preset
description: Label Gmail messages with ordered rules and a constrained Jev fallback.
navigation.order: 81
navigation.group: Recipes
icon: i-lucide-tags
navigation.kind: Guides
---

`labeller` labels your Gmail messages. It runs your rules in order, lets Jev pick a label when no rule matches, and runs only the message actions you allow. You give the labels and rules. ViteHub handles Gmail OAuth, Pub/Sub, history, and message methods.

```ts [server/agents/inbox.ts]
import { defineAgent } from 'vite-hub/agent'
import { labeller } from 'vite-hub/presets/labeller'

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

How a message gets its label:

- Rules run in the order you write them. A matching rule with a `label` ends there, without Jev.
- Otherwise Jev picks one declared label or `none`. Its pick needs `minConfidence` (default `0.6`).
- Unknown labels are ignored and never sent to Gmail.

Labels accept the Gmail Channel's `color`, `labelListVisibility`, and `messageListVisibility`. Colors must come from Gmail's label palette, or defining the Agent fails. See [Label colors and visibility](/docs/agents/gmail#label-colors-and-visibility).

## Synchronize the labels

`vitehub channels sync` creates your labels in Gmail and updates their color and visibility. It prints the plan, and changes Gmail only with `--apply`:

```sh
vitehub channels sync --stage production --channel gmail
vitehub channels sync --stage production --channel gmail --apply
```

Set `hideUnmanagedLabels: true` in `options` to also hide undeclared Gmail labels from the sidebar. Messages keep those labels.

## Defaults

The defaults are `dryRun: true`, `minConfidence: 0.6`, `hideUnmanagedLabels: false`, and `trashEnabled: false`. Set `dryRun: false` only when you want Gmail writes. Trash needs `trashEnabled: true` and a rule or label action with `trash: true`, or a `cleanup` rule.

## Clean up old mail

`cleanup` moves labelled mail to Trash after some days. Each rule names a declared label and an age in days. Starred mail stays. `cleanup` is empty by default, so cleanup is off.

```ts [server/agents/inbox.ts]
import { labeller } from 'vite-hub/presets/labeller'
import { defineAgent } from 'vite-hub/agent'

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
import { cleanupLabeller } from 'vite-hub/presets/labeller'
import inbox from '../agents/inbox'

export default defineSchedule({
  cron: '0 4 * * *',
  manual: true,
  async handler() {
    await cleanupLabeller(inbox, { apply: true })
  },
})
```

For each rule, `cleanupLabeller()` searches `label:"<label>" older_than:<days>d -is:starred -in:trash` and returns the message IDs. It moves them to Trash only with `apply: true`, and `dryRun: false` and `trashEnabled: true` on the Agent. Otherwise it is a preview. `trashEnabled: false` stops every move to Trash: cleanup and the `trash` action of rules and labels.

- Each run moves at most 500 messages per rule, so a large backlog takes several runs.
- `manual: true` lets `vitehub schedule run cleanup` start a run now.

## Label older mail

The Gmail Channel has history replay, so you need no script. Start with a dry run:

```sh
vitehub channels replay \
  --agent inbox \
  --channel gmail \
  --query 'in:inbox older_than:30d' \
  --limit 100 \
  --dry-run
```

Check the result before a live run. Without `--dry-run`, `channels replay` changes Gmail. Use `--force` only to repeat completed invocations on purpose. Replay uses the same Gmail history collection and trigger as new mail. The CLI prints IDs and statuses, not message bodies.

> [!WARNING]
> The preset sends size-limited message bodies to your Jev provider. Treat email as untrusted data. Gmail Channel instructions stop email content from becoming Agent instructions.
