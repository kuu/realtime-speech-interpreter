## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## How it was tested

- [ ] `cd app && npm run build && npm run typecheck && npm test`
- [ ] `cd cdk && npx tsc --noEmit && npm test` (and `npx cdk synth -q -c venueCidr=203.0.113.10/32` if infrastructure changed)
- [ ] `node dictionaries/validate.mjs` (if dictionaries changed)
- [ ] `node scripts/check-publishable.mjs`

## Checklist

- [ ] No account IDs, real IP addresses, secrets, customer or speaker names, or internal links in code, docs, or samples
- [ ] Docs updated (README, `docs/`) if behavior or configuration changed
- [ ] Product names are unchanged in anything shown to listeners (use dictionary subs or aliases instead)
