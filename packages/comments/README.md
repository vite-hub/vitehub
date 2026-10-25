# @vite-hub/comments

Figma-style comments for your own running app. A signed-in team member drops a pin on any spot of a page, and the team replies in the thread.

This package holds what the server and the UI share:

- `@vite-hub/comments` has the types: `CommentThread`, `CommentMessage`, `CommentAnchor`, `CommentSubject`, `CommentUser`, `CommentStatus`, and the `CommentsTransport` contract.
- `@vite-hub/comments/client` has no framework. It makes anchors, finds them again, and calls the comment operations through a transport.

The Vue parts are in `@vite-hub/ui/comments`. Server tables, operations, and the Vite overlay come in later changes.

## Anchors

An anchor says where a comment sits, so the pin can find the spot again after the layout changes.

```ts
import { createAnchor, resolveAnchor } from "@vite-hub/comments/client";

// From a click: the element under the point, plus where in its box the click landed.
const anchor = createAnchor({ x: event.clientX, y: event.clientY });
// { kind: "element", selector: "#pricing > div > button", x: 480, y: 310 }

const position = resolveAnchor(anchor);
if (position.detached) {
  // The element is gone, hidden, or no longer holds the quote.
} else {
  position.x; // The pin position in client coordinates.
}
```

| Kind | Made from | Keeps |
| --- | --- | --- |
| `page` | `"page"` | Nothing. The whole page. |
| `element` | an element, or a point | The element selector and a point in thousandths of its box. |
| `text` | a `Selection` or a `Range` | The selector of the nearest element, and the quote as `exact`, `prefix`, `suffix`. |
| `area` | an element and `options.area` | The selector and a rectangle in thousandths. |
| `image` | an `img`, with a point or `options.area` | The same as `element` or `area`, on an image. |

The selector uses the first of these that names exactly one element: `data-comment-id`, `id`, `data-testid`. Else it is a short path such as `#plans > div > p:nth-of-type(2)`. Add `data-comment-id` to an element that must keep its comments when the markup changes.

Offsets are in thousandths of the element box: `500` is the middle. A pin follows its element when the window resizes.

## Client

```ts
import { createCommentsClient } from "@vite-hub/comments/client";

const client = createCommentsClient({
  transport, // see below
  user: { id: "ana", name: "Ana Ruiz" },
  query: { page: location.pathname },
});

const stop = client.start(); // Loads the threads, then keeps them fresh.
await client.create({
  subject: { kind: "page", id: location.pathname },
  anchor,
  body: "This button is too small.",
});
client.threads; // The cached threads, ordered by number.
client.onChange(() => render(client.threads));
```

`start()` listens to the transport's `subscribe`, such as Realtime. Without `subscribe` it refreshes when the window gets focus.

### Transport

A transport is the seam to the server. Each method has the name and the input of one `comments.*` operation.

```ts
interface CommentsTransport {
  list(query: CommentListQuery): Promise<CommentThread[]>;
  get(input: CommentGetInput): Promise<CommentThread | null>;
  create(input: CommentCreateInput): Promise<CommentThread>;
  reply(input: CommentReplyInput): Promise<CommentThread>;
  edit(input: CommentEditInput): Promise<CommentThread>;
  delete(input: CommentDeleteInput): Promise<CommentThread | null>;
  resolve(input: CommentStatusInput): Promise<CommentThread>;
  reopen(input: CommentStatusInput): Promise<CommentThread>;
  users(input: CommentUsersInput): Promise<CommentUser[]>;
  subscribe?(listener: (event: CommentEvent) => void): () => void;
}
```

A mutation returns the thread as it is afterwards. `delete` returns `null` when the thread is gone.

`createMemoryTransport()` keeps threads in memory. Use it in tests and docs examples:

```ts
import { createCommentsClient, createMemoryTransport } from "@vite-hub/comments/client";

const ana = { id: "ana", name: "Ana Ruiz" };
const transport = createMemoryTransport({ user: ana });
const client = createCommentsClient({ transport, user: ana });
```

`transport.as(user)` gives another person on the same store.

## Errors

Errors have a stable code, a `why`, and a `fix`.

| Code | Meaning |
| --- | --- |
| `COMMENTS_R0001` | `createAnchor()` found nothing to anchor to. |
| `COMMENTS_R0002` | The thread does not exist. |
| `COMMENTS_R0003` | The message does not exist in the thread. |
| `COMMENTS_R0004` | Only the author can edit or delete a message. |
| `COMMENTS_R0005` | A comment needs some text. |
