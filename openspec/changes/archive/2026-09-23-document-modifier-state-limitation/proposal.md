# Proposal

## Why

A production consumer (a separate downstream project pinning this plugin) observed `todo-creation-note`-style `edge:"rise"` rules re-firing on a `todowrite` call that marked an already-long-running todo list as fully completed — producing a confusing bundle of contradictory instructions alongside `once`-less "all complete" rules. Root-cause investigation traced this to the documented (but not obviously discoverable) fact that `once`/`edge` modifier state (`core.js`'s `createSessionState`/`evaluate`) lives only in an in-memory `Map` scoped to the plugin's Node process (`sessionStates` in `plugin.v1.js`/`plugin.v2.js`). An opencode service restart mid-session wipes that state while the underlying conversation session continues unchanged, so the very next event is misclassified as a fresh transition.

This plugin will not persist modifier state to disk (a heavier, out-of-scope architectural change per maintainer decision) or attempt to reconstruct it from event history. Instead, many common intents that reach for `edge`/`once` — including the exact "remind me right when a todo list is freshly created" case — can already be expressed as a **stateless** `data*` condition that only inspects the current event's data, with no dependency on any transition tracked across events. Such conditions have no cross-restart durability problem at all, because they hold no state to lose.

This is a documentation-only change: no engine behavior changes. It closes the gap between "the engine has a real state-durability limitation" and "no README guidance tells a rule author when they can sidestep it."

## What Changes

- Add a new README section documenting the limitation: `once`/`edge` modifier state is held in an in-memory `Map` per plugin process and does **not** survive an opencode service/plugin restart mid-session; a rule relying on it can re-fire after such a restart.
- Recommend, with a worked example, preferring a stateless `data*` condition (e.g. `dataArrayAllMatch` on a status-like field) over `edge`/`once` whenever the intent can be fully expressed from the current event's data alone — using the "remind when a todo list is freshly created" case (previously modeled with `dataArrayNonEmpty` + `edge:"rise"`) as the worked example, re-expressed as `dataArrayAllMatch{path:"todos",field:"status",value:"pending"}` (true only while nothing has started yet, so it is not sensitive to a restart resetting rise-detection).
- No change to `core.js`, `plugin.v1.js`, `plugin.v2.js`, or any condition type — the vocabulary already supports the stateless alternative.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

_(none — no spec-level behavior changes; `skip_specs: true` set in `.openspec.yaml`)_

## Impact

- `README.md` only. No code, test, or dependency changes.
- Downstream consumers (e.g. this plugin's ai-dotfiles-based config) are expected to follow up separately by rewriting their own `once`/`edge` rules to prefer stateless conditions where the intent allows it — that rule-config change lives in the consuming project's own repository, not here.
