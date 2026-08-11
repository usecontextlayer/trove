---
name: writing-troves
description: Use when making a trove — publishing a folder, document, page, or dataset to a URL that other people's agents can read and remix. Triggers on "make a trove", "publish this as a trove", "turn this into a trove".
---

# Writing a trove

A trove is a folder of static files served at a URL. Three things must be there, and the CLI generates all three if you don't write them:

- `index.html` — the human's page, carrying the Trove block
- `AGENTS.md` — your manual for the agent who arrives later
- `trove.json` — the record: identity, lineage, and every file with its size, media type, and digest

Write the content and `AGENTS.md`. Let the CLI do the rest.

## AGENTS.md is the part that matters

It is read by an agent that has never seen this trove and has only its URL. Say what this trove is and what it is for, what is in it and what each file holds, how to use it, and what a good remix looks like. Write prose for a competent reader. Don't restate the file list — `trove.json` has that.

## Designing the page

Most troves are utilitarian: a report, a dataset, a set of notes. Make them polished, not flashy — real typographic hierarchy, considered spacing, a chosen palette. Some are editorial and deserve a distinctive point of view. A well-composed page is never the wrong answer; an over-designed one sometimes is.

Before writing CSS, sketch the tokens: 4–6 named colors, two typefaces (a display face used with restraint, a body face), and a one-sentence layout concept. Derive every decision from them.

- Ground it in the subject. Real content, never lorem.
- Choose the neutrals. A grey biased slightly toward the accent reads as chosen; a pure mid-grey reads as unconsidered.
- Design both themes at token level: palette as custom properties on `:root`, redefined under `@media (prefers-color-scheme: dark)`, with components styled through the tokens — never directly inside the media query.
- Pair a display and a body face. If you use a webfont, self-host it in the trove rather than linking a CDN, so the trove stays self-contained.
- Lay out with flex or grid and `gap`, not per-element margins. Wide content — tables, code — gets its own `overflow-x: auto` container so the body never scrolls sideways. Use `font-variant-numeric: tabular-nums` wherever digits line up.
- Structure should encode something true. Numbered markers only if the content really is a sequence.
- Copy is design material. Name things as people recognize them, active voice, specific over clever.
- **No hidden text anywhere outside the Trove block.** Conformance fails on `display:none`, `visibility:hidden`, `hidden`, or `aria-hidden` text — which rules out `sr-only` spans and JS-revealed accordions. Everything on the page is visible.

Avoid the AI-generated cluster: warm cream (#F4F1EA) with a serif display and terracotta accent; near-black with a lone acid-green pop; broadsheet hairline rules; a purple-to-blue gradient hero on white; Inter or Space Grotesk as the safe face; emoji as section markers; everything centered; `rounded-lg` everywhere. Where the user pins a direction, follow it exactly — their words win. Where nothing is specified, don't spend that freedom on a default.

## Skills (optional)

A trove may ship skills of its own — instructions teaching an agent a workflow over its content — at `skills/<name>/SKILL.md`. They ride along like any file: listed in `trove.json`, verified by digest. Agents discover them by reading the manifest.

## Publishing

`npx @usecontextlayer/trove publish <folder>` — checks conformance, deploys, verifies the served bytes, registers, and prints the canonical URL.

A publish without Cloudflare credentials is a **60-minute preview**: the CLI prints a claim URL and its deadline. Surface both to your user immediately — unclaimed, the trove is deleted within the hour.
