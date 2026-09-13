# Listing in the DSH plugin market

The market app (`dshmarket`) does not take submissions itself. To quote its own README:

> **This repo is the market app, not the catalog.** The plugin list comes from the curated
> [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry — to get
> your plugin listed in the market, open a PR **there** (one entry in the list; the site and this
> market pick it up automatically, usually within a day).

and, on the install side:

> Installs are restricted to sources listed in the curated registry — anything else is rejected.

So there are two account-bound actions, and one file to add.

## Two things only the repository owner can do

Both need a GitHub account with access to `Meaple-SFKY/dsh-model-orchestrator`:

1. **Add the `dsh-plugin` topic** to the repository (Settings → Topics, or the gear beside "About").
   The registry requires it.
2. **Open the pull request** described below. It is a PR against someone else's repository, so it
   cannot be made on your behalf.

## The submission is one file

Per the registry's [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md),
a PR adds exactly one file, `data/plugins/<owner>__<repo>.yml`. For this repository that is
`data/plugins/Meaple-SFKY__dsh-model-orchestrator.yml`, with this content:

```yaml
url: https://github.com/Meaple-SFKY/dsh-model-orchestrator
name: Meaple-SFKY/dsh-model-orchestrator
category: model
description:
  en: Model routing for DeepSeek Harness, with a standing capability-to-model assignment table, per-route reasoning levels, and a user-triggered sync that researches public model prices.
  zh: 为 DeepSeek Harness 提供模型路由：可持久化的「能力→模型」分工表、按路由的推理档位，以及手动触发的公开价格同步。
```

Notes that matter to a reviewer:

- **`category: model`** — the registry's own category list includes `model`, which is what this is:
  it selects among the models the deployment offers. `usage` or `dev` would also fit loosely; `model`
  is the honest one.
- **The English description is one line and claims nothing unverifiable.** The registry says it
  checks every submission against its source ("if a description claims '46 tools', someone counts
  them"), so it names three things that are true and countable: the assignment table, the per-route
  reasoning levels, and the sync. It deliberately does not say "smartest routing" or "best model
  selection".
- The `zh` line is optional; it is supplied because this project maintains both languages.

## Requirements the repository already meets

| Registry requirement | Where |
|---|---|
| Declares a `dsh.bundle` manifest in `package.json` | `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| A `cordis.patch.yml` beside it, inserting the row | `cordis.patch.yml` — `id: model-orchestrator`, `name: 'dsh-model-orchestrator'` |
| Installs with `dsh plugin add` | Verified against the packed artifact from a clean directory; the bundle patch's row name matches the package name |
| Real, working code (not a placeholder or README-only repo) | `lib/` is ~4.5k lines across 22 modules; `npm test` runs 293 checks, 0 skipped |
| Actively maintained | `.github/workflows/test.yml` runs the suite on Node 22 and 24 for every push and PR |
| Descriptions state what it does, no superlatives | See the entry above |

## Two requirements to be aware of

- **The repository must be at least one day old.** This is checked automatically by the registry's
  CI. A repository created minutes before the PR is rejected — finish the work, then submit.
- **The registry's host-compatibility display reads `engines.dsh`.** This release declares
  `0.1.5-rc.1` exactly, because every contract in `DESIGN.md` was verified against that build. A
  deployment on a different harness build will show as a **confirmed mismatch** in the market's
  host filter, and the plugin itself refuses to activate against it with a precise reason. Widening
  that range is a deliberate decision, not a packaging detail: it would claim compatibility with a
  build whose service contract nobody has checked.

## Publishing to npm (what makes one-click install work)

The catalog's `npm` and `install` fields come from the npm mapping, so one-click install in the
market needs the package on npm. The name `dsh-model-orchestrator` was unclaimed in the public
registry when this was written.

```sh
npm publish --access public
```

`prepublishOnly` runs the whole test suite, so a broken build cannot be published by accident.
