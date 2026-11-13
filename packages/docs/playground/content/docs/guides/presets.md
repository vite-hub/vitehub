---
title: Presets
description: Name a set of settings in a preset, share it between projects, and extend it in a project config.
navigation.order: 4
navigation.group: Transform
icon: i-lucide-layers
---

A preset is a config file that other config files extend. Lumen has three built-in presets, and you can publish your own as a package.

| Preset | `maxWidth` | `quality` | `formats` |
| --- | --- | --- | --- |
| `lumen:web` | `1600` | `75` | `webp` |
| `lumen:thumbnails` | `480` | `70` | `webp` |
| `lumen:print` | None | `95` | None |

## Extend a preset

```json [lumen.config.json]
{
  "extends": "lumen:web",
  "quality": 80
}
```

The project file wins over the preset for each field that it sets.

## Share a preset

::steps{level="3"}
### Create the package

Create a package with a `lumen-preset.json` file and a `package.json` that names it in `lumen.preset`.

### Publish it

Publish the package to npm or to your private registry.

### Use it

Install the package and extend it by name, such as `"extends": "@acme/lumen-preset"`.
::
