# Distributed assets

Kōbō source code is licensed under GPL-3.0-or-later. Dependency packages retain
their respective licenses; consult the installed packages and lockfiles.

| Asset | Provenance | License / evidence |
|---|---|---|
| `src/client/public/sounds/neutral.wav` and `ready.wav` | Original mathematical sine tones, no samples or recordings | GPL-3.0-or-later; reproducible with `node scripts/generate-notification-sounds.mjs` |
| Geist and Geist Mono | Vendored font distributions | SIL Open Font License, shipped in `src/client/public/fonts/GEIST-LICENSE.txt` |
| Quasar Material icons | Installed through `@quasar/extras` | See the package's upstream notices |

Earlier versions included recorded notification sounds without a provenance
manifest in this repository. Those files are no longer part of the current source
or newly built package. Existing sound preferences fall back to a neutral tone,
preserving notification enablement and volume. Older Git refs and published
artifacts may still contain those recordings and require a separate publication
decision; removing them from the current tree does not erase history.

Repository screenshots and the application icon still require owner confirmation
of their provenance before the public-opening gate can be marked complete.
