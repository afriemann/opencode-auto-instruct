# Tasks

## 1. Documentation

- [x] 1.1 Add a "Known limitation: `once`/`edge` state does not survive a restart" section to `README.md`, explaining that modifier state lives only in an in-memory `Map` per plugin process and is lost on an opencode service/plugin restart mid-session. Verify by reading the rendered section for accuracy against `core.js`'s `createSessionState`/`evaluate` and `plugin.v1.js`/`plugin.v2.js`'s `sessionStates` Map.
- [x] 1.2 In the same section, add a worked example recommending a stateless `data*` condition over `edge`/`once` when the intent can be expressed from current event data alone — re-expressing the "remind when a todo list is freshly created" rule from `dataArrayNonEmpty` + `edge:"rise"` to `dataArrayAllMatch{path:"todos",field:"status",value:"pending"}`. Verify the JSON example is syntactically valid and consistent with the existing `dataArrayAllMatch` documentation entry in the Conditions table.
