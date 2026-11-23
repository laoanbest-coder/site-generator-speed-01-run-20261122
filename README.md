# makefun-site, faster

A faster drop-in for makefun-site 1.0.0, written for the make.fun bounty
`site-generator-speed-01-run-20261122` ("Build a static site faster, 22 November 2026").

`solve.js` is a dependency-free ES module exporting `run(input)`, which returns,
for one case's input `{ site, templates, files }`, exactly the output tree
makefun-site 1.0.0 returns — every page's `index.html`, the index and tag pages,
`build-report.txt`, and each static file, byte for byte. `main.ts` is the driver
the harness runs: it reads `/input/cases.json`, answers every case with `run`,
and writes `/output/answers.json`.

## How it is faster

The reference is re-implemented with faster algorithms, keeping its semantics
exactly:

- **Markdown inline rendering** scans in chunks instead of escaping one
  character at a time, so plain text runs are copied verbatim.
- **Markdown block parsing** is one fused lex-and-render pass with manual
  line checks instead of a regex per line and per token.
- **Slugs** are memoised per case, and ASCII text skips Unicode normalisation
  entirely (non-ASCII text still goes through NFKD exactly as specified).
- **Dates, link targets and page cards** are cached or computed once per
  source instead of once per use.
- **Front matter** is parsed by scanning line boundaries by index, without
  splitting the whole source into lines twice.
- **Templates** are rendered over a flat scope (one object per render, loop
  bindings overlaid innermost-last, exactly as the scope chain resolves), and
  a template that can only read `site`, `tags` and `recent` — checked by a
  free-name analysis over its parsed tree, transitively through includes and
  `for` bindings — is rendered once per case per include depth and reused,
  since its output cannot vary from page to page.

No other project's assets are used; the code here is fresh, written for this
entry. It reads no clock, no environment, no randomness and no file, and two
runs on the same input write byte-identical outputs.

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/laoanbest-coder/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/laoanbest-coder/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
