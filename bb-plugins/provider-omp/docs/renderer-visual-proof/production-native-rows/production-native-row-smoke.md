# Production native file/search row smoke

Thread: `thr_rtvcgeavmc` (hidden, provider `omp`, project checkout workspace).

## Visual observation

`production-native-rows-expanded.png` is a full-page production BB capture after expanding **Worked for 8s** then **Explored 1 file, 1 search**. `production-native-row-crop.png` is the row crop.

The rendered native rows are visually muted (`opacity-40`) and contain only:

- `Read file package.json`
- `Searched files for test:supervisor in package.json`

The file row exposes `title="Read file /Users/ryanwooden/src/github.com/shopify-playground/bb-provider-omp/package.json"`; the search row exposes `title="Searched files for test:supervisor in package.json"`. Neither row is a button, has no keyboard affordance, and has no returned-output/body panel to expand.

The expanded group contains no selector/range metadata on the native read row. The selector appears only in the assistant message/link: `package.json:1-40`. Likewise the search query and target are retained as native-row identity, but the matching result appears only in the assistant message: `test:supervisor` at line 35, `node --test scripts/vitest-supervisor.checks.mjs`.

Conclusion: production UI visibly retains the native read/search identities, but does **not** retain or display native read text, selector/range metadata, or native search-result body for this timeline. The visible returned text is the agent-message body, not an expanded native row payload.
