---
title: Exit codes
description: What each Lumen exit code means, and what to do about it.
navigation.order: 3
icon: i-lucide-hash
---

| Code | Name | Cause | Fix |
| --- | --- | --- | --- |
| `0` | Success | Lumen did the work, or there was nothing to do. | None |
| `1` | Over limit | `lumen check` found an image over `--max-size`. | Compress the images that the report names. |
| `2` | Unreadable image | A file has an image extension but is not a valid image. | Replace the file, or add it to `skip`. |
| `3` | Node.js too old | Lumen runs on Node.js 24 or newer. | Update Node.js. |
| `4` | Invalid config | A field of `lumen.config.json` has a wrong value. | Fix the field that the message names. |

::caution
Exit code `2` stops the run at the first unreadable image. The images after it are not compressed. Fix or skip the file, then run Lumen again.
::
