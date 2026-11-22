---
title: Render in the page
description: A playground that renders an HTML file in the page, without a WebContainer, on every device.
layout: playground
render: app/playground/render.ts
navigation.order: 3
icon: i-lucide-file-code
examples:
  - id: page
    label: A page
    description: An HTML file, a read-only footer, and a binary file. Edit index.html to change the preview.
    dir: examples/page
    open: index.html
    readonly: [footer.html]
---

The `render` module of this page turns the files into HTML. The page does not start a WebContainer, so it is not cross-origin isolated and it works on phones.

`footer.html` is read-only. `pixel.bin` is a binary file: the tree does not show it, and the render function reads its bytes from `example.assets`.
