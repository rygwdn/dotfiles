Continuity keeps OMP sessions lighter without replacing their original tool-result history.

Opt in per thread from a Continuity panel or the `bb continuity` CLI. An in-process OMP extension projects older bulky tool results into stable journal references, preserves recent complete work, and uses OMP's native soft compactor after a configured idle interval. No separate process resumes or edits the session.

History-first operation requires OMP's native notes/history tools to be active at startup. Automatic pressure handling is notes-backed rollover; idle summaries use native soft compaction. Cache warming stops while enabled. Missing prerequisites, stale runtimes, deferred work, and approximate projection metrics are visible in the panel.

Initial activation requires a provider restart. Native summaries may incur model charges and multiple requests. Frequency is bounded by a 15-minute attempt cooldown and one automatic attempt per user-entry ID; there is no dollar budget or separate maintenance billing total exposed through the extension API. A stopped provider does not compact overnight.

The plugin installs a gated, collision-checked workspace extension and private host control/status files. It does not change global OMP configuration or create a parallel transcript archive. Only `acp-omp` threads are supported.
