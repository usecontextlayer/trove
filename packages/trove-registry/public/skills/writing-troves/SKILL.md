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
- **Pin nothing to the top of the viewport.** Trove renders a thin bar above your page and shifts the page down to make room for it. A `position: sticky` or `position: fixed` element anchored at the top resolves against the viewport, not against the shifted page, so it slides underneath the bar the moment the reader scrolls — and nothing in your CSS or ours can prevent that. Keep navigation in the flow of the page, and size full-height sections in something other than `100vh`, which overflows by the bar's height.
- **Your filenames are part of the interface.** The bar opens onto a details panel that renders `trove.json` as a file tree, so every path you publish is something a reader sees — `notes/temperature-study.md` reads; `notes/tmp2.md` does not.
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
| `manifest` | `/trove.json` parses, its id is well-formed, and the same id appears in the Trove block |
| `agents-md` | `/AGENTS.md` returns non-empty markdown |
| `files` | every file in the manifest serves from this origin with matching media type, byte length, and digest |
| `noindex` | every response carries `X-Robots-Tag: noindex` — unconditional for every trove, and the CLI generates it for you |
| `caps` | at most 1,000 files and 25 MB total |
| `anti-cloaking` | no hidden text outside the Trove block |

The registry reports `files` and `caps` as *not checked*: a digest verified at registration is stale the moment you redeploy, and the position that needs them verified is the agent about to trust your bytes.

## Text encoding

**Write your text files in UTF-8 and you can ignore this section** — publishing declares `charset=utf-8` for you, and nothing is required of you.

Why it needs declaring: the host states no encoding of its own, and markdown has no in-band mechanism the way HTML has `<meta charset>`. An `AGENTS.md` served without a declared charset is decoded as CP1252 by whoever reads it, so an em dash reaches them as `â€"`.

**Other encodings still publish.** A charset is declared only where it is true, because a declared charset outranks the bytes' own signals — and for HTML it outranks your `<meta charset>` too, so claiming UTF-8 over a Latin-1 page would corrupt it. One gotcha follows from the declaration being per-extension: if two files share an extension and only one is UTF-8, neither gets a charset declared. Keeping one encoding per extension avoids it.

**Non-text files are never touched.** Images, video, audio, PDFs, spreadsheets, and archives are copied byte for byte, never inspected for encoding, and never given a charset.

## Skills (optional)

A trove may ship skills of its own — instructions teaching an agent a workflow over its content — at `skills/<name>/SKILL.md`. They ride along like any file: listed in `trove.json`, verified by digest. Agents discover them by reading the manifest.

## Publishing is two steps

They are separate commands and **neither runs the other**. Publishing puts the bytes online — the trove is readable by anyone from that moment. Registering claims its id and publishes an independent verdict about it.

```
npx @usecontextlayer/trove publish <folder>
npx @usecontextlayer/trove register <trove-url>
```

`publish` checks the folder, deploys it, verifies the bytes that came back, and prints the trove's URL. **That URL is the trove** — there is no second one, and nothing you publish routes through Trove. Share it.

`register` takes that URL and reads the trove's id from the `trove.json` it serves, which is also what proves you control the trove you are registering. A trove that fails its checks is still registered, with the failing report stored and published; the command prints the failures and exits non-zero.

A publish without Cloudflare credentials is a **60-minute preview**: the CLI prints a claim URL and its deadline. Surface both to your user immediately — unclaimed, the trove is deleted within the hour, and registering does not extend that clock.

## Always register — here is what it actually buys

Registering does not make your trove readable. It already is, served from your own account, with Trove nowhere on the path. What registering closes is three things a trove cannot establish about itself. Skip it and each one stays open.

**Someone else can claim your id.** An id binds to one URL forever, and the binding goes to whoever registers it first. Until you do, anyone can take the id out of your published `trove.json`, serve a copy of your trove from a URL they control, and register that. From then on the public record for your id describes their copy — and yours is the one that can no longer be registered, because the id is taken.

**"Verified" written on a page is worth nothing.** Any page can claim anything, so a trove asserting its own conformance is a stranger vouching for themselves. The registry's record is the only verdict a reader can consult that your trove's author did not write. That is precisely why it is a lookup and not a badge.

**A remix naming you as parent cannot be corroborated.** Lineage records a parent's URL and the digest of its manifest at the moment it was remixed. A reader who wants to know whether that parent is what the remix claims has nothing independent to check against unless the parent was recorded.

The verdict is also worth more than your own run of the same checks, for a reason that has nothing to do with trust in you: it is produced from a position where your machine, your network and your assumptions are not involved.
