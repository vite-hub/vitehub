---
title: Resize images
description: Set a largest width, keep the aspect ratio, and write several sizes of each image for responsive pages.
navigation.order: 1
navigation.group: Transform
icon: i-lucide-scaling
---

Lumen never makes an image larger. It makes an image smaller only when it is wider than `maxWidth`, and it keeps the aspect ratio.

```bash [Terminal]
lumen resize ./public --max-width 1600
```

## Write responsive sizes

`sizes` writes one copy per width next to the original, with the width in the file name:

```json [lumen.config.json]
{
  "sizes": [480, 960, 1600]
}
```

```txt [output/files.txt]
public/hero.jpg
public/hero-480.jpg
public/hero-960.jpg
public/hero-1600.jpg
```

Use the copies in a `srcset`:

```html [index.html]
<img
  src="/hero-960.jpg"
  srcset="/hero-480.jpg 480w, /hero-960.jpg 960w, /hero-1600.jpg 1600w"
  sizes="(max-width: 600px) 480px, 960px"
  alt="The Lumen team on a hill"
>
```

::note
An image narrower than a size gets no copy for that size. A 900 pixel image in the example above gets only `hero-480.jpg`.
::

## Crop to a ratio

`--ratio 16:9` crops the center of each image to the ratio before it resizes it. Use `--focus top` to keep the top of the image instead of the center.

::agent-only
`lumen resize` with `--ratio` changes the original file. Run it on a copy of the folder, or add `--out ./resized` to write the results to another folder.
::
