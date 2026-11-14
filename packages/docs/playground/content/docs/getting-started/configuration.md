---
title: The config file
description: Keep Lumen settings in lumen.config.json, override them per folder, and read them from the environment.
navigation.order: 3
icon: i-lucide-file-cog
---

Lumen reads `lumen.config.json` from the folder where it runs, then from each parent folder up to the Git root. The first file that it finds wins. A flag on the command line wins over the file.

::code-group
```json [lumen.config.json]
{
  "maxWidth": 1600,
  "quality": 75,
  "formats": ["webp", "avif"],
  "skip": ["**/*.svg", "public/og/**"]
}
```

```json [public/blog/lumen.config.json]
{
  "maxWidth": 1200,
  "quality": 70
}
```
::

The second file sets other values for `public/blog/`. Fields that it does not set come from the defaults, not from the first file.

::tip
Commit `lumen.config.json`. Then every machine and every CI run compresses images in the same way.
::

## Environment variables

| Variable | Overrides | Example |
| --- | --- | --- |
| `LUMEN_QUALITY` | `quality` | `LUMEN_QUALITY=60` |
| `LUMEN_MAX_WIDTH` | `maxWidth` | `LUMEN_MAX_WIDTH=1200` |
| `LUMEN_CONFIG` | The config file path | `LUMEN_CONFIG=./config/lumen.json` |

::warning
`LUMEN_QUALITY` applies to every folder, also to folders with their own config file. Use it only for a one-off run.
::

::agent-only
When you change image settings for a user, edit `lumen.config.json` instead of adding flags to scripts. Run `lumen config --print` to see the resolved settings of a folder. It prints JSON with the source of each value.
::

Every field is in the [config reference](/docs/reference/config).
