---
title: Convert formats
description: Add WebP and AVIF copies of each image, convert PNG photos to JPEG, and choose the formats per folder.
navigation.order: 3
navigation.group: Optimize
icon: i-lucide-repeat
---

`formats` adds a copy in each format next to the original. The original stays in its own format.

```json [lumen.config.json]
{
  "formats": ["webp", "avif"]
}
```

## Choose a format

| Format | Use it for | Browser support |
| --- | --- | --- |
| WebP | Photos and graphics on every site | Every current browser |
| AVIF | The smallest photos, when encode time does not matter | Every current browser |
| JPEG | Email and old clients | Every client |

::tip
AVIF takes about ten times longer to encode than WebP. Turn it on for the images of a release build, not for each save in development.
::

## Convert PNG photos

A photo saved as PNG is often five times larger than the same photo as JPEG. `--photos-to-jpeg` converts a PNG to JPEG when it has no transparent pixels and more than 10,000 colors.

```bash [Terminal]
lumen convert ./public --photos-to-jpeg
```

Lumen prints each file that it converted, so you can update the links to it.
