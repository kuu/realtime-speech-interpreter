# Contributing

Issues and pull requests are welcome. This is a personal, unofficial project.

Before you open a pull request, run the checks from the repository root (no AWS credentials needed):

```bash
(cd app && npm ci && npm run build && npm run typecheck && npm test)
(cd cdk && npm ci && npx tsc --noEmit && npm test)
node dictionaries/validate.mjs dictionaries/example
node dictionaries/build.mjs generate --check --dir dictionaries/example
node --test "dictionaries/test/*.test.mjs"
python3 -m unittest discover -s e2e/lib -p 'test_*.py'
node scripts/check-diagram.mjs
node scripts/check-links.mjs
./scripts/check-publishable.sh
```

- The three dictionary files in `dictionaries/example/` are generated. Do not edit them by hand: change
  `dictionaries/example/terms.csv`, run `node dictionaries/build.mjs generate --dir dictionaries/example`, and commit
  both. CI fails when `generate --check` finds a difference. Your own dictionary goes in `dictionaries/local/`
  (gitignored); `check-publishable.sh` fails if a file there is tracked.
- Match the existing code style. Keep changes small and focused.
- If you change the diagram, edit `docs/architecture.drawio.svg` in draw.io (or its embedded XML), then run `scripts/export-diagram.sh` (needs draw.io Desktop) or at least `scripts/scrub-drawio.sh docs/architecture.drawio.svg`. See [docs/architecture.md](docs/architecture.md).
- If you add or change a CDK setting, document it in `docs/configuration.md` (a test fails otherwise).
- Do not commit account IDs, IP addresses, secrets or recordings. `check-publishable.sh` looks for them.
- `npm ci` in `cdk/` may report vulnerabilities in packages bundled inside `aws-cdk-lib` (for example
  `minimatch` and `brace-expansion`). They run only on your machine during `cdk synth` and `cdk deploy` and are
  not part of the deployed app. Do not run `npm audit fix --force` there: it changes the pinned `aws-cdk-lib`
  version, the CDK CLI then no longer matches ("Cloud assembly schema version mismatch"), and synth fails.
  To fix the warnings, upgrade `aws-cdk-lib` and `aws-cdk` together in one change, then check that
  `npx cdk synth` still works and review `npx cdk diff` before deploying.
- Feature ideas: see [docs/roadmap.md](docs/roadmap.md) and open an issue before a large change.

By contributing you agree that your contribution is licensed under the MIT License (see `LICENSE`).
