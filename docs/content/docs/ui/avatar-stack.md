---
title: Avatar Stack
description: "Show who is in a document as overlapping avatars, with a count for the rest."
navigation.order: 26
navigation.group: Collaboration
icon: i-ph-users-three-light
---

`AvatarStack` shows the people in a document or a room as overlapping avatars. It follows the presence stacks of [Liveblocks](https://liveblocks.io/docs/api-reference/liveblocks-react-ui#AvatarStack), [Kibo UI](https://www.kibo-ui.com/components/avatar-stack), and [Supabase UI](https://supabase.com/ui/docs/nextjs/realtime-avatar-stack): the same name, a `max` that counts the "+N" item, and one avatar per person. Pass Realtime's `people` as they are.

::component-preview{name="AvatarStackExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/avatar-stack`:

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

- One avatar per person: entries with the same `id`, such as a person in two tabs, show once.
- `max` counts the "+N" item, so `max` items always fit. `null` shows everyone.
- An image, or the person's initials when there is no image.
- The `outline` variant rings each avatar in the person's presence color, so each face matches its caret.
- Hovering an avatar shows the name. Hovering the count lists the hidden names.
- The default styles are in the `components` layer of `@vite-hub/ui/styles.css`.

## Outline

Use `variant="outline"` in an editor, where each person also has a caret in their color.

::component-preview{name="AvatarStackOutlineExample"}
::

## Sizes

::component-preview{name="AvatarStackSizesExample"}
::

| Size      | Avatar |
| --------- | ------ |
| `sm`      | 24 px  |
| `default` | 32 px  |
| `lg`      | 40 px  |

## Max

`max` is the most items in the stack, counting the "+N" item. `max` is at least 2, so the stack shows at least one face.

::component-preview{name="AvatarStackMaxExample"}
::

## API reference

### AvatarStack

Renders a `div` with `data-slot="avatar-stack"`. Each avatar is a `span` with `data-slot="avatar-stack-item"`, and the count is a `span` with `data-slot="avatar-stack-count"`.

#### Props

| Prop      | Type                             | Default     | Description                                                                 |
| --------- | -------------------------------- | ----------- | --------------------------------------------------------------------------- |
| `people`  | `AvatarStackPerson[]`            | Required    | The people, `{ id, name, image?, color? }`. Entries with the same `id` show once. |
| `max`     | `number \| null`                 | `3`         | The most items to show, counting the "+N" item. `null` shows everyone.      |
| `size`    | `"sm" \| "default" \| "lg"`      | `'default'` | The avatar size.                                                            |
| `variant` | `"default" \| "outline"`         | `'default'` | `outline` rings each avatar in the person's `color`.                        |

## Accessibility

The stack has `role="group"` and an `aria-label` that names everyone, for example "3 people: Ana, Ben, Cleo". Assistive technology reads it once and skips the individual avatars, which are decorative.

## Related

- [Connection Status](/docs/ui/connection-status) and [Sync Status](/docs/ui/sync-status) show the state of the same room.
- [Carets](/docs/ui/carets) styles the editor carets in the same colors.
- [Realtime](/docs/realtime) provides `people`.
