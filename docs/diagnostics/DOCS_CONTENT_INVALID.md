---
description: "Fix DOCS_CONTENT_INVALID in @vite-hub/docs. A page frontmatter or a .navigation.yml file does not match the schema."
seo.title: "DOCS_CONTENT_INVALID: invalid docs frontmatter"
---

Page frontmatter or a `.navigation.yml` file does not match the schema. The build stops on the first invalid file. The message names the file and each wrong field:

```txt [output/docs-content-error.txt]
Invalid docs frontmatter in content/docs/guide/install.md: layout: Invalid type: Expected ("article" | "tutorial" | "landing") but received "wide"
```

## Why it happens

A required field is missing, such as `title`, or a field has a wrong value or type.

## Fix it

Correct the named field. The [frontmatter reference](/docs/docs-site/server-api#frontmatter) lists every field and its values. In development, the terminal shows the error and the site keeps the last valid pages until you fix the file.
