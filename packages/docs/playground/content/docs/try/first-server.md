---
title: Your first server
description: Change what a small Node server answers, one module at a time, in a lesson with two steps.
layout: learn
fixture: first-server
navigation.order: 2
icon: i-lucide-graduation-cap
---

The server in `server.mjs` loads two modules on each request. When a module is missing, it answers with a hint. You write the modules.

::tutorial-step{title="Write a greeting"}
## Write a greeting

Create `greeting.mjs`. Its default export returns the first line of the answer:

```js [greeting.mjs]
export default function greeting() {
  return "Hello from your first server."
}
```

Send a request to the server:

```bash [commands/request]
curl http://localhost:3000/
```

The answer is the greeting.

::

::tutorial-step{title="Add the time"}
## Add the time

Create `clock.mjs`. It returns a second line with the time:

```js [clock.mjs]
export default function clock() {
  return `It is ${new Date().toISOString().slice(11, 19)} UTC.`
}
```

Reload the preview. The answer has two lines now.

::

You wrote two modules that the server loads on each request. Open the [playground](/docs/try/playground) to try more servers.
