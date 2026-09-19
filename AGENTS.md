# Notes for coding agents

This repository is a Command Code mod. The human-facing documentation lives in
[README.md](./README.md); this file covers what an agent needs when installing or
changing the mod.

## Installing this mod into a Command Code setup

```text
GOAL: install commandcode-token-metrics into the user's Command Code setup.

1. Confirm the mod loads first:  cmd --mod <path-to-project>
   A file that fails to import, exports no factory, or throws in its factory
   becomes a warning, never a crashed session, so a broken mod fails silently.
2. Run: cmd mods add <path-to-project> -g    (user scope)
   Or project scope by omitting -g.
3. Confirm: cmd mods list  (no load warnings).
4. Tell the user to start a new session (or /reload). Mods load at startup;
   there is no in-place hot swap.
5. Do not edit the user's settings.json by hand. Do not touch sibling mods.

Options are launch-time only, set with --mod-option name=value (repeatable).
There is no settings key for them.
```

## Working in this repo

- `npm run ci` runs the unit tests, typecheck, the packed-package smoke test and
  `npm pack --dry-run`. Run it before committing.
- `index.ts` resolves its options on `session_start`, not when the factory runs,
  because `cmd.getFlag` only returns real values once the harness has bound.
- Measurement (`src/metrics.ts`) and rendering (`src/status.ts`) are pure and hold
  no mod-API imports. Keep it that way; the tests depend on it.
- House style: no em dashes in source, docs or commit messages.

## Layout

| File | Holds |
| --- | --- |
| `index.ts` | The mod factory: flags, `/tps`, the feed renderer, the paint loop |
| `src/metrics.ts` | Pure measurement: rate estimator, VU bucketing, the meter store |
| `src/status.ts` | Pure rendering: the ansi footer line and the feed summary line |
| `src/controller.ts` | Event wiring, host stream onto the meter store |
| `src/events.ts` | Defensive readers for host payloads |
| `types/commandcode-harness.d.ts` | Ambient types, so typecheck needs no dependency |

## Event contract

| Event | Effect |
| --- | --- |
| `run_start` | Opens a run, resetting the last run's data but keeping its frozen frame on screen |
| `model_request_start` | The first in a run anchors TTFT, later ones mark a new round |
| `text_delta`, `thinking_delta` | Tokenises the chunk and buckets it per second |
| `tool_running` | Closes the streaming burst, so the pause after it is not counted as generation time |
| `model_request_end` | Accumulates the provider's exact `usage.outputTokens` |
| `run_end` | Freezes the frame, rescales it to the exact total, prints the feed summary |
| `interrupted` | Freezes what was measured, since an interrupted run never emits `run_end` |

A run is one user turn, and can span several model requests, which all share one graph, one average and one token total. Streaming tokens are estimated from UTF-8 byte length, which undercounts because tool-call JSON is not a visible delta; on `run_end` the provider's reported total replaces the estimate and the graph and peak are rescaled by the same ratio.
