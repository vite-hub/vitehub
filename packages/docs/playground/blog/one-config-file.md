---
title: Why Lumen reads one config file
description: Flags for experiments, a committed file for decisions. The design rule behind every Lumen option.
date: 2025-12-02
authors: [priya, ada]
tags: [design]
cover:
  pathname: illustrations/reference-light.svg
  contentType: image/svg+xml
---

Every Lumen option is a flag and a field in `lumen.config.json`. People ask why we do not read environment variables, a `.lumenrc` in the home folder, or a section of `package.json`. The answer is one rule: the settings that change your images belong in your repository.

## Flags are for experiments

A flag is how you try something: `--quality 60` on one folder, to see what happens. When you like the result, you move the value into the file and commit it. Then your laptop, your teammate's laptop, and CI write the same bytes.

## Hidden settings make different images

A setting in your home folder or your shell changes your images without a trace in the repository. Two people run the same command and commit different files. We saw this happen in the first beta, and it took a day to find.

## How to see what Lumen uses

`lumen config --print` prints the resolved settings as JSON: the preset, your file, and your flags, merged in that order. When a result surprises you, start there.

The [config reference](/docs/reference/config) lists every field.
