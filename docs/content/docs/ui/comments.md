---
title: Comments
description: "Figma-style comments for your own running app: pins, threads, a composer, and a side list."
navigation.order: 34
navigation.group: Collaboration
icon: i-ph-chat-circle-light
---

`CommentLayer` puts Figma-style comments on a page. Press `C`, click a spot, write, and press `Enter`. A numbered pin with your avatar stays there, and the team replies in its thread.

The parts show state and call a transport. They do not own storage or access. The transport is the seam to the server: `@vite-hub/comments/client` has `createMemoryTransport()` for tests and examples, and `createRpcTransport()` from `@vite-hub/comments/rpc` talks to the server half. See [Comments](/docs/comments).

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation), and add the client:

```bash
pnpm add @vite-hub/comments
```

The Nuxt module auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/comments`:

```ts
import { CommentLayer } from "@vite-hub/ui/comments";
```

## Usage

```ts
import { createCommentsClient, createMemoryTransport } from "@vite-hub/comments/client";

const user = { id: "ana", name: "Ana Ruiz" };
const client = createCommentsClient({ transport: createMemoryTransport({ user }), user });
```

```vue
<template>
  <CommentLayer :client="client" :subject="{ kind: 'page', id: '/pricing' }" />
</template>
```

The layer loads the threads of the subject, draws a pin for each one, and shows a toolbar with the comment button and the list button.

## How it works

- `C` or the toolbar button turns on comment mode. The cursor becomes a speech bubble.
- A click drops a numbered pin with your avatar. Its composer opens with the focus in it.
- `Enter` sends. `Shift+Enter` breaks the line.
- `Esc` in an empty composer closes it.
- `Esc` in a composer that has text shakes it. The focus and the text stay. A click outside does the same. When the reader prefers reduced motion, the border flashes instead.
- `Esc` outside a composer leaves comment mode.
- Hover a pin to preview its thread. Click it to open the thread, reply, resolve it, or reopen it.
- Resolved threads have no pin until the Resolved filter is on.
- `?comment=<n>` in the URL opens thread `n` when the page loads.
- Type `@` in a composer to mention a person. The client's `users` call finds people.
- Select text, then press `C`: the comment is about that text.
- A pin drops when the pointer goes up, and only if it stayed in place. A touch that scrolls the page drops nothing.
- Keyboard: in comment mode, `Enter` on the focused element starts a comment on it. The toolbar button "Comment on page" starts a comment on the whole page.
- A draft pin has no number. The server assigns it when the comment is sent.

An anchor stays on its element when the layout changes. When the element is gone, ambiguous, or no longer holds the quoted text, the thread is detached: it stays in the list and has no pin. A pin is also hidden while a scroll container clips its element. [Anchors](#anchors) explains how a pin finds its spot.

## Composition

```text
CommentLayer
├── CommentPin (one per thread, and one for the draft)
│   └── hover: CommentThread (preview)
│   └── open: CommentThread
│       ├── CommentReply (one per message)
│       └── CommentComposer (variant="reply")
├── CommentComposer (the new comment)
├── CommentToolbar
└── CommentList
    └── CommentFilters
```

Every part has a `data-slot`, as in shadcn/ui: `comment-layer`, `comment-pin`, `comment-thread`, `comment-reply`, `comment-composer`, `comment-list`, `comment-filters`, and `comment-toolbar`. The default styles are in the `components` layer of `@vite-hub/ui/styles.css`, so utility classes override them.

## Build your own layout

`CommentLayer` renders the toolbar and the list. To place the parts yourself, give the layer a slot. The slot receives the `comments` state:

```vue
<template>
  <CommentLayer :client="client" :subject="subject">
    <template #default="{ comments }">
      <CommentToolbar :comments="comments" :people="people" />
      <CommentList :comments="comments" />
    </template>
  </CommentLayer>
</template>
```

To go without the layer, call `useComments()` from `@vite-hub/ui/headless`. It needs no Nuxt UI. It returns the state that the parts use, and you pass it as the `comments` prop:

```ts
import { useComments } from "@vite-hub/ui/headless";

