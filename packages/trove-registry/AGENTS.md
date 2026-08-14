# AGENTS — the registry

The only server Trove operates. A Hono Worker on D1, plus the platform's own served assets (`public/`). It is deliberately **not on the path that reads a trove**: it holds records, answers an id lookup, and serves the platform's manuals. Nothing here has to be up for a trove to be fetched, verified, or remixed.

## Deploying

```sh
pnpm run deploy        # from this directory
```

**`pnpm run deploy`, never `pnpm deploy`.** `deploy` is one of pnpm's own built-in commands — it deploys a workspace package into a directory and has nothing to do with Cloudflare. Invoked without `run`, pnpm's builtin wins and answers `ERR_PNPM_NOTHING_TO_DEPLOY`, which reads like a misconfigured repo rather than a shadowed script.

The script builds `trove.js` into `public/` first, then runs `wrangler deploy`. Remote migrations are separate: `npx tsx manage.ts latest --remote`.

**All of it lands in one Cloudflare account, and that account is not named for ContextLayer** — which is what strands whoever goes looking for it. The `usecontextlayer.com` **zone** lives there too. Run `npx wrangler whoami` to see which account you are actually pointed at; the maintainer's ops notes name it, and this file deliberately does not. The custom domain, its DNS record and its certificate were all auto-created by the first deploy — no record here was made by hand.

**Assume a checkout of this repo can deploy to production, and check before you run anything.** If wrangler holds credentials — an OAuth session or `CLOUDFLARE_*` in the environment — a casual `trove publish` lands a PERMANENT Worker in the production account rather than the anonymous 60-minute preview the author expected. `wrangler whoami` is the check, and `publish` announces which mode it chose. An agent or fleet touching this repo needs `CLOUDFLARE_*` unset AND wrangler pointed at a throwaway state dir — prose constraints are not sandboxes, and that has been demonstrated here more than once.

**A `wrangler deploy` ships the working tree, not a ref.** "The deploy is N commits behind" is not a claim anyone can make from git alone; the `standard` field in the served `https://trove.usecontextlayer.com/trove.json` is what answers it. Version preview URLs are not a pinning mechanism either — they are content-pinned, but any creator can retroactively kill all of them with `preview_urls: false`, and Cloudflare's version IDs are not externally observable.

**D1 holds the only copy of the id↔host bindings.** Nothing in this repo exports it and no restore has ever been exercised, so treat every migration, `DELETE` and `--remote` command against it as unrecoverable and check the statement twice before running it. Cloudflare's Time Travel is the recovery mechanism of last resort; read its current retention on your plan before relying on it, rather than assuming.

### The zone blocks stdlib-Python agents unless one dashboard rule holds

Cloudflare's **Browser Integrity Check** answered `403` with a 17-byte `error code: 1010` body to `Python-urllib/*` and `libwww-perl`, while `requests`, `httpx`, `aiohttp`, `curl`, `Wget` and even an EMPTY User-Agent all got 200 — the same Python client sending a curl UA got 200, which pins it to the UA string rather than to TLS fingerprinting. The platform manual tells every agent to fetch it first, so the product's first documented hop was an opaque 403 for exactly the dependency-free client the docs teach. **Verify this class of thing with stdlib Python, never curl:** curl returned 200 at every stage and would have reported success while the product was broken.

**The mitigation in place is a Configuration Rule, which is not a WAF setting**: Rules → Overview → Create rule → Configuration Rule; expression `(http.host eq "trove.usecontextlayer.com")`; Browser Integrity Check → Off. Configuration Rules are a separate product in a different part of the dashboard with their own Free-plan quota, which is why the "contact sales" wall on WAF custom rules never gated this. It is scoped to the registry hostname alone, so it protects the platform manual and nothing a creator publishes — a trove's readers get only the User-Agent note in the served `public/AGENTS.md`. **Nothing guards it, by ruling:** the set of User-Agents BIC blocks is an unpublished list Cloudflare can extend without notice, so a regression is silent, and re-fetching a platform surface with `Python-urllib` is the manual check.

**It was BIC and not Bot Fight Mode, and the distinction decides the fix.** The tells: no `cf-mitigated` header, a tiny `text/plain` body where a challenge would be a large HTML interstitial, `1010` is BIC's own code (WAF blocks are 1020), and an empty UA passed — which Bot Fight Mode would not allow. Bot Fight Mode cannot be exempted per-hostname on any plan, so the wrong diagnosis leads to a plan upgrade instead of a free rule. **Two plausible fixes each fail silently:** a WAF skip rule must skip **products → Browser Integrity Check** and never **phases** — BIC runs outside the Ruleset Engine, so a phase skip shows as matching in the logs and changes nothing, which is also why BIC fired BEFORE the Worker, identically on a static asset and on a Worker route — and the zone-wide toggle is filed under **Security → Settings → DDoS attacks**, not under Bots and not under WAF. Zone security settings reach PROXIED records only, so the question is never "what else is in this zone" but "what else is orange-clouded".

