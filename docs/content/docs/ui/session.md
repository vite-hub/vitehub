---
title: Session
description: Present an application-owned chat session with a title and the same AI SDK message contract.
navigation.order: 25
navigation.group: Chat
icon: i-ph-chats-circle-light
---

`AgentSession` is the small shell around a saved conversation. It gives the Console a title, an `AgentChat` that fills the available space, and an optional footer for the prompt or session actions. AI SDK does not define a session schema, so `ViteHubUISession` stays small: an ID, messages, an optional title and timestamps, and your own metadata.

::component-preview{name="SessionExample" flush}
::

## Usage

```ts
const session: ViteHubUISession = {
  id: "session_01",
  title: "Production deploy failure",
  messages,
  metadata: { projectId: "project_01" },
};
```

```vue
<AgentSession :session :status />
```

The component does not fetch, change, or save the session. Load the record in your application, extend its metadata when needed, and keep tenancy and authorization at that boundary.

## Examples

### Header and footer

Use the `header` slot to replace the title and the `footer` slot to add content under the chat. Both receive `{ session }`.

::component-preview{name="SessionSlotsExample" flush}
::

## API reference

### AgentSession

#### Props

| Prop      | Type                              | Default   | Description                                 |
| --------- | --------------------------------- | --------- | ------------------------------------------- |
| `session` | `ViteHubUISession<UIMessage>`     | Required  | The session to render.                      |
| `status`  | `ChatStatus`                      | `'ready'` | AI SDK chat status, passed to `AgentChat`.  |

Other attributes go to the root `<section>`. It has a `data-session-id` attribute.

#### Slots

| Slot        | Scope         | Description                                                    |
| ----------- | ------------- | -------------------------------------------------------------- |
| `header`    | `{ session }` | Replaces the default title header.                             |
| `footer`    | `{ session }` | Content under the chat.                                        |
| Other slots |               | Forwarded to `AgentChat`, for example `message` or `composer`. |

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

## Accessibility

- The default header renders the title as an `<h2>`. Keep the heading level correct when you replace it in the `header` slot.
- The chat inside has the same keyboard and screen reader behavior as [Chat](/docs/ui/chat#accessibility).

## Related

- [Chat](/docs/ui/chat) renders the messages.
- [Chat app block](/docs/ui/blocks/chat-app) switches between sessions.
