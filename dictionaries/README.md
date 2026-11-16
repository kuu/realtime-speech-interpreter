# Dictionaries

- `example/`: the committed example dictionary (AWS Elemental Media Services). `terms.csv` is the source; the
  three other files are generated from it.
- `local/`: your own dictionary (gitignored). Create it with `node dictionaries/build.mjs init`.
- `build.mjs`: generate, check, suggest and merge. `validate.mjs`: format checks.

Everything is explained in [docs/dictionaries.md](../docs/dictionaries.md).
