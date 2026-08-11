---
name: writing-troves
description: Use when making a trove — publishing a folder, document, page, or dataset to a URL that other people's agents can read and remix. Triggers on "make a trove", "publish this as a trove", "turn this into a trove".
---

# Writing a trove

A trove is a folder of static files served at a URL. Three things must be there, and the CLI generates all three if you don't write them:

- `index.html` — the human's page, carrying the Trove block
- `AGENTS.md` — your manual for the agent who arrives later
- `trove.json` — the record: identity, lineage, and every file with its size, media type, and digest

Write the content and `AGENTS.md`. The CLI does the rest — including the Trove block itself: **it injects the block at publish, so never write one yourself.** The block carries the trove's id, and the id does not exist until you publish.

## AGENTS.md is the part that matters

It is read by an agent that has never seen this trove and has only its URL. Say what this trove is and what it is for, what is in it and what each file holds, how to use it, and what a good remix looks like. Write prose for a competent reader. Don't restate the file list — `trove.json` has that.

## Designing the page

**The CLI's generated page is a fallback for when you have nothing to say. Write your own whenever the content deserves one** — which is most of the time.

Most troves are utilitarian: a report, a dataset, a set of notes. Make them polished, not flashy — real typographic hierarchy, considered spacing, a chosen palette. Some are editorial and deserve a distinctive point of view. A well-composed page is never the wrong answer; an over-designed one sometimes is.

Before writing CSS, sketch the tokens: 4–6 named colors, two typefaces (a display face used with restraint, a body face), and a one-sentence layout concept. Derive every decision from them.

- Ground it in the subject. Real content, never lorem.
- Choose the neutrals. A grey biased slightly toward the accent reads as chosen; a pure mid-grey reads as unconsidered.
- Design both themes at token level: palette as custom properties on `:root`, redefined under `@media (prefers-color-scheme: dark)`, with components styled through the tokens — never directly inside the media query.
- Pair a display and a body face. If you use a webfont, self-host it in the trove rather than linking a CDN, so the trove stays self-contained.
- Lay out with flex or grid and `gap`, not per-element margins. Wide content — tables, code — gets its own `overflow-x: auto` container so the body never scrolls sideways. Use `font-variant-numeric: tabular-nums` wherever digits line up.
- Structure should encode something true. Numbered markers only if the content really is a sequence.
- Copy is design material. Name things as people recognize them, active voice, specific over clever.
- **No hidden text anywhere outside the Trove block** — see below.

Avoid the AI-generated cluster: warm cream (#F4F1EA) with a serif display and terracotta accent; near-black with a lone acid-green pop; broadsheet hairline rules; a purple-to-blue gradient hero on white; Inter or Space Grotesk as the safe face; emoji as section markers; everything centered; `rounded-lg` everywhere. Where the user pins a direction, follow it exactly — their words win. Where nothing is specified, don't spend that freedom on a default.

## The hidden-text rule, and why it exists

The `anti-cloaking` check is gating and absolute: **hidden text may live only inside the Trove block.** The reason is the threat it answers — a fetching agent is handed hidden text verbatim, with no signal that a human could not see it, which is exactly how a page tells an agent one thing and a person another. The Trove block is the single sanctioned exception, and the script reveals it to the human.

So `sr-only` spans and JS-revealed accordions fail conformance. **The check reads the HTML your server sends, not a live DOM** — so an element that is empty in the served bytes and filled by JavaScript carries no hidden text and passes.

What v1 actually detects in the served markup: `display:none` and `visibility:hidden` written as inline styles, and the `hidden` attribute. Hiding through a CSS class or stylesheet, off-screen positioning, zero-size or transparent text all still violate the rule — they are simply not caught yet, so do not read "it passed" as "it is allowed".

## What conformance checks

Seven checks, run identically on your machine before publishing, at the registry, and by anyone about to remix you:

| check | what it asserts |
|---|---|
| `mandated-block` | `/` returns HTML carrying exactly one Trove block, unmodified |
| `manifest` | `/trove.json` parses, the id is well-formed, the canonical URL matches it |
| `agents-md` | `/AGENTS.md` returns non-empty markdown |
| `files` | every file in the manifest serves from this origin with matching media type, byte length, and digest |
| `noindex` | every response carries `X-Robots-Tag: noindex` — unconditional for every trove, and the CLI generates it for you |
| `caps` | at most 1,000 files and 25 MB total |
| `anti-cloaking` | no hidden text outside the Trove block |

The registry reports `files` and `caps` as *not checked*: a digest verified at registration is stale the moment you redeploy, and the position that needs them verified is the agent about to trust your bytes.

## Skills (optional)

A trove may ship skills of its own — instructions teaching an agent a workflow over its content — at `skills/<name>/SKILL.md`. They ride along like any file: listed in `trove.json`, verified by digest. Agents discover them by reading the manifest.

## Publishing is two steps

They are separate commands and **neither runs the other**. Publishing puts the bytes online; registering certifies them and is what creates the canonical URL.

```
npx @usecontextlayer/trove publish <folder>
npx @usecontextlayer/trove register <host-url>
```

`publish` checks the folder, deploys it, verifies the bytes that came back, and prints the trove's `host:` URL. It prints no canonical URL, because there is not one yet.

`register` takes that host URL, reads the trove's id from the `trove.json` it serves, and prints the `canonical:` URL. **Give people the canonical URL** — it is the trove's identity and it survives the trove moving. A trove that fails its checks is still registered, with the failing report stored and published; the command prints it and exits non-zero.

A publish without Cloudflare credentials is a **60-minute preview**: the CLI prints a claim URL and its deadline. Surface both to your user immediately — unclaimed, the trove is deleted within the hour, and registering it does not extend that clock.
