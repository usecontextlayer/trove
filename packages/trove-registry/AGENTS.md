# AGENTS — the registry

The only server Trove operates. A Hono Worker on D1, plus the platform's own served assets (`public/`). It is deliberately **not on the path that reads a trove**: it holds records, answers an id lookup, and serves the platform's manuals. Nothing here has to be up for a trove to be fetched, verified, or remixed.

## Deploying

```sh
pnpm run deploy        # from this directory
```

**`pnpm run deploy`, never `pnpm deploy`.** `deploy` is one of pnpm's own built-in commands — it deploys a workspace package into a directory and has nothing to do with Cloudflare. Invoked without `run`, pnpm's builtin wins and answers `ERR_PNPM_NOTHING_TO_DEPLOY`, which reads like a misconfigured repo rather than a shadowed script.

The script builds `trove.js` into `public/` first, then runs `wrangler deploy`. Remote migrations are separate: `npx tsx manage.ts latest --remote`.

## The registry and the CLI must move together — and the Worker ships first

**Whenever a change moves the standard version, the manifest shape, the mandated block's text, or what the checker accepts, the two releases are one release.** There is no version of this that a creator can sit safely in the middle of.

**Do not look for a compatible ordering — there is not one.** The registry accepts exactly the current standard and nothing else (owner-ruled 2026-08-13: zero backward compatibility, no retired templates kept alive). So a CLI one version behind is refused, and a CLI one version ahead is refused; the skew breaks in whichever direction it exists. Any doc claiming a newer registry still accepts older CLIs is describing machinery that was deliberately deleted.

**The Worker ships first because a Worker deploy is reversible and an npm publish is not.** That is the whole tiebreak. `wrangler rollback` puts the old registry back in seconds; a published version number is spent forever, and the CLI that reads it is on strangers' machines. Ship the undoable one second.

This ordering was learned the expensive way, on 2026-08-12: `@usecontextlayer/trove@0.4.0` went to npm while the Worker was still a commit behind, and for 43 minutes the released CLI could not register anything. **Established by inspection, not observed** — no `publish` ran in that window, so no 422 was ever actually issued. What makes the conclusion certain is the deployed commit's own schema: `manifestSchema` required `canonical`, which 0.4.0 no longer emits, so `checkTrove` returns a null manifest and `POST /register` answers **422** before any row is written. `register` has no override, and republishing mints a fresh id and a fresh 60-minute clock, so a creator's only recourse would have been to watch their deployment expire.

**The refusal used to accuse the creator**, which is what made the skew expensive rather than merely broken: the old checker fell back to comparing the new block against an old template and reported the mandated block as tampered with, sending a creator to edit bytes that were correct. A version mismatch now reports itself as one — `standard N is retired` or `newer than this checker` — on both the manifest and the mandated-block checks. The window still breaks; it no longer lies about whose fault it is.

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
