# opencode V2 Compatibility — `opencode-auto-instruct`

**Status: real V2 support shipped** (`src/plugin.v2.js`), alongside the
unchanged V1 implementation (`src/plugin.v1.js`). Both share the
runtime-agnostic rule/condition logic in `src/core.js`.

> ℹ️ **History note:** an earlier version of this document (dated
> 2026-09-15) tested this plugin against `opencode-ai@dev` and concluded no
> migration was needed. That target was **not actually V2** —
> `opencode-ai` is the V1 product's own prerelease channel. The real V2
> product is a separate npm package, `@opencode/cli` (stable, currently
> v2.0.4), with its own plugin SDK `@opencode/plugin`
> (`Plugin.define({ id, setup(ctx) })`). This document replaces the prior
> audit with the real V2 port's status and findings.

## What changed

`src/core.js` holds all runtime-agnostic logic: rule loading/merging, agent
filtering, all 12 condition evaluators, per-session state (todo-transition
tracking, `allTodosCompleteOnce`), and instruction-framing text.
`plugin.v1.js` and `plugin.v2.js` are thin adapters that normalize each
host's raw event into a common shape and carry out delivery via their own
SDK.

| Consumer wants | Import |
|---|---|
| V1 (`opencode-ai`/`@opencode-ai/plugin`, current default) | `opencode-auto-instruct` or `opencode-auto-instruct/v1` |
| V2 (`@opencode/cli`/`@opencode/plugin`) | `opencode-auto-instruct/v2` |

## Critical finding: V2 has no todo domain and no tool-name-carrying events

This is the most important fact about this port, found during design review
by checking the actual installed `@opencode/plugin` 2.0.4 type surface (not
assumed from a plausible-sounding hook name): **V2's event vocabulary has no
`todo.updated`, no `message.updated`, and no `tool.execute.after` event at
all.** The string `todo` does not occur anywhere in the 2.0.4 client type
surface.

**Consequence:** of the 12 condition types this plugin supports, **9 are
todo-derived and 2 are tool-name-derived — all 11 currently have no V2 event
source.** Only `messageFinished` maps (to `session.step.ended`'s `data.finish`
field, with error/failure finishes treated as non-matches — see below).

**Current scope of this port:** rules using any of the 11 unsupported
condition types are logged as unsupported, once per rule, at plugin load
time on V2 — they never match, but the plugin does not go silently deaf
about it:

```
[opencode-auto-instruct] [warn] rule=my-rule uses condition type "allTodosComplete",
which has no V2 event source as of @opencode/cli 2.0.4 (no todo domain, no
tool-name-carrying event) -- this rule will never match on this runtime
```

**A recovery path exists but is out of scope for this change**: V2's
`session.message.content.updated` event carries tool-part `name` and
completed `state.input`, so todo state (and tool names) are theoretically
reconstructable from a todo-management tool's completed input. This was
identified during design review as a future enhancement — it depends on an
untyped assumption about a specific tool's shape and was not implemented
here, to keep this port's scope bounded and its correctness verifiable.

