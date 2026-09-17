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

## Critical finding: V2 has no server-side todo-management tool (toolName/toolNameIn are supported)

This is the most important fact about this port, corrected by a later
architectural review that read the real V2 source tree directly (tag
v2.0.6, not just the installed `@opencode/plugin` 2.0.4 type surface).

**`toolName`/`toolNameIn` are supported — the original "no tool-name-carrying
event" conclusion was wrong.** V2 exposes a separate hook registration,
`ctx.tool.hook("execute.after", callback)` (distinct from
`ctx.event.subscribe()` — confirmed in `packages/core/src/tool.ts` and
`packages/plugin/src/promise/adapter.ts`), that fires for every tool call,
built-in or custom, with a stable payload: `{tool, sessionID, agent,
messageID, id, input} & ({status:"completed", result}|{status:"error",
error})`. The plugin now registers this hook alongside
`ctx.event.subscribe()` and evaluates `toolName`/`toolNameIn` against it —
these condition types match correctly on V2.

**The 9 todo-derived condition types remain unsupported — but for a
different, now-confirmed reason.** Exhaustively enumerating V2's built-in
tool registrations (every file under `packages/core/src/tool/plugin/`, plus
a repo-wide grep for `todo` outside UI/test/i18n code) found **no
server-side todo-management tool exists in V2 at all** as of tag v2.0.6.
There is no `todowrite`/`todoread` tool, and no `todo.*` event either — so
there is nothing for `ctx.tool.hook` (or any other mechanism) to observe
todo state from. The original audit's reasoning ("no dedicated
`todo.updated` event") was correct in outcome but incomplete in cause; this
is the corrected, more fundamental reason.

**Consequence:** of the 12 condition types this plugin supports, the 9
todo-derived types (`allTodosComplete`, `anyTodosComplete`,
`noTodosInProgress`, `hasTodos`, `todoListCreated`, `todoListCleared`,
`firstTodoStarted`, `allTodosCompleteOnce`, `todoCountAtLeast`) have no V2
source and never match on that runtime. `toolName`, `toolNameIn`, and
`messageFinished` are all supported.

**Current scope:** rules using any of the 9 todo-derived condition types
are logged as unsupported, once per rule, at plugin load time on V2 — they
never match, but the plugin does not go silently deaf about it:

```
[opencode-auto-instruct] [warn] rule=my-rule uses condition type "allTodosComplete",
which has no V2 event or tool-call source as of @opencode/cli 2.0.6 (no
server-side todo-management tool exists) -- this rule will never match on
this runtime
```

**Recovering the 9 todo-derived types is out of this plugin's control**:
it would require V2 itself to gain a server-side todo-management tool (or
an equivalent event) for the plugin to hook into in the first place. There
is nothing to synthesize this from today.

If your rules rely only on `event: "session.created"`, `messageFinished`,
`toolName`/`toolNameIn`, or no condition at all, they are unaffected — the
migration below is fully in scope.

## V1 → V2 API mapping

| V1 | V2 | Note |
|---|---|---|
| `event` hook | `ctx.event.subscribe({signal})` | Async iterator over the full event stream; started detached (not awaited) in `setup()`. |
| `tool.execute.after` event | `ctx.tool.hook("execute.after", callback)` | A **separate** hook registration, not part of `ctx.event.subscribe()`. Fires for every tool call with `{tool, sessionID, agent, messageID, id, input} & ({status:"completed", result}|{status:"error", error})`. Confirmed against V2 source (`packages/core/src/tool.ts`, `packages/plugin/src/promise/adapter.ts`, tag v2.0.6). This is what makes `toolName`/`toolNameIn` supported on V2. |
| `client.session.get({path:{id}}) → res.data.agent` | `ctx.session.get({sessionID}) → res.agent` | **Unwrapped** on V2 — a real silent-failure risk if the V1 access pattern is copied naively. |
| `client.session.promptAsync({system, noReply, agent, parts:[{text, synthetic}]})` | `ctx.session.synthetic({sessionID, text, description, resume, metadata})` | **Not** `ctx.session.prompt` — that method has no system/hidden/synthetic framing in its schema. `synthetic` is V2's documented mechanism for an out-of-band injected message. |
| `body.noReply: true` | `resume: false` | Documented V2 equivalent: "schedule agent-loop execution unless resume is false." |
| `parts[0].synthetic` / `rule.hidden` | omit `description` | Source-confirmed (not doc-confirmed): the V2 TUI renders a synthetic row only when `description` is non-empty. |
| `body.system: <framing>` | prepended into `text` | `SessionSyntheticInput` has no `system` field. |
| `body.agent: <target>` (`switchToAgent`) | `ctx.session.switchAgent({sessionID, agent})` **before** delivery | See the durable-handoff note below — this is a real behavioral difference, not a mechanical translation. |
| `client.app.log` | stderr only | V2's `Context.app` has no `log` method. |

## `switchToAgent` is a durable, session-level handoff on V2

V1's `switchToAgent` scopes an agent override to **one delivery only** — the
session reverts to its original agent afterward. V2's only mechanism,
`ctx.session.switchAgent`, is documented as changing "the agent used by
**subsequent** provider turns" — a persistent, session-level change.

This is not a capability V2 lacks relative to V1 — it is a **better fit for
the durable-handoff use case this feature exists for**. The plugin's own
`review-on-completion` example (see `README.md`) models exactly this: when
implementation todos are all complete, switch the session to
`code-reviewer` so it can review with the full conversation history intact,
before the `engineer` agent commits. That is a durable handoff by design —
the point is for the review to happen under the new agent for the rest of
the session, not to revert after one message. V2's session-level
persistence expresses this intent more directly than V1's revert-after-one-
delivery scoping ever did; V1's scoping was, if anything, the more awkward
fit for this pattern.

The V2 adapter calls `switchAgent` before delivering a `switchToAgent`
rule's instruction (skipping the call when the target already equals the
resolved agent, to avoid redundant persistent writes) and **logs the
persistence once per session per rule**, naming the previous agent, so the
log line doubles as a clear record of the handoff:

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
against. For a genuinely scoped, single-delivery agent override (rather
than a durable handoff), V1's revert-after-one-message semantics remain the
right tool — that pattern has no safe equivalent on V2 and is out of scope
for this plugin to fake.

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
  `session.get`, the `switchAgent` guard, cleanup, and — since this
  correction — a fake `ctx.tool.hook("execute.after", ...)` registration
  exercising `toolName`/`toolNameIn` matching on V2).
- `npm run test:e2e` (Layer 3, not part of default `npm test`): the
  release-blocking gate described above, run against the real, pinned
  `@opencode/cli` binary with an isolated config path.

## Repro steps

Prior repro steps referenced `src/index.js` directly — that file is renamed
to `src/plugin.v1.js` in this change (a `git mv`, history preserved).
Anything pointing at the old path directly needs updating; `package.json`'s
`main`/`"."` still resolve to the same V1 behavior via the new path.
