# Isolated OMP renderer visual verification

## Instance

- BB core: `8c81a68555e2af7025e81a2490f0cc76024b0c93`; Plugin SDK `0.6.75`.
- Provider source: `05a82878a7e13b3bca15d611445d7dbf44103871`.
- Isolated server: `http://127.0.0.1:23314`.
- Isolated installation reported `provider-omp@0.1.0 running`.

## Saved browser screenshots

- `omp-web-active.png`: direct OMP thread actively starting.
- `omp-web-rows.png`: active OMP web-search and eval rows before expansion.
- `omp-web-expanded-rows.png`: actual OMP `Searched the web` row expanded.
- `omp-web-lifecycle.png`: actual OMP web row followed by active `sleep 30` lifecycle row.
- `omp-eval-expanded-rows.png`: actual OMP `Running Python` eval row expanded.

Each image is saved beside this report in the thread storage directory.

## Direct OMP evidence

All verified renderer rows used `providerId: "omp"`, model `shopify-router-openai/shopify/auto`, low reasoning, and full access.

### Expanded web row

Thread `thr_ygt2w5manw` rendered and expanded:

- Row header: `Searched the web`.
- Intent-aware title: `RFC 2119 key words use in RFCs to indicate requirement levels`.
- Duration: `17s`.
- Expanded panel displayed query text, detailed response, three source cards, citations, and related questions.
- The next active row rendered `Running / sleep 30 / 7s` with intent `Waiting thirty seconds`.

### Expanded eval row

Thread `thr_zvtrmpwqr4` rendered and expanded:

- Row header: `Running Python`.
- Intent-aware title: `Calculating sum`.
- Expanded panel displayed `print(2 + 2)`, tool identity `eval`, `language: py`, title, timeout, reset state, Python source, and pending-result state.

## Additional real OMP observations

Earlier direct OMP activity displayed search/read failure rows, `Ran wait Waiting briefly`, and actual active lifecycle state. The isolated personal workspace contained no `package.json`, so read/grep visual evidence was limited to their correctly labeled error rows.

## Uncovered rows

- Tool Gateway: no configured local source produced a Gateway row.
- IRC: no real source produced an IRC row.
- Nested roster: no nested OMP delegation was started because this verification was explicitly sole-worker.
- No deterministic fixture was injected; these gaps remain visual verification gaps, not passes.