If your rules rely only on `event: "session.created"` (or another event
that isn't todo/tool-derived) with `messageFinished` or no condition at all,
they are unaffected — the migration below is fully in scope.

## V1 → V2 API mapping

| V1 | V2 | Note |
|---|---|---|
| `event` hook | `ctx.event.subscribe({signal})` | Async iterator over the full event stream; started detached (not awaited) in `setup()`. |
| `client.session.get({path:{id}}) → res.data.agent` | `ctx.session.get({sessionID}) → res.agent` | **Unwrapped** on V2 — a real silent-failure risk if the V1 access pattern is copied naively. |
| `client.session.promptAsync({system, noReply, agent, parts:[{text, synthetic}]})` | `ctx.session.synthetic({sessionID, text, description, resume, metadata})` | **Not** `ctx.session.prompt` — that method has no system/hidden/synthetic framing in its schema. `synthetic` is V2's documented mechanism for an out-of-band injected message. |
| `body.noReply: true` | `resume: false` | Documented V2 equivalent: "schedule agent-loop execution unless resume is false." |
| `parts[0].synthetic` / `rule.hidden` | omit `description` | Source-confirmed (not doc-confirmed): the V2 TUI renders a synthetic row only when `description` is non-empty. |
| `body.system: <framing>` | prepended into `text` | `SessionSyntheticInput` has no `system` field. |
| `body.agent: <target>` (`switchToAgent`) | `ctx.session.switchAgent({sessionID, agent})` **before** delivery | See the persistence caveat below — this is a real behavioral difference, not a mechanical translation. |
| `client.app.log` | stderr only | V2's `Context.app` has no `log` method. |

## Known behavioral difference: `switchToAgent` is persistent on V2

V1's `switchToAgent` scopes an agent override to **one delivery only** — the
session reverts to its original agent afterward. V2 has no per-call agent
override on `session.prompt`/`session.synthetic`; its only mechanism,
`ctx.session.switchAgent`, is documented as changing "the agent used by
**subsequent** provider turns" — a persistent, session-level change.

The V2 adapter therefore calls `switchAgent` before delivering a
`switchToAgent` rule's instruction (skipping the call when the target
already equals the resolved agent, to avoid redundant persistent writes) and
**logs the persistence once per session per rule**, naming the previous
agent, so the log line doubles as the "how to switch back" note:

```
[opencode-auto-instruct] [warn] rule=my-rule persistently switched session=ses_...
from agent=build to agent=review -- this is a session-level change on V2,
not scoped to this one delivery
```

Restoring the original agent automatically after delivery was considered
and rejected: `synthetic` enqueues into the session inbox, and with
`resume: false` the message is consumed on some later turn — an immediate
restore would race that consumption (the instruction might run under the
*original* agent, silently defeating the rule, or the restore might land
mid-turn). There is no delivery-scoped completion signal to sequence
against. A visible, deterministic side effect (persistence) was judged
better than an invisible, nondeterministic one (a racing restore).

## Verified: `ctx.session.synthetic()` reaches model-visible context

An upstream GitHub issue, filed against a **beta** build, reported that
`synthetic()` messages did not reach the model's visible prompt context —
i.e. the agent might never see an injected instruction at all. This was the
single highest-priority item to verify before this port could be considered
done, since it would silently defeat the plugin's entire purpose.

**Confirmed empirically against the pinned `@opencode/cli` 2.0.4 release**
(not just from the documented schema): a rule injecting a unique sentinel
value via `synthetic()` was correctly seen by the model — when directly
asked in a follow-up turn, the model referenced the sentinel it had
received. (In initial testing, the model recognized the injected text as a
suspicious embedded instruction and correctly declined to blindly comply
with it — a sign of a safety-conscious model, not a plugin defect; it still
proves the message reached model-visible context, which is what this gate
verifies.) `synthetic()` visibility is **not** an open risk on this version.

## Config path is now overridable for safe testing

The rules config file path (`~/.config/opencode/auto-instruct.json`) can be
overridden via the `OPENCODE_AUTO_INSTRUCT_CONFIG` environment variable.
This was added because the original audit had to back up, overwrite, and
restore the user's real config file to test the plugin — a data-loss
footgun. Tests and the e2e script use the override; end users are
unaffected (the default path is unchanged).

## Verification

- `test/core.test.js` (Layer 1): unit tests for rule loading, agent
  filtering, all 12 condition types (including the edges the original
  implementation encoded — `allTodosComplete` on an empty list, consistent
  prev/current pairs across rules, `allTodosCompleteOnce`'s post-loop
  commit), and instruction framing.
- `test/plugin-conformance.test.js` (Layer 2): one shared suite exercised
  against a fake V1 host and a fake V2 `ctx` for runtime-neutral behavior,
  plus runtime-specific assertions (delivery shape, the unwrapped
  `session.get`, the `switchAgent` guard, cleanup).
- `npm run test:e2e` (Layer 3, not part of default `npm test`): the
  release-blocking gate described above, run against the real, pinned
  `@opencode/cli` binary with an isolated config path.

## Repro steps

Prior repro steps referenced `src/index.js` directly — that file is renamed
to `src/plugin.v1.js` in this change (a `git mv`, history preserved).
Anything pointing at the old path directly needs updating; `package.json`'s
`main`/`"."` still resolve to the same V1 behavior via the new path.
