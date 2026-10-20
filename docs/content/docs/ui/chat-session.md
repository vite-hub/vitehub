---
title: Chat Session
description: Present an application-owned chat session with a title and the same AI SDK message contract.
navigation.order: 25
navigation.group: Chat
icon: i-ph-chats-circle-light
---

`ChatSession` is the small shell around a saved conversation. It gives the Console a title, a `Chat` that fills the available space, and an optional footer for the prompt or session actions. AI SDK does not define a session schema, so `ViteHubUISession` stays small: an ID, messages, an optional title and timestamps, and your own metadata.

::component-preview{name="SessionExample" flush}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/chat-session`:

```ts
import { ChatSession } from "@vite-hub/ui";
```

## Usage

```ts
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

`ChatSession` wraps a [Chat](/docs/ui/chat). Slots other than `header` and `footer` go to that `Chat`.

```text
ChatSession (section)
├── header with an h2 title, or the header slot
├── Chat
│   └── ChatMessage, one for each message
│       └── MessageParts
└── footer slot
```

## Features

- Renders a `ViteHubUISession` with a title and its messages.
- Fills the available space with a `Chat`.
- Adds an optional footer for the prompt or session actions.
- Leaves loading, saving, and authorization to your application.
- Accepts your own metadata on the session record.

## Session Ownership

The component does not fetch, change, or save the session. Load the record in your application, extend its metadata when needed, and keep tenancy and authorization at that boundary.

## Header and Footer

Use the `header` slot to replace the title and the `footer` slot to add content under the chat. Both receive `{ session }`.

::component-preview{name="SessionSlotsExample" flush}
::

## Accessibility

- The section has the session title as its accessible name, or **Agent session** when there is no title. Pass `aria-label` to change it.
- The default header renders the title as an `<h2>`. Keep the heading level correct when you replace it in the `header` slot.
- The chat inside has the same keyboard and screen reader behavior as [Chat](/docs/ui/chat#accessibility).

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
| `footer`    | `{ session }` | Content under the chat.                                        |
| Other slots |               | Forwarded to `Chat`, for example `message` or `composer`.      |

#### Types

```ts
interface ViteHubUISession<Message extends UIMessage = UIMessage> {
  id: string;
  messages: readonly Message[];
  title?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  metadata?: unknown;
}
```

`ViteHubUIMessage<Metadata, DataParts, Tools>` is an alias of the AI SDK `UIMessage` with the same type parameters.

## Related

- [Chat](/docs/ui/chat) renders the messages.
- [Chat app block](/docs/ui/blocks/chat-app) switches between sessions.
