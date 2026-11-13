---
title: Compress your first folder
description: Write a config file, compress a folder of images, and read the size report that Lumen prints.
navigation.order: 2
navigation.title: First folder
layout: tutorial
codePanel: true
tutorial: quickstart
icon: i-lucide-image
---

Make the images of a small site smaller. At the end, every image in `public/` is at most 1600 pixels wide, and Lumen prints how many bytes it saved.

You need Lumen 1.4 or newer. Read [Install Lumen](/docs/getting-started/install) first.

::tutorial-step{title="Create the project"}
## Create the project

Create a folder with a `public/` folder for the images, and a `package.json`:

```json [package.json]
{
  "name": "lumen-demo",
  "private": true,
  "scripts": {
    "images": "lumen compress ./public"
  }
}
```

Copy a few large photos into `public/`.

::

::tutorial-step{title="Write the config"}
## Write the config

Lumen reads `lumen.config.json` from the folder where it runs. Set the largest width and the quality:

```json [lumen.config.json]
{
  "maxWidth": 1600,
  "quality": 75,
  "formats": ["webp"]
}
```

`formats` adds a WebP copy next to each image. The originals stay as they are.

::

::tutorial-step{title="Run Lumen"}
## Run Lumen

```bash [commands/run]
pnpm run images
```

```txt [output/report.txt]
public/hero.jpg        2.4 MB -> 312 KB  (webp 201 KB)
public/team.png        1.1 MB -> 188 KB  (webp 96 KB)
2 images, 3.5 MB -> 500 KB, saved 86%
```

Lumen writes the smaller files in place. Run it again, and it skips the images that it already compressed.

::

::tutorial-step{title="Check the result in CI"}
## Check the result in CI

Add a check that fails when someone adds an image that is too large:

```json [package.json]
{
  "name": "lumen-demo",
  "private": true,
  "scripts": {
    "images": "lumen compress ./public",
    "images:check": "lumen check ./public --max-size 400kb"
  }
}
```

`lumen check` changes no file. It exits with code `1` when an image is over the limit. The [CI guide](/docs/guides/ci) runs it on every pull request.

::
