# Trove

A **trove** is a set of static files published at a URL. Any agent can fetch it, verify it, and remix it into a new trove of its own. Nothing is installed, nothing is negotiated, and no account is needed to publish one.

**Trove** (capitalised) is the platform that records and certifies those URLs: <https://trove.usecontextlayer.com>. A trove is served from its creator's own account, so reading one never involves Trove at all.

```sh
npx @usecontextlayer/trove publish ./my-folder     # prints the trove's URL
npx @usecontextlayer/trove register <trove-url>     # claims the id, publishes a verdict
npx @usecontextlayer/trove remix <trove-url>        # verified fetch of someone else's
```

> **Publishing and registering are two commands, and neither runs the other.** Publishing puts the bytes online — the trove is readable immediately, from the creator's own account. Registering binds the id to that URL and publishes an independent verdict about it; it is required of a creator and optional to a reader.

> With no Cloudflare credentials, publishing gives you a **60-minute preview** — the CLI prints a claim URL and its deadline, and the deployment is deleted unless you open it. With any wrangler credential, it publishes permanently into that account.

## What the standard says

The standard is an **HTTP contract**: it says what must be true when you fetch a trove's URL, and nothing about how you organise files locally. A trove serves, at minimum:

| path | response |
|---|---|
| `/` | 200 `text/html`, carrying the mandated block — a hidden `div[data-trove]` naming the trove's manuals as plain text, plus a `<script>` tag byte-identical across every trove |
| `/AGENTS.md` | 200 `text/markdown` — the creator's manual for an agent that has never seen this trove |
| `/trove.json` | 200 `application/json` — identity, lineage, and every served file with its size, media type and `sha256` digest |
| `/skills/<name>/SKILL.md` | optional; when present it is ordinary trove content, listed in the manifest |

Everything the trove serves appears in `trove.json`, so a remix is deterministic and every byte is verifiable. `X-Robots-Tag: noindex` is unconditional on every trove response.

**Trove does not host.** Troves are served from the creator's own Cloudflare account; the registry serves a redirect, a script, and a record. **There is no discovery surface** — a trove reaches you only because a person handed you the URL.

## Repository layout

| package | what it is |
|---|---|
| `packages/trove-standard` | the contract as code: id grammar, the mandated block, the `trove.json` schema, and the conformance checker. Runs in node, workerd and the browser |
| `packages/trove-registry` | the registry: a Hono Worker on Cloudflare with D1, plus the platform's own served assets |
| `packages/trove-cli` | `@usecontextlayer/trove` — the `trove` binary: `publish`, `register` and `remix` |
| `packages/trove-embed` | `trove.js` — the self-contained browser script every trove loads |

One conformance checker runs in three positions — the creator's machine before publishing, the registry at registration, and a remixing agent before trusting a trove — so certification can never drift from authoring.

## Working on it

Requires [mise](https://mise.jdx.dev) (which pins node and pnpm). A fresh checkout needs `mise trust` once.

```sh
pnpm install --frozen-lockfile

npx turbo run tsc test format.verify build   # everything CI runs
npx turbo run test --filter=@usecontextlayer/trove-standard
npx turbo run build --filter=@usecontextlayer/trove-registry...
```

Package names, which do not all match their directories: `@usecontextlayer/trove` (the CLI), `@usecontextlayer/trove-standard`, `@usecontextlayer/trove-registry`, `@usecontextlayer/trove-embed`.

**Tests** are sorted by filename suffix along two axes, runtime and tier: `*.test.ts` (node), `*.browser.test.ts` (chromium), `*.worker.test.ts` (real workerd), `*.node.integration.test.ts` (needs a live prerequisite). **CI runs the unit tier only**, so anything that must be covered in CI belongs in a bare `*.test.ts` or `*.worker.test.ts`.

**Formatting and linting** is biome via the installed binary (`./node_modules/.bin/biome`): tabs, 90 columns, no semicolons, double quotes, sorted imports and keys. Internal imports use the `@/` alias, never relative paths.

### Running and deploying the registry

```sh
cd packages/trove-registry
pnpm run dev                                  # local, against a local D1
npx tsx manage.ts latest                      # apply migrations locally
npx tsx manage.ts latest --remote             # apply migrations to production D1
npx turbo run build --filter=@usecontextlayer/trove-registry...
npx wrangler deploy
```

`pnpm run deploy`, not `pnpm deploy` — the latter is pnpm's own builtin and silently does something else. Build through turbo first: the package's own `build` only copies `trove.js` out of `trove-embed/dist`, so a bare deploy can ship a stale script.

The production D1 database is the **only** store of id↔host bindings. There is no revocation route and no host-move route: an id binds to one host permanently.

## Releasing the CLI

Publishing to npm happens in CI, never from a laptop — `.github/workflows/release.yml` runs on a `v*` tag and uses an `NPM_TOKEN` held only in the repository's Actions secrets.

```sh
# bump packages/trove-cli/package.json, commit, then:
git tag v0.1.0 && git push origin v0.1.0
```

The workflow refuses to publish if the tag and the package version disagree.

**Always use the scoped name.** `npx trove` resolves an unrelated third party's package on npm and executes it, so any doc, skill, or error message telling an agent how to publish must say `npx @usecontextlayer/trove`.

## Contributing

The HTTP contract is the product: **code implements the standard, it does not amend it.** If implementing something reveals the standard is wrong or underspecified, raise it rather than working around it — that is a product decision.

`AGENTS.md` at the repo root carries the invariants and the measured traps; read it before changing anything.

## Licence

MIT — see [LICENSE](./LICENSE).
