# Adaptive Spaced Repetition

An [Obsidian](https://obsidian.md) plugin that schedules note reviews using an adaptive
forgetting-curve model. Instead of a fixed interval table (1 day, 3 days, 7 days, ...), each
note gets its own forgetting rate that adapts from your actual review history — notes you
recall easily drift toward longer gaps, notes you forget snap back to shorter ones.

## The model

Recall probability is modeled as an exponential decay since the last review:

```
n(t) = exp(-theta * (t - t_last))
```

- `t_last` — date of the last review
- `theta` — the note's personal forgetting rate (higher = forgotten faster)
- `n(t)` — predicted probability of recall right now

**Scheduling.** Pick a threshold (default 0.90). The next review is scheduled for the day
`n(t)` is predicted to decay to that threshold:

```
gap_days    = -ln(threshold) / theta
next_review = last_reviewed + gap_days
```

**Adapting theta.** After each review:

```
theta_new = theta_old * ALPHA                    if recall succeeded (ALPHA ≈ 0.70 — theta shrinks, gaps grow)
theta_new = min(theta_old * BETA, THETA_INIT)     if recall failed    (BETA  ≈ 1.60 — theta grows, gaps shrink, capped at the initial guess)
```

Defaults: `THETA_INIT = 0.05`, `THRESHOLD = 0.90`, `ALPHA = 0.70`, `BETA = 1.60` — all
editable in Settings → Adaptive Spaced Repetition.

This plugin is a port of the logic validated in
[`forgetting_curve_sim.py`](forgetting_curve_sim.py) (a matplotlib prototype), adapted
to run live inside Obsidian against real per-note frontmatter instead of a synthetic
simulation.

## Frontmatter schema

The plugin reads and writes review state directly in each note's frontmatter, via Obsidian's
own frontmatter API (no manual YAML parsing):

```yaml
---
created: 2026-08-02
last_reviewed: 2026-08-13
theta: 0.02744
next_review: 2026-08-17
review_history:
  - date: 2026-08-03
    outcome: pass
  - date: 2026-08-06
    outcome: pass
  - date: 2026-08-10
    outcome: fail
  - date: 2026-08-13
    outcome: pass
---
```

Nothing else about the note is touched — add this to any existing note and its content is
left as-is.

## Features

Four ways to interact with the schedule, all under the **Adaptive Spaced Repetition** /
`asr-*` command IDs (open the command palette with `Ctrl/Cmd+P` and search "Adaptive" or the
command name below):

- **Add current note to review schedule** — stamps `created`, `theta`, `next_review` (due
  today), and an empty `review_history` onto the active note.
- **Review current note** — a quick Pass / Fail popup for the active note. Grading updates
  `theta`, recomputes `next_review`, and appends to `review_history`. Auto-initializes the
  note first if it isn't tracked yet.
- **Show due notes** — also available from the ribbon icon (circular arrow). Pops up a list
  of every tracked note with `next_review <= today`, sorted most-overdue first, each with
  inline Pass/Fail buttons so you can grade straight from the list.
- **Show recall curve for current note** — pops up a chart of the active note's actual
  `review_history` plotted against the forgetting-curve model: the decay curve per interval,
  pass/fail markers, a dashed threshold line, and a "today" marker. This replays the note's
  *real* recorded review dates and outcomes (not an idealized on-schedule simulation), so it
  correctly handles messy real data — e.g. two reviews logged on the same day render as
  jittered side-by-side markers instead of overlapping.

### Embedding the due list in a note

The due-notes list can also be embedded inline in any note's reading view, instead of only
popping up as a modal — useful for a dashboard/MOC note. Add a fenced code block with the
`asr-due` language:

````markdown
```asr-due
```
````

It renders the same list, with the same working Pass/Fail buttons and a ↻ refresh button.
The block re-renders automatically whenever Obsidian re-renders the note (reopening it,
switching from source to reading view, etc.); use the refresh button to force an update
without leaving the note — e.g. after the day rolls over, or after grading a note from
somewhere else in the same session.

## Installation

Manual install (no build step required — a working `main.js` is committed in this repo):

1. Copy this folder into `<your-vault>/.obsidian/plugins/adaptive-spaced-repetition/`.
2. In Obsidian: Settings → Community plugins → turn off Restricted mode (if not already) →
   enable **Adaptive Spaced Repetition**.

## Development

`main.js` is a hand-written CJS build of [`src/main.ts`](src/main.ts) — the TypeScript file
is the source of truth. If you edit `src/main.ts`, rebuild with:

```bash
npm install
npm run build      # one-off production build -> main.js
npm run dev         # watch mode
```

## Settings

| Setting | Meaning | Default |
|---|---|---|
| Initial theta | Starting forgetting rate for newly-added notes | `0.05` |
| Review threshold | Recall probability that triggers the next review | `0.90` |
| Alpha (pass multiplier) | theta multiplier after a successful recall (< 1, gaps grow) | `0.70` |
| Beta (fail multiplier) | theta multiplier after a failed recall, capped at initial theta (> 1, gaps shrink) | `1.60` |

## License

MIT
