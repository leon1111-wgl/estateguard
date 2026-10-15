# EstateGuard Implementation Plan

**Goal:** Deliver a usable community incident review workflow and reproducible evidence on GitHub.
**Architecture:** One pure ES module drives the browser and CLI. A small Python CLI audits annotation exports. No external runtime service.
**Spec:** ../../DESIGN.md
**Execution:** Inline implementation with independent user-role critique after a working build.

- [x] 1. Write behavior tests for merge boundaries, uncertainty, move permits, invalid imports, event matching and decision audit history. Run `node --test tests/*.test.mjs` and confirm the absent engine fails. Implement `web/engine.mjs` and rerun.
- [x] 2. Author `data/demo.json` and `data/reference.json` with distinct synthetic cases, a known missed event and false hypotheses. Implement `scripts/evaluate.mjs`; save a reproducible report to `web/benchmark.json`. Baseline must retain the same score threshold and one-to-one matching.
- [x] 3. Implement `web/index.html`, `web/style.css`, `web/app.mjs`: load/import, queue filters, incident evidence, local-media review, reasoned dispositions, policy controls and replayable export/import. Verify happy and malformed flows in a real browser, including 390px layout and keyboard focus.
- [x] 4. Write Python annotation QA tests, observe failures, implement `scripts/audit_annotations.py` for interval integrity, conflicting labels and video-level split leakage. Run the CLI on deliberate good/bad examples and document exit codes.
- [x] 5. Write README, case study, source ledger, model/data boundaries, critic contract and ranked backlog. A separate critic attempts to break the operator workflow; fix verified issues and rerun impacted checks.
- [x] 6. Publish only reviewed files, verify CI/remote head and live asset bytes, add additive links on the existing GitHub profile and site. Preserve unrelated work and verify both deployments.

## Accepted scope additions

- [x] Real self-hosted small-model inference, image/video pipeline, rule candidates and end-to-end verification.
- [x] Chinese-first enterprise dashboard instead of presentation-led landing page.
- [x] Two independent critic rounds and fixes for recoverability, dates, draft loss, media races and manual-routing overrides.
- [x] Final remote CI, publication and live verification. See ../../VALIDATION.md.
