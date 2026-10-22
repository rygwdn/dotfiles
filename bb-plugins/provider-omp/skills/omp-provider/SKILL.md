---
name: omp-provider
description: "Use BB's OMP provider for model selection, message editing, and context compaction."
---

# OMP provider

The provider ID is `omp`. Use the target host's provider catalog for available
models and reasoning options; they depend on that host's OMP installation and
credentials.

Inspect the thread before editing or compacting it. Use `bb thread edit-message`
to edit and rerun an eligible user message, and `bb thread compact` to compact an
idle or errored thread. Consult live command help for arguments and wait for
provider confirmation before reporting completion.

To see an omp thread's subagents (roster and read-only conversations) and the
services omp's daemon supervises for its directory (`omp ps`), point the user to
the thread's **omp Hub** right-panel tab or a delegation card's **Details** button.

The host needs OMP 18.10.0 or newer. For authentication, run `omp` on that host,
then `/login`. Installation and upgrades follow the
[official OMP instructions](https://github.com/can1357/oh-my-pi#install);
`omp update` is OMP's upgrade command.
