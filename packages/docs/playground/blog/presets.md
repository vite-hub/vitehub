---
title: "Presets: one set of image settings for every repository"
description: Lumen 1.2 adds `extends`, three built-in presets, and presets that you publish as a package.
date: 2026-03-10
authors: [ada]
tags: [release]
---

Teams with many sites told us the same story: each repository had its own `lumen.config.json`, and each one was a little different. Lumen 1.2 adds presets, so one file can hold the settings that every site shares.

## Start from a built-in preset

```json [lumen.config.json]
{
  "extends": "lumen:web"
}
```

`lumen:web` resizes to 1,600 pixels and writes WebP at quality 75. `lumen:thumbnails` and `lumen:print` cover the other two cases that we saw most often. Fields in your file win over the preset.

## Publish your own

A preset is a package with a `lumen.config.json`. Publish it to your registry, and extend it by its name:

```json [lumen.config.json]
{
  "extends": "@acme/lumen-preset",
  "skip": ["**/logos/**"]
}
```

## One breaking change

The default `maxWidth` is now 1,600 instead of 2,048, the same as `lumen:web`. Set `maxWidth` to keep the old size. The [presets guide](/docs/guides/presets) has every field.
