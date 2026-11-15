---
name: Model upgrade
about: Propose or track a change of the translation or transcription model (for example when a model reaches end of life)
labels: model-upgrade
---

**Current model ID and its end-of-life date**

**Proposed model ID** (and whether it needs an inference profile in your Region)

**Measured with `e2e/` on the same recordings**
- First-word latency (`e2eFirstWordMs`), before and after:
- Translation quality notes (terminology, numbers, product names):
- Cost per hour, before and after (`node scripts/estimate-cost.mjs`):

**Files to change** (default model ID, `scripts/cost-prices.json`, docs)
