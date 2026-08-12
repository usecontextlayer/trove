# AGENTS — the registry

The only server Trove operates. A Hono Worker on D1, plus the platform's own served assets (`public/`). It is deliberately **not on the path that reads a trove**: it holds records, answers an id lookup, and serves the platform's manuals. Nothing here has to be up for a trove to be fetched, verified, or remixed.

## Deploying

```sh
pnpm run deploy        # from this directory
```

**`pnpm run deploy`, never `pnpm deploy`.** `deploy` is one of pnpm's own built-in commands — it deploys a workspace package into a directory and has nothing to do with Cloudflare. Invoked without `run`, pnpm's builtin wins and answers `ERR_PNPM_NOTHING_TO_DEPLOY`, which reads like a misconfigured repo rather than a shadowed script.

The script builds `trove.js` into `public/` first, then runs `wrangler deploy`. Remote migrations are separate: `npx tsx manage.ts latest --remote`.

## Deploy the registry BEFORE publishing the CLI to npm

**Whenever a change moves the standard version, the manifest shape, or what the checker accepts, the Worker ships first and npm ships second.** Not the reverse, and not simultaneously.

The asymmetry is the whole reason. A registry running *newer* code still accepts troves from *older* CLIs — that is exactly what the standard's version lever is for, and it is tested. A registry running *older* code rejects troves from a newer CLI outright, because the old schema requires fields the new CLI no longer emits.

Measured, 2026-08-12: `@usecontextlayer/trove@0.4.0` went to npm while the Worker was still a commit behind. Every trove published with the released CLI got **422 from `POST /register`** and could not be registered at all — `register` has no override, and republishing mints a fresh id and a fresh 60-minute clock, so a creator's only recourse was to watch their deployment expire. Worse, the refusal *accused the creator*: with the manifest rejected the old checker fell back to standard 1, compared the new block against the old template, and reported the mandated block as tampered with. Nothing said "your CLI is newer than the registry."

Verified at the same time: the safe direction is genuinely safe. A hand-built standard-1 trove passes all seven checks against the current checker, so deploying first would have kept both CLI generations working throughout.

**There is no CI gate for this.** The release workflow publishes from a tag and knows nothing about what is deployed. The ordering is a human step, which is why it is written here.

## Config traps in `wrangler.jsonc`, all measured

**`run_worker_first` must stay the ARRAY form** (`["/register", "/a/*"]`). Only those paths invoke the Worker; everything else — `/trove.js`, `/AGENTS.md`, `/skills/**` — stays on the free, unmetered asset path. The boolean `true` meters every asset request against the free plan's 100k/day cap and starts returning 429 with no asset fallback.

**`not_found_handling` must stay `"none"`.** Anything else, combined with the array form above, makes the asset worker claim every unmatched path and the Worker never sees a 404 — including the deleted `/a/<id>/*` subtree, whose 404 is now load-bearing.

**`html_handling` is `"auto-trailing-slash"`** so the landing page resolves at `/`. `"none"` would 404 the root.

## The platform's own trove

`public/trove.json` is **committed, not built**, and `tests/platform-manifest.test.ts` is what keeps it honest: it recomputes every listed digest from the real bytes. **Edit anything under `public/` → rerun `npx tsx manage.ts manifest`**, or CI fails on stale digests.

The platform is a trove *in spirit, not in exactness* (owner-ruled): its id is its own URL, and its pages are deliberately indexable, while `X-Robots-Tag: noindex` stays unconditional on the trove routes in Worker code. Nothing may treat the manifest's id claim as proof of being the platform — `trove.js` detects that by location, because a manifest can be faked.

## Testing

`vitest.config.ts` imports `trove-standard`'s **built dist at config-load time** to build its fixture. Running `vitest` directly in this package after editing trove-standard source uses the stale dist; through turbo (`^build`) it never bites. The fixture renders the real mandated block, so it must declare `CURRENT_STANDARD` — a fixture claiming an older version compares new markup against an old template and stops being conformant.
