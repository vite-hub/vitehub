---
title: CLI
description: Every Lumen command with its flags, defaults, and an example.
navigation.order: 1
icon: i-lucide-terminal
---

Every command takes a folder or a file as its first argument. Flags win over the config file.

## Commands

| Command | Does | Changes files |
| --- | --- | --- |
| `lumen compress <path>` | Compresses each image. | Yes |
| `lumen resize <path>` | Resizes each image wider than `maxWidth`. | Yes |
| `lumen convert <path>` | Writes a copy in each of `formats`. | Adds files |
| `lumen check <path>` | Compares each image with `--max-size`. | No |
| `lumen compare <path>` | Opens a page that compares originals and results. | No |
| `lumen config --print` | Prints the resolved settings as JSON. | No |

## Flags

| Flag | Default | Use |
| --- | --- | --- |
| `--quality <1-100>` | From the format | Compression quality. |
| `--max-width <px>` | `1600` | Largest width. |
| `--formats <list>` | None | Comma-separated formats, such as `webp,avif`. |
| `--out <dir>` | In place | Writes the results to another folder. |
| `--keep` | `false` | Moves the originals to `.lumen/originals/`. |
| `--dry-run` | `false` | Prints the result and writes nothing. |
| `--max-size <size>` | None | Size limit for `check`, such as `400kb`. |
| `--format <text\|json\|markdown>` | `text` | Report format. |

::agent-only
Prefer `--format json` when you parse Lumen output. Each line of the JSON report is one object with `file`, `before`, `after`, and `skipped`.
::

## Examples

```bash [Terminal]
lumen compress ./public --quality 70 --keep
lumen check ./public --max-size 400kb --format markdown > report.md
```
