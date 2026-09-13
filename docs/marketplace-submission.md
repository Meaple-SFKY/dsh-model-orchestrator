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
  zh: 为 DeepSeek Harness 提供模型路由：可持久化的「能力→模型」分工表、按路由的推理档位，以及手动触发、由模型联网核对公开价格的同步。
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
- The `zh` line is optional; it is supplied because this project maintains both languages. It is
  the SAME sentence as the one in the repository's GitHub *About* field, so the market card, the
  repository listing and the registry `en`/`zh` pair cannot drift apart.

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

## npm is optional for the listing

Checked against the live catalog rather than assumed: of its 3632 entries, **1815 have no npm
package at all**, and their install command is exactly

```
dsh plugin --profile web add github:<owner>/<repo>
```

which is the same source this repository already serves. So the registry entry above is complete as
written — it has no `npm` field, and none is required. The catalog fills `npm` in from CI when a
package exists, and installs "prefer repo-verified npm packages, then author-supplied prebuilt
GitHub Release tarballs, before falling back to full-repo GitHub source downloads".

Publishing to npm is therefore optional, and worth doing only for what it adds: `npm install`
outside a DSH profile, provenance attestation, and holding the name.

### If you do want npm

Be aware of what publishing now requires — this is not the packaging being wrong:

- Publishing needs either 2FA, or a granular access token carrying the bypass-2FA flag. This
  account has 2FA **disabled**, and a plain web-login session is not accepted for publishing.
- **Enrolling TOTP is no longer possible**: `npm profile enable-2fa` fails with *"Adding a new TOTP
  2FA is no longer supported. Please add a security key 2FA method instead."* The method to add is
  a security key or passkey, at `https://npmjs.com/settings/<user>/tfa`.
- Classic token creation is disabled, and bypass-2FA granular tokens are being
  [restricted](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/)
  after the 2025 registry attacks.
- The direction npm points to is **trusted publishing (OIDC) from GitHub Actions**, which needs no
  token at all — but npm requires a package to **already exist** before a trusted publisher can be
  configured, so the first version has to go up some other way.

So the sequence, if you take it on: add a passkey as 2FA → `npm publish` once → then configure a
trusted publisher for `Meaple-SFKY/dsh-model-orchestrator` and let releases go out tokenless from
CI. Nothing about the plugin depends on any of it.
