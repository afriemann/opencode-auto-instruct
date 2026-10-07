# opencode-auto-instruct

opencode plugin that injects configurable instructions as real conversation messages into agent sessions when events occur (rules in `~/.config/opencode/auto-instruct.json`).

- Runtimes: V1 (`@opencode-ai/plugin`) via `src/plugin.v1.js` (package `main`), V2 (`@opencode/plugin`) via `src/plugin.v2.js`. Both are thin adapters over shared logic in `src/core.js`; keep behaviour identical across them.
- Provides: `event` hook on V1, `tool.execute.after` hook on V2; no tools.
- Layout: `src/` plugin code, `test/` tests, `docs/v2-compat-audit.md` V1→V2 hook mapping, `openspec/` specs and changes (behaviour contract).
- Test: `npm test` (E2E: `npm run test:e2e`). No lint or build script. CI: `.github/workflows/ci.yml`.
- Usage, install and configuration: see `README.md`.
