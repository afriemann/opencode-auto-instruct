## Why

A later architectural review of the `v2-plugin-migration` change found that its
conclusion — all 11 todo/tool-derived condition types are "permanently
unsupportable on V2" because V2 has no `todo.*`/`tool.*` *event* domain — is
wrong for the two tool-name conditions. `ctx.tool.hook("execute.after", cb)`
is a separate, real, fully-typed hook registration (confirmed by reading
`/tmp/opencode/v2-src` @ tag v2.0.6, `packages/core/src/tool.ts` and
`packages/plugin/src/promise/adapter.ts`), distinct from `ctx.event.subscribe()`,
that fires host-wide for every tool call and carries the tool name directly.
`toolName`/`toolNameIn` rules can be made to work today; shipping them as
permanently unsupported is an avoidable functionality gap.

The same review also flagged, but did not confirm, that the 9 todo-derived
conditions might be recoverable the same way. Exhaustive inspection of the
V2 source tree (every file under `packages/core/src/tool/plugin/`, plus a
repo-wide grep for `todo` outside UI/test/i18n code) found **no
todo-management tool exists in V2 at all** as of this release — there is
nothing for `ctx.tool.hook` to observe for todo state. The original
"unsupportable" conclusion for those 9 conditions stands, but the documented
reasoning was incomplete (it named "no dedicated event" rather than "no tool
exists to hook into at all") and needs correcting.

## What Changes

- Add a second V2 event-intake path in `src/plugin.v2.js` using
  `ctx.tool.hook("execute.after", ...)`, normalizing its payload into the
  same `NormalizedEvent` shape `src/core.js`'s `checkCondition`/`evaluate`
  already consume.
- Remove `toolName`/`toolNameIn` from `V2_UNSUPPORTED_CONDITION_TYPES` and
  remove `tool.execute.after` from `V2_UNSUPPORTED_EVENT_TYPES` in
  `src/core.js`.
- Delete the now-obsolete tests asserting `toolName`/`toolNameIn` warn-and-skip
  behavior on V2; add new tests asserting they now match correctly via the
  tool hook.
- Update `docs/v2-compat-audit.md` and the delta spec to: (a) document the
  tool-hook fix for `toolName`/`toolNameIn`, and (b) correct the root-cause
  reasoning for the remaining 9 todo-derived conditions ("no todo-management
  tool exists in V2 at all" rather than "no dedicated todo.* event").
- Reframe `switchToAgent`'s V1/V2 persistence difference in `README.md` from
  a "V1 regression" framing to an intentional durable-handoff feature — no
  code change, documentation only.
- No implementation change for the 9 todo-derived conditions; they remain in
  the unsupported-warning system.

## Capabilities

### Modified Capabilities

- `rule-based-instruction-injection`: the Condition Evaluation requirement's
  V2-limitation text changes — `toolName`/`toolNameIn` move from
  "unsupported, warn-and-skip" to "supported via `ctx.tool.hook`"; the
  reasoning for the remaining 9 todo-derived conditions is corrected (no
  todo-management tool exists in V2, not merely no dedicated event).

## Impact

- `src/core.js`: `V2_UNSUPPORTED_CONDITION_TYPES`, `V2_UNSUPPORTED_EVENT_TYPES`.
- `src/plugin.v2.js`: new tool-hook event-intake path, `normalize()` extended
  for tool-hook payloads, load-time warning loop no longer flags
  `toolName`/`toolNameIn`.
- `test/plugin-conformance.test.js`: fake V2 `ctx` needs a `tool.hook` fake;
  obsolete warn-and-skip tests for `toolName`/`toolNameIn` removed; new
  match-via-hook tests added.
- `docs/v2-compat-audit.md`, `openspec/specs/rule-based-instruction-injection/spec.md`,
  `README.md`: documentation updates only.
- No breaking change; `toolName`/`toolNameIn` rules that previously silently
  never matched on V2 now match — this is a bugfix, not a behavior
  regression, for any user who configured such a rule.
