---
title: Compress images
description: Pick a quality for JPEG, PNG, and WebP, compare the results side by side, and keep the originals.
navigation.order: 2
navigation.group: Optimize
icon: i-lucide-file-down
---

`quality` goes from `1` to `100`. Lower numbers make smaller files with more visible artifacts. `75` is a good start for photos.

| Format | Default quality | Lossless option |
| --- | --- | --- |
| JPEG | `80` | No |
| PNG | Lossless | Always |
| WebP | `75` | `--lossless` |
| AVIF | `60` | `--lossless` |

## Compare before you commit

`--dry-run` writes nothing. It prints the size that each image would have:

```bash [Terminal]
lumen compress ./public --quality 70 --dry-run
```

`lumen compare` opens a page on `localhost:4800` with the original and the result side by side, so you can see the artifacts before you choose a quality.

## Keep the originals

`--keep` moves each original to `.lumen/originals/` before it writes the smaller file. Add the folder to `.gitignore`.

::warning
Without `--keep` or `--out`, Lumen replaces the files in place. Commit your images before the first run, so that `git checkout` brings them back.
::