const comments = useComments({ client, subject: { kind: "page", id: "/pricing" } });
comments.pageThreads.value; // The threads of this page, after the filters.
comments.toggle(); // Comment mode.
comments.startDraft({ x: 120, y: 80 }); // Start a comment on a point.
```

| Option | Description |
| --- | --- |
| `client` | The `CommentsClient`. Required. |
| `subject` | What the threads of this page are about. A value, a ref, or a getter. Required. |
| `user` | The signed-in user. Defaults to `client.user`. |
| `root` | Where anchors are looked up. Defaults to the document. |
| `param` | The query parameter of the deep link. Default `"comment"`. |
| `hotkey` | The key of comment mode. Default `"c"`. `false` turns it off. |
| `ignore` | Elements that anchors skip. Defaults to the comment UI. |
| `uiRoot` | The document or the shadow root that holds the comment UI. Composers with text are looked up there. Defaults to the document. |
| `subjectUrl` | The URL of the page that a subject lives on, for the link of a thread. Page subjects use their id as the path. Give it for other subjects, or their link is the current page. |
| `autoStart` | Load the threads and listen for keys on mount. Default `true`. Call `start()` yourself when `false`. |

## Anchors

An anchor says where a comment sits. `createAnchor()` makes one from an element, a point, a selection, or `"page"`. `resolveAnchor()` finds it again.

The selector uses the first of `data-comment-id`, `id`, and `data-testid` that names exactly one element. Else it is a short path from the nearest stable ancestor. Offsets are in thousandths of the element box, so a pin follows its element when the window resizes. Add `data-comment-id` to an element that must keep its comments when the markup changes.

Read more in the [`@vite-hub/comments` README](https://github.com/vite-hub/vitehub/tree/main/packages/comments).

## Accessibility

- A pin is a button. Its label has the number, the author, and the start of the comment, for example "Comment 3 by Ana Ruiz: Make this bigger", and it says when the thread is resolved. `aria-expanded` shows whether its thread is open.
- An open thread is a `dialog` that is named "Comment 3". Opening it moves the focus into it. Closing it gives the focus back to its pin, unless the reader already moved the focus elsewhere.
- The composer has a label. While the mention menu is open, the box is a `combobox` with `aria-controls` and `aria-activedescendant`, and the menu is a `listbox`.
- Deleting the first message of a thread asks first, because it deletes the thread.
- The toolbar is a `toolbar`. The comment button has `aria-pressed` and `aria-keyshortcuts="C"`.
- Under `prefers-reduced-motion` the composer does not shake. Its border flashes.

## API Reference

### CommentLayer

The overlay of a page. Renders a `div` with `data-slot="comment-layer"`. Give it a `client` and a `subject`, or a `comments` state.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `client` | `CommentsClient` | None | The client. Needed when `comments` is not set. |
| `subject` | `CommentSubject` | None | What the threads are about. Needed when `comments` is not set. |
| `user` | `CommentUser` | The client's user | The signed-in user. |
| `comments` | `CommentsState` | None | A state from `useComments()`, instead of `client` and `subject`. |
| `people` | `AvatarStackPerson[]` | `[]` | The people on the page. The toolbar shows them in an [Avatar Stack](/docs/ui/avatar-stack). |
| `hotkey` | `string \| false` | `"c"` | The key of comment mode. |
| `subjectUrl` | `(subject: CommentSubject) => string \| undefined` | None | The URL of the page of a subject, for the links of threads that are not page threads. |
| `navigate` | `(href: string) => void` | `location.assign` | Goes to the page of a thread that the list shows. |

### CommentPin

The pin. Renders a `button` with `data-slot="comment-pin"`. The pin has the author's avatar and the thread number.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `n` | `number` | None | The thread number. A draft has none. |
| `author` | `CommentUser` | None | Whose avatar shows. |
| `excerpt` | `string` | None | The start of the comment. It is part of the label. |
| `status` | `"open" \| "resolved"` | `"open"` | A resolved pin is gray. |
| `active` | `boolean` | `false` | The thread of this pin is open. |
| `draft` | `boolean` | `false` | The comment is still being written. |

#### Events

| Event | Description |
| --- | --- |
| `select` | The pin was clicked. |
| `hover` | The pointer or the focus came to the pin. |
| `leave` | The pointer or the focus left the pin. |

### CommentThread

The thread of one pin, as a card. With `preview` it is the read-only hover card. Renders a `section` with `data-slot="comment-thread"`.

The handlers may return a promise. The thread waits for it. A reply clears its box only after `onReply` has succeeded. On a failure the text stays and the error shows. While a reply is on its way, the box cannot send again.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `thread` | `CommentThread` | Required | The thread. |
| `user` | `CommentUser` | None | The signed-in user. Their messages can be edited and deleted. |
| `preview` | `boolean` | `false` | A read-only card with the comment and the reply count. |
| `busy` | `boolean` | `false` | Show a reply as being sent, on top of the thread's own tracking. |
| `error` | `string` | None | An error to show, on top of the ones from the handlers. |
| `detached` | `boolean` | `false` | The place of the thread is no longer on the page. |
| `users` | `(query: string) => Promise<CommentUser[]>` | None | Finds people for `@mentions`. |
| `onReply` | `(body: string, mentions: string[]) => void \| Promise<unknown>` | None | Sends a reply. |
| `onEdit` | `(messageId: string, body: string, mentions: string[]) => void \| Promise<unknown>` | None | Saves an edited message. |
| `onDelete` | `(messageId: string) => void \| Promise<unknown>` | None | Deletes a message. Deleting the first message deletes the thread, and the thread asks first. |
| `onResolve` | `() => void \| Promise<unknown>` | None | Resolve was pressed. |
| `onReopen` | `() => void \| Promise<unknown>` | None | Reopen was pressed. |

#### Events

| Event | Description |
| --- | --- |
| `close` | Close was pressed, or the reader clicked outside. |

### CommentReply

One message of a thread. The first message is the comment, and the rest are replies. Its author can edit it in place and delete it. Renders a `div` with `data-slot="comment-reply"`. The body is [Markdown](/docs/ui/markdown). The edit box closes after `onEdit` has succeeded. On a failure it stays open with the text and the error.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `message` | `CommentMessage` | Required | The message. |
| `editable` | `boolean` | `false` | Show Edit and Delete. |
| `compact` | `boolean` | `false` | Clamp the body to three lines, without actions. |
| `confirmDelete` | `boolean` | `false` | Ask before Delete. A thread sets it on the first message. |
| `people` | `CommentUser[]` | `[]` | People whose `@name` the message may hold, so an edit keeps their mentions. |
| `users` | `(query: string) => Promise<CommentUser[]>` | None | Finds people for `@mentions` while editing. |
| `onEdit` | `(messageId: string, body: string, mentions: string[]) => void \| Promise<unknown>` | None | Saves the edit. |
| `onDelete` | `(messageId: string) => void \| Promise<unknown>` | None | Deletes the message. |

### CommentComposer

The box for a new comment, a reply, or an edit. It wraps [Prompt Input](/docs/ui/prompt-input), and has no attachments yet. Renders a `div` with `data-slot="comment-composer"`. It has `data-shake` while it shakes and `data-dirty` while it has text.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `modelValue` | `string` | `""` | The text. Use `v-model`. |
| `mentions` | `string[]` | `[]` | The ids of the people mentioned. Use `v-model:mentions`. |
| `user` | `CommentUser` | None | Whose avatar shows beside the box. |
| `variant` | `"comment" \| "reply" \| "edit"` | `"comment"` | Sets the label and the placeholder. |
| `placeholder` | `string` | By variant | The placeholder. |
| `busy` | `boolean` | `false` | A send is running. The box keeps its text and cannot send again. |
| `error` | `string` | None | Why the last send failed. |
| `autofocus` | `boolean` | `true` | Focus the box when it appears. |
| `guard` | `boolean` | `true` | A click outside closes an empty box, and shakes a box with text. Turn it off when the parent decides. |
| `people` | `CommentUser[]` | `[]` | People whose `@name` the text may hold. A mention is sent only when its `@name` is still in the text, so deleting the name drops the mention. |
| `users` | `(query: string) => Promise<CommentUser[]>` | None | Finds people for `@mentions`. Without it there is no mention menu. |

#### Events

| Event | Description |
| --- | --- |
| `submit` | `Enter` was pressed with text. Gets `{ body, mentions }`. |
| `cancel` | `Esc` was pressed in an empty box, or the reader clicked outside it. |

The component exposes `focus()` and `shake()`.

### CommentToolbar

The comment button, the "Comment on page" button, the list button, and the people on the page. Renders a `div` with `data-slot="comment-toolbar"`.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | The layer's state | The state from `useComments()`. |
| `people` | `AvatarStackPerson[]` | `[]` | The people on the page. |

### CommentList

The side list of threads. Renders a `section` with `data-slot="comment-list"`. It lists the threads of this page or of every page, and takes the filters. Each row is a link to the page of the thread with `?comment=<n>`.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | The layer's state | The state from `useComments()`. |
| `navigate` | `(href: string) => void` | `location.assign` | Goes to the page of a thread that is not on this page. |

#### Events

| Event | Description |
| --- | --- |
| `select` | A row was clicked. Gets the thread. |

### CommentFilters

Open, Resolved, and Mine. Each is a toggle. Renders a `div` with `data-slot="comment-filters"`. The filters apply to the pins and to the list.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | The layer's state | The state from `useComments()`. |

## Related

- [Avatar Stack](/docs/ui/avatar-stack) shows who is on the page.
- [Prompt Input](/docs/ui/prompt-input) is the box inside the composer.
- [Markdown](/docs/ui/markdown) renders the messages.
