---
title: Chat Session
description: Present an application-owned chat session with a title and the same AI SDK message contract.
navigation.order: 25
navigation.group: Chat
icon: i-lucide-messages-square
---

`ChatSession` wraps a saved conversation. It shows a title, a `Chat` that fills the space, and an optional footer for the prompt or session actions. AI SDK has no session schema, so `ViteHubUISession` stays small: an ID, messages, an optional title and timestamps, and your metadata.

::example{name="SessionExample" flush height=30}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui`:

```ts
import { ChatSession } from "@vite-hub/ui";
```

## Usage

```ts fragment
import { ChatSession, type ViteHubUISession } from "@vite-hub/ui";

const session: ViteHubUISession = {
  id: "session_01",
  title: "Production deploy failure",
  messages,
  metadata: { projectId: "project_01" },
};
```

```vue
<ChatSession :session :status />
```

## Composition

`ChatSession` wraps a [Chat](/docs/ui/chat). Slots other than `header` and `footer` go to it.

```text
ChatSession (section)
├── header with an h2 title, or the header slot
├── Chat
│   └── ChatMessage, one for each message
│       └── MessageParts
└── footer slot
```

## Features

- Renders a `ViteHubUISession` with its title and messages.
- Leaves loading, saving, and authorization to your app.
- Takes your own metadata on the session.

## Session Ownership

The component does not fetch, change, or save the session. Load it in your app, add metadata as needed, and check tenancy and authorization there.

## Header and Footer

The `header` slot replaces the title. The `footer` slot adds content under the chat. Both receive `{ session }`.

::example{name="SessionSlotsExample" flush height=24}
::

## Accessibility

- The section is named by the session title, or **Agent session** without one. Pass `aria-label` to change it.
- The default title is an `<h2>`. Keep the heading level correct in your `header` slot.
- The chat inside behaves like [Chat](/docs/ui/chat#accessibility) for keyboard and screen readers.

## API Reference

### ChatSession

Renders a `<section>` with a title, a `Chat`, and an optional footer.

#### Props

| Prop      | Type                              | Default   | Description                                 |
| --------- | --------------------------------- | --------- | ------------------------------------------- |
| `session` | `ViteHubUISession<UIMessage>`     | Required  | The session to render.                      |
| `status`  | `ChatStatus`                      | `"ready"` | AI SDK chat status, passed to `Chat`.       |

Other attributes go to the root `<section>`. It has a `data-session-id` attribute.

#### Slots

| Slot        | Scope         | Description                                                    |
| ----------- | ------------- | -------------------------------------------------------------- |
| `header`    | `{ session }` | Replaces the default title header.                             |
| `footer`    | `{ session }` | Content under the chat. |
| Other slots |               | Passed to `Chat`, such as `message` or `composer`. |

#### Types

```ts
import type { UIMessage } from "ai"

interface ViteHubUISession<Message extends UIMessage = UIMessage> {
  id: string;
  messages: readonly Message[];
  title?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  metadata?: unknown;
}
```

`ViteHubUIMessage<Metadata, DataParts, Tools>` is an alias of AI SDK `UIMessage` with the same type parameters.

## Related

- [Chat](/docs/ui/chat) renders the messages.
- [Chat app block](/docs/ui/blocks/chat-app) switches between sessions.
