---
title: Config file
description: Every field of lumen.config.json, with its type, default, and use.
navigation.order: 2
icon: i-lucide-file-cog
---

| Field | Type | Default | Use |
| --- | --- | --- | --- |
| `extends` | `string` | None | A preset to start from, such as `lumen:web`. |
| `maxWidth` | `number` | `1600` | Largest width in pixels. |
| `sizes` | `number[]` | `[]` | Extra widths for responsive copies. |
| `quality` | `number` | From the format | Compression quality from `1` to `100`. |
| `formats` | `("webp" \| "avif" \| "jpeg")[]` | `[]` | Formats of the extra copies. |
| `skip` | `string[]` | `[]` | Glob patterns of files to leave alone. |
| `keep` | `boolean` | `false` | Keeps the originals in `.lumen/originals/`. |
| `maxSize` | `string` | None | The default limit of `lumen check`. |

## Example

```json [lumen.config.json]
{
  "extends": "lumen:web",
  "sizes": [480, 960],
  "skip": ["**/*.svg"],
  "maxSize": "400kb"
}
```

## Validation

Lumen checks the file before it reads any image. A wrong field stops it with exit code `4` and a message that names the field:

```txt [output/error.txt]
lumen.config.json: quality: Expected a number from 1 to 100, received 120
```
