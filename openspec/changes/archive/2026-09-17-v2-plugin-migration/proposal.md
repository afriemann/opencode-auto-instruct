## Why

opencode's real V2 product (`@opencode/cli`/`@opencode/plugin`) uses a
different plugin SDK (`Plugin.define({id, setup(ctx)})`) than this plugin's
current V1 implementation. V1 plugins do not run under V2 at all. This
plugin needs a real, verified V2 port before the V1 compatibility window
closes, while continuing to support V1 users unchanged — following the same
`core.js` + versioned-adapter pattern already shipped for `opencode-use`.

## What Changes

- Extract a runtime-agnostic `src/core.js`: rule loading/merging, agent
  filtering, condition evaluation (all 12 condition types, todo-transition
  state tracking), and instruction-framing text. `src/plugin.v1.js`
  (renamed from `src/index.js`) becomes a thin V1 adapter over it.
- New `src/plugin.v2.js`: V2 `Plugin.define` adapter mapping:
  - the generic `event` hook → `ctx.event.subscribe()` (async iterator over
    the full event stream).
  - `client.session.get` → `ctx.session.get({sessionID})`.
  - `client.session.promptAsync({system, noReply, agent, parts:[{text,
    synthetic}]})` → **`ctx.session.synthetic({sessionID, text, description,
    resume})`** — V2's documented mechanism for injecting an out-of-band
    message, distinct from `ctx.session.prompt` (which has no
    system/hidden/synthetic framing in its schema). `resume: false` is the
    documented equivalent of V1's `noReply: true` ("schedule agent-loop
    execution unless resume is false" — confirmed via the official V2 API
    reference). Hidden framing (V1's `rule.hidden`) maps to omitting
    `description` (undocumented in prose but confirmed via source: the V2
    TUI renders a synthetic row only when `description` is non-empty).
  - `client.app.log` → the same stderr-fallback pattern as `opencode-use`'s
    V2 port (V2's `Context.app` has no `log` method).
- **Known behavioral gap, documented not silently accepted:** V1's
  per-call `agent` override (`rule.switchToAgent`) has no per-call V2
  equivalent. V2's only agent-switch mechanism, `ctx.session.switchAgent`,
  is documented as changing "the agent used by **subsequent** provider
  turns" — a persistent, session-level change, not scoped to one injected
  message. A rule using `switchToAgent` on V2 will therefore leave the
  session permanently on that agent after the injected instruction, not
  just for that one delivery. This must be surfaced to plugin config
  authors, not silently changed to a different (wrong) meaning.
- **Verification requirement, not yet confirmed:** a filed upstream issue
  (against a beta build) reported that `ctx.session.synthetic()` messages
  did not reach the model-visible prompt context on that build. This is the
  single most important thing to verify empirically against the pinned
  `@opencode/cli` 2.0.4 release before considering this port done — the
  entire plugin's purpose is for the agent to actually see the injected
  instruction.
- Add a test suite (this repo currently has none) covering `core.js`'s rule
  loading, agent filtering, and all 12 condition types, plus adapter-
  conformance tests for both `plugin.v1.js` and `plugin.v2.js`, plus a real
  end-to-end script against `@opencode/cli`.
- Rewrite `docs/v2-compat-audit.md` to describe the real V2 port (the
  existing doc tested against `opencode-ai@dev`, which is not V2).

## Capabilities

### New Capabilities
- `rule-based-instruction-injection`: no spec existed for this plugin's
  behavior before this change (this repo had no `openspec/specs/` at all).
  Authored as a full ADDED-requirements spec describing the target-state
  behavior across both runtimes (including the V1-vs-V2 `switchToAgent`
  scoping difference), since there is no prior baseline to modify.

### Modified Capabilities
(none — this is the capability's first spec)

## Impact

- `src/index.js` → renamed `src/plugin.v1.js` (`git mv`, behavior
  unchanged), reduced to a V1 adapter.
- `src/core.js` (new): extracted runtime-agnostic rule/condition logic.
- `src/plugin.v2.js` (new): V2 adapter.
- `package.json`: `main`/`exports` (`.`, `./v1`, `./v2`), both peer deps
  optional, `@opencode/plugin` + `@opencode/cli` devDependencies, test
  scripts.
- New `test/` directory (none exists today).
- `docs/v2-compat-audit.md`: rewritten.
- `openspec/specs/rule-based-instruction-injection/spec.md`: new baseline
  spec + this change's delta.