## The registry and the CLI must move together — and the Worker ships first

**Whenever a change moves the standard version, the manifest shape, the mandated block's text, or what the checker accepts, the two releases are one release.** There is no version of this that a creator can sit safely in the middle of.

**Do not look for a compatible ordering — there is not one.** The registry accepts exactly the current standard and nothing else (owner-ruled 2026-08-13: zero backward compatibility, no retired templates kept alive). So a CLI one version behind is refused, and a CLI one version ahead is refused; the skew breaks in whichever direction it exists. Any doc claiming a newer registry still accepts older CLIs is describing machinery that was deliberately deleted.

**The Worker ships first because a Worker deploy is reversible and an npm publish is not.** That is the whole tiebreak. `wrangler rollback` puts the old registry back in seconds; a published version number is spent forever, and the CLI that reads it is on strangers' machines. Ship the undoable one second.

This ordering was learned the expensive way, on 2026-08-12: `@usecontextlayer/trove@0.4.0` went to npm while the Worker was still a commit behind, and for 43 minutes the released CLI could not register anything. **Established by inspection, not observed** — no `publish` ran in that window, so no 422 was ever actually issued. What makes the conclusion certain is the deployed commit's own schema: `manifestSchema` required `canonical`, which 0.4.0 no longer emits, so `checkTrove` returns a null manifest and `POST /register` answers **422** before any row is written. `register` has no override, and republishing mints a fresh id and a fresh 60-minute clock, so a creator's only recourse would have been to watch their deployment expire.

**The refusal used to accuse the creator**, which is what made the skew expensive rather than merely broken: the old checker fell back to comparing the new block against an old template and reported the mandated block as tampered with, sending a creator to edit bytes that were correct. A version mismatch now reports itself as one — `standard N is retired` or `newer than this checker` — on both the manifest and the mandated-block checks. The window still breaks; it no longer lies about whose fault it is.

**There is no CI gate for this.** The release workflow publishes from a tag and knows nothing about what is deployed. The ordering is a human step, which is why it is written here.

**The ladder in full, in the owner's words: *"docs, commit, deploy, fresh-eyes, and then npm publish"*.** The deploy is the rung that gets dropped, and it was dropped once — from an instruction given the day after the order had been stated, and executed as given rather than questioned. **When a stated precondition is missing from an instruction, say so before executing it.** And do not reach for `git merge-base --is-ancestor <fix> <tag>` to check this: it tests *tag-precedes-fix* and says nothing about *npm-precedes-registry*, which is the skew that actually bites.

## Config traps in `wrangler.jsonc`, all measured

**`run_worker_first` must stay the ARRAY form** (`["/register", "/a/*"]`). Only those paths invoke the Worker; everything else — `/trove.js`, `/AGENTS.md`, `/skills/**` — stays on the free, unmetered asset path. The boolean `true` meters every asset request against the free plan's 100k/day cap and starts returning 429 with no asset fallback.

**`not_found_handling` must stay `"none"`.** Anything else, combined with the array form above, makes the asset worker claim every unmatched path and the Worker never sees a 404 — including the deleted `/a/<id>/*` subtree, whose 404 is now load-bearing.

**`html_handling` is `"auto-trailing-slash"`** so the landing page resolves at `/`. `"none"` would 404 the root.

## The platform's own trove

`public/trove.json` is **committed, not built**, and `tests/platform-manifest.test.ts` is what keeps it honest: it recomputes every listed digest from the real bytes. **Edit anything under `public/` → rerun `npx tsx manage.ts manifest`**, or CI fails on stale digests.

The platform is a trove *in spirit, not in exactness* (owner-ruled): its id is its own URL, and its pages are deliberately indexable, while `X-Robots-Tag: noindex` stays unconditional on the trove routes in Worker code. Nothing may treat the manifest's id claim as proof of being the platform — `trove.js` detects that by location, because a manifest can be faked.

## Testing

`vitest.config.ts` imports `trove-standard`'s **built dist at config-load time** to build its fixture. Running `vitest` directly in this package after editing trove-standard source uses the stale dist; through turbo (`^build`) it never bites. The fixture renders the real mandated block, so it must declare `CURRENT_STANDARD` — a fixture claiming an older version compares new markup against an old template and stops being conformant.
