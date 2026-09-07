# OpenGUI-Plus — Enhanced Edition Documentation

> This document covers **only the OpenGUI-Plus enhancement layer** (10 decoupled modules). For the upstream OpenGUI / DeepSeek Harness usage, see `README.md` and `docs/get-started.md` at the repo root.

---

## 1. What is this

**OpenGUI-Plus** is an enhanced fork of [`Core-Mate/OpenGUI`](https://github.com/Core-Mate/OpenGUI). Without touching any upstream core code, it layers 10 modules on top as **decoupled DSH plugins**:

| # | Module | What it solves |
|---|--------|---------------|
| 1 | Wireless debugging `wlan-connection` | USB / WiFi / auto connectivity, remembered devices, live status, Android 11+ pairing by six-digit code or QR (mDNS-resolved pairing port) |
| 2 | Snippet library `snippet-library` | Aliases + tags + autocomplete, JSON import/export |
| 3 | Action templates `action-template` | Record multi-step ops, parameterize with `{{vars}}`, one-click run |
| 4 | Scheduler `scheduler` | One-shot / daily / weekly / Cron, run snippets·templates·flows |
| 5 | Project groups `project-group` | One-click switch of an entire config set |
| 6 | AI demo recorder `demo-recorder` | Record ops → template, revise demos, versioned revisions |
| 7 | Workflow marketplace `workflow-marketplace` | `.opengui-workflow` format, market, ratings, one-click run |
| 8 | Human-feedback RL loop `feedback-rl` | Judgments → experience base → retrieval, gets smarter over time |
| 9 | Device pool `device-pool` | Queue, priority, load balancing, concurrency limits |
| 10 | Execution replay `replay` | Frame-by-frame HTML replay: action / AI decision / anomaly recovery |

### Design principles (why it layers with zero upstream changes)

- **Zero-dependency core**: every module uses only the Node.js standard library + TypeScript; the build output depends on no third-party runtime.
- **Optional DSH adapter**: `src/dsh/adapter.ts` dynamically probes `@deepseek-ai/dsh-tools` at runtime and degrades gracefully to a standalone console when absent.
- **Local persistence**: all configs, templates and records are JSON files under the data directory (`~/.opengui-plus`, or `--data-dir` / `OPENGUI_PLUS_DATA_DIR`), surviving sessions.
- **Scoped isolation**: data is scoped per *project*; switching a project group switches the whole data set.

---

## 2. Architecture

```
deepseek-harness-plugin/opengui-plus/
├── .codex-plugin/plugin.json     # plugin manifest (OpenGUI-Plus)
├── src/
│   ├── core/                     # zero-dependency base layer
│   │   ├── types.ts              # Result<T> / ok / fail / Page
│   │   ├── id.ts                 # createId / slugify / isAliasSafe
│   │   ├── events.ts            # EventBus + PLUS_EVENTS
│   │   ├── store.ts              # ScopedStore / PlusStore (atomic writes)
│   │   ├── module.ts            # ModuleContext / PlusModule / defineModule
│   │   ├── logger.ts            # Logger
│   │   ├── registry.ts          # ModuleRegistry (ordered start, call dispatch)
│   │   └── adb-runner.ts        # AdbRunner (real / test double)
│   ├── modules/                 # 10 business modules (one dir each)
│   ├── runtime/                 # cli.ts (CLI), server.ts (HTTP+SSE console)
│   ├── dsh/adapter.ts           # dynamic DSH probe, graceful degradation
│   ├── host.ts                  # PlusHost: registry + project switch + copy/export/import
│   └── index.ts                 # plugin entry (apply / createPlus / defaultModules)
├── web/index.html               # single-page console (10 module views & actions)
├── lib/                         # tsc build output (npm run build)
└── docs/                        # this document
```

Modules never import each other's business code; they communicate only through `ModuleContext.call(target, input)` and the event bus.

---

## 3. Quick start

### Requirements

- Node.js **≥ 22.5.0**
- `adb` installed (optional — modules degrade to test/demo mode without it)

### Install & build

```bash
cd deepseek-harness-plugin/opengui-plus
npm install            # or pnpm install
npm run build          # tsc → lib/
```

### Launch the console

```bash
node lib/cli.js serve --port 8787
# open deepseek-harness-plugin/opengui-plus/web/index.html in a browser
```

### CLI cheat sheet

```bash
opengui-plus serve [--port 8787] [--host 127.0.0.1] [--data-dir <dir>]
opengui-plus status
opengui-plus modules
opengui-plus call <module.method> [--json '{...}'] [--key value ...]
opengui-plus connect --mode usb|wifi|auto [--host <ip>] [--port 5555]
opengui-plus run <templateId> [--package com.example.app ...]
opengui-plus help
```

---

## 4. Modules at a glance

| Module | Key methods |
|--------|-------------|
| `wlan-connection` | `status` · `setMode` · `discover` · `listDevices` · `saveDevice` · `removeDevice` · `connect` · `disconnect` · `pair` · `pairWithCode` · `pairWithQr` · `pairAndConnect` · `mdnsServices` · `parsePairingQr` · `decodePairingQr` · `pairingGuide` · `enableTcpip` · `autoConnect` |
| `snippet-library` | `list` · `save` · `remove` · `resolve` · `complete` · `listTags` · `exportJson` · `importJson` |
| `action-template` | `startRecording` · `recordStep` · `stopRecording` · `list` · `get` · `remove` · `update` · `execute` · `save-from-demo` |
| `scheduler` | `create` · `list` · `update` · `remove` · `enable` · `disable` · `runNow` · `tick` · `nextRuns` · `runs` |
| `project-group` | `create` · `list` · `current` · `switch` · `update` · `remove` · `duplicate` · `export` · `import` |
| `demo-recorder` | `startDemo` · `captureStep` · `stopDemo` · `listDemos` · `getDemo` · `removeDemo` · `revise` · `toTemplate` |
| `workflow-marketplace` | `categories` · `browse` · `detail` · `install` · `uninstall` · `listInstalled` · `publish` · `rate` · `exportWorkflow` · `importWorkflow` · `run` |
| `feedback-rl` | `record` · `listRecords` · `listExperiences` · `queryRelevant` · `markApplied` · `summary` · `successRate` |
| `device-pool` | `register` · `unregister` · `list` · `listGroups` · `tag` · `setConcurrency` · `refresh` · `enqueue` · `dequeue` · `assign` · `complete` · `status` · `autoAssign` |
| `replay` | `startRecording` · `markFrame` · `stopRecording` · `listReplays` · `getReplay` · `removeReplay` · `annotate` · `exportReplay` · `stats` |

### Examples

```bash
# Wireless: save a WiFi device and auto-connect
opengui-plus call wlan-connection.saveDevice --transport wifi --host 192.168.1.23 --port 5555 --name Mi9
opengui-plus connect --mode auto

# Snippet: save + autocomplete
opengui-plus call snippet-library.save --alias sc --command "screenshot and pull" --tags '["debug"]'
opengui-plus call snippet-library.complete --prefix sc

# Action template: record then run
opengui-plus call action-template.startRecording --name "Open settings"
opengui-plus call action-template.recordStep --action "tap settings icon"
opengui-plus call action-template.stopRecording
opengui-plus run <templateId> --package com.android.settings

# Scheduler: daily cron
opengui-plus call scheduler.create --name "Morning check" --cron "30 9 * * *" \
  --action '{"module":"snippet-library","method":"resolve","input":{"alias":"health"}}'

# Replay: record a run and export a single-file HTML
opengui-plus call replay.startRecording --name "Login flow" --taskLabel task-42
opengui-plus call replay.markFrame --sessionId <sid> --action "tap login" --decision "only entry on home" --ok true
opengui-plus call replay.stopRecording --sessionId <sid>
opengui-plus call replay.exportReplay --id <sid> --format html
```

See `docs/OPENGUI-PLUS.zh-CN.md` for the full per-module reference (in Chinese).

---

## 5. Relationship to upstream

- Remote `upstream` points to `https://github.com/Core-Mate/OpenGUI.git`; all enhancements live under `deepseek-harness-plugin/opengui-plus/`, leaving the rest of the tree untouched.
- Sync: `git fetch upstream && git merge upstream/main`.

## 6. Data storage

Default data directory:

- Linux / macOS: `~/.opengui-plus/`
- Windows: `C:\Users\<you>\.opengui-plus\`

Override with `--data-dir <dir>` or the `OPENGUI_PLUS_DATA_DIR` env var. Files are stored per `projects/<projectId>/` scope as JSON.

## 7. Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # emit lib/
npm run smoke       # boot the real console, exercise all ten modules
npm run check       # all of the above
```

Add a module by creating `src/modules/<your-module>/index.ts` with `defineModule({...})` and appending it to `defaultModules` in `src/index.ts` — no other module needs changes.

## 8. Console front end

`web/index.html` is a zero-dependency single-page console with two layers:

1. **Curated cards** — hand-written high-frequency actions for the ten modules.
2. **Method browser** — built from `/api/modules` `methodSpecs`, so **all 100+ methods are reachable** and new server-side methods need no front-end change.

Two conventions worth knowing:

- Every registry call is wrapped as `{ ok: true, value }` and a module may itself return a `Result`, so the browser unwraps **twice**. The inner check is deliberately strict (a real `Result` carries `value` on success and a string `error` on failure) so an execution report like `{ ok: true, results: [...] }` is not mistaken for an envelope.
- On startup the page cross-checks every hard-coded method name against the registry and warns on the overview panel if any is missing, rather than failing silently with HTTP 400.

## 9. Acceptance defect fixes (F-01 … F-05)

The first DeepSeek Harness acceptance run (67 tests) surfaced five defects. All are fixed, with regression tests in `src/core/regressions.test.ts`:

| ID | Symptom | Root cause | Fix |
| --- | --- | --- | --- |
| F-01 | Scheduler accepted targets that do not exist | `context.call` returns an outer `{ ok: true, value }`; only the outer flag was checked | New `callModule()` in `src/core/call.ts` unwraps both layers; `create`/`update` run `verifyTarget()` (skip with `skipTargetCheck: true`) |
| F-02 | Intermittent `EPERM` when switching project groups on Windows | Two writers renaming the same `current-project.json` | Atomic write with rename retry/backoff, unique temp names and a direct-write fallback; switching goes through a single awaited `__host__.switchProject` |
| F-03 | Demo → template reported success but nothing was saved | Passed `{ template }` where `save-from-demo` wants `{ name, steps }`, and only the outer `ok` was read | Pass the fields, unwrap with `callModule`, return `templateId` |
| F-04 | Zero tools registered under dsh-tools | Missing required `output.render`; `parameters` used the JSON Schema dialect | `src/dsh/adapter.ts` now probes the dialect (modern / legacy) and builds the matching spec; `dshToolName` splits camelCase |
| F-05 | Template execution sent `{{var}}` straight to adb | Branches read `step.params` instead of the substituted copy | All branches read the result of `resolveParams()` |

Two further bugs were found and fixed while verifying:

- **`project-group.current` always `null` after a switch** — `switch` triggers the host's `reseatAll`, so the module reloaded the stale file and then wrote it back over the very key the host had just written. `load()` now falls back to the host's `ctx.projectId`, and `switch` re-asserts the pointer afterwards.
- **`store.update` self-deadlock** — calling `set()` inside `update()` enqueued twice on the same key and awaited the outer task forever. The write path is now inlined.

Verified: `tsc --noEmit` clean, 69 unit tests pass, build succeeds, `npm run smoke` 29/29.
