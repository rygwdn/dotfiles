# Changelog

## 2026-10-27 — MEMORYPLUG-13 agent recall and correction review

- Register bounded `recall` search/full-ID retrieval using shared scoped reads, live host bot resolution and quarantine exclusion.
- Add `learn` correction mode with ID/expected-version checks: immediate pending supersede or wrong-only retirement candidates through the existing review store; no canonical writes before review.
- Show agent provenance, report semantics and linked source record in the existing Settings review UI.
- Allow explicit versioned Settings deletion of quarantined fixtures while scoped agent deletion still refuses them.
- Preserve fresh learning/managed skills and CLI; document the known SDK identity limitation separately.

## 2026-10-26 — BI-11 acceptance fixes

- Add host-local atomic ACP overlay and preserve native managed-skill support.
- Support approved-proposal cancellation and cancelled review filter.
- Validate proposal payloads and versions on approval/application; protect rollback from later corrections and remove supersede replacements.
- Roll back learning records on refused/failed managed-skill writes.
- Exclude quarantined history and scan inputs; inspect source retirement/expiry signals without declaring semantic validity.
- Replace threadless catalog dreaming with bounded scan/peer lookup, snapshot-bounded composite checkpoints, concurrent-write deferral and replay dedupe.
- Withhold private summaries from synchronous catalog; document unresolved authenticated CLI/RPC authority.
