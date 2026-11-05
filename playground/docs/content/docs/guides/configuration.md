---
title: Configuration
description: Set default options in lumen.config.json.
navigation.order: 1
---

# Configuration

Put defaults in `lumen.config.json` in the folder where you run Lumen:

```json
{
  "quality": 75,
  "format": "webp",
  "maxWidth": 1600
}
```

Command-line flags override the file. `format` accepts `webp`, `avif`, and `jpeg`. The default `quality` is 82.
