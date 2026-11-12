---
title: Avatar Stack
description: "Show who is in a document as overlapping avatars, with a count for the rest."
navigation.order: 30
navigation.group: Collaboration
icon: i-lucide-users
---

`AvatarStack` shows the people in a document or room as overlapping avatars. It works like the stacks of [Liveblocks](https://liveblocks.io/docs/api-reference/liveblocks-react-ui#AvatarStack), [Kibo UI](https://www.kibo-ui.com/components/avatar-stack), and [Supabase UI](https://supabase.com/ui/docs/nextjs/realtime-avatar-stack): same name, a `max` that counts the "+N" item, and one avatar per person. Pass Realtime's `people` as they are.

::example{name="AvatarStackExample" height=8}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui` or `@vite-hub/ui/avatar-stack`:

```ts
import { AvatarStack } from "@vite-hub/ui";
```

## Usage

```ts
import { AvatarStack } from "@vite-hub/ui";
import { useRealtimeTiptap } from "vite-hub/realtime/vue";

const { people } = useRealtimeTiptap("docs", "guides/welcome.md");
```

```vue
<template>
  <AvatarStack :people="people" variant="outline" />
</template>
```

## Composition

```text
AvatarStack
├── avatar-stack-item (one per person)
│   └── avatar-stack-image or avatar-stack-fallback
└── avatar-stack-count (+N)
```

## Features

- One avatar per person: entries with the same `id`, such as one person in two tabs, show once.
- An image, or the person's initials without one.
- `outline` rings each avatar in the person's presence color, to match their caret.
- Hover an avatar to see the name. Hover the count to list hidden names.
- Pass only the people who are here now. The stack has no away state: someone who left or went idle drops out.
- Default styles sit in the `components` layer of `@vite-hub/ui/styles.css`.

## Outline

Use `variant="outline"` in an editor, where each person also has a caret in their color.

::example{name="AvatarStackOutlineExample" height=8}
::

## Sizes

::example{name="AvatarStackSizesExample" height=8}
::

| Size      | Avatar |
| --------- | ------ |
| `sm`      | 24 px  |
| `default` | 32 px  |
| `lg`      | 40 px  |

## Max

`max` is the most items in the stack, counting the "+N" item, so `max` items always fit. It is at least 2, so one face always shows. `null` shows everyone.

::example{name="AvatarStackMaxExample" height=8}
::

## Accessibility

The stack has `role="group"` and an `aria-label` that names everyone, such as "3 people: Ana, Ben, Cleo". Assistive technology reads it once and skips the decorative avatars.

## API Reference

### AvatarStack

Renders a `div` with `data-slot="avatar-stack"`. Each avatar is a `span` with `data-slot="avatar-stack-item"`, and the count is a `span` with `data-slot="avatar-stack-count"`.

#### Props

| Prop      | Type                        | Default     | Description                                                           |
| --------- | --------------------------- | ----------- | --------------------------------------------------------------------- |
| `people`  | `AvatarStackPerson[]`       | Required    | `{ id, name, image?, color? }`. Entries with the same `id` show once. |
| `max`     | `number \| null`            | `3`         | Most items, counting "+N". `null` shows everyone.                     |
| `size`    | `"sm" \| "default" \| "lg"` | `"default"` | The avatar size.                                                      |
| `variant` | `"default" \| "outline"`    | `"default"` | `outline` rings each avatar in the person's `color`.                  |

## Related

- [Connection Status](/docs/ui/connection-status) and [Sync Status](/docs/ui/sync-status) show the state of the same room.
- [Carets](/docs/ui/carets) styles the editor carets in the same colors.
- [Realtime](/docs/realtime) provides `people`.
- [Collaborative Editor](/docs/ui/blocks/collaborative-editor) combines all collaboration parts with Realtime.
