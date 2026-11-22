---
title: Playground
description: Two small Node servers that run in your browser. Pick one, edit a file, and reload the preview.
layout: playground
navigation.order: 1
icon: i-lucide-square-terminal
examples:
  - id: hello
    label: Hello
    description: A server that reads its message from a file.
    group: Servers
    dir: examples/hello
    open: message.txt
  - id: clock
    label: Clock
    description: A server that shows the time in a time zone.
    group: Servers
    dir: examples/clock
    open: server.mjs
tabs:
  - value: changes
    label: Changes
---

Each example is a Node server without dependencies. The workspace runs `npm install`, then `npm run dev`, and shows the server on port 3000. The Changes tab lists the files that you edited.
