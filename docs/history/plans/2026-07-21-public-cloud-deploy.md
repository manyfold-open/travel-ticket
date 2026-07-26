# Public Cloud Deploy Implementation Plan

> Archived execution plan. The Worker implementation is present; use
> `docs/cloudflare.md` for current deployment instructions and status.

**Goal:** Migrate the trip-ticket pipeline from a local-only Node CLI/Studio app to a
publicly reachable Cloudflare Workers service — Worker (pages + API) + Workflows
(pipeline) + KV (rendered sites + itinerary JSON + progress) — with the exact
user flow, security posture, and full feature scope (incl. AI custom themes) fixed
by the spec. No feature reduction, no re-litigating settled decisions.

**2026-07-21 update:** storage is **KV-only**, not R2 — enabling R2 requires adding
a credit card on the Cloudflare account and Zack doesn't want to do that right now;
KV already works without one (verified via `wrangler kv namespace list` against the
live account). Two namespaces: `TRIPS_KV` (progress status) and `TRIPS_SITES`
(rendered site files, key `trips/<id>/<path>`, KV's 25MiB per-value limit is ample).
Every "R2" reference below (Task 4/5/9) should be read as "KV namespace `TRIPS_SITES`".

**Spec:** `docs/history/specs/2026-07-21-public-cloud-deploy-design.md` (single source of truth for architecture/decisions)
**Prior handover:** `docs/history/handover-cloud-2026-07-21.md` (known traps, Zack's must-do list, acceptance criteria)

**Tech stack:** Cloudflare Workers (native runtime, no `nodejs_compat` — core logic
must stay free of Node builtins), Cloudflare Workflows, R2, KV, Turnstile.
`wrangler` v4.111, `@cloudflare/workers-types`, `typescript` (all already in
devDependencies). Tests: `node:test` for portable logic (as today), `wrangler
dev`/miniflare for Worker-specific routes and Workflow steps.

## Global constraints

- **TDD throughout**: write/extend the failing test first, then make it pass, per step.
- **Frontend changes read `docs/design-system.md` first** — tokens only, no raw hex, Data/Body/Display
  font-role rules, motion behind `prefers-reduced-motion`.
- `npm test` (`TRIP_NO_LLM=1 node --test 'tests/*.test.mjs'`, currently 61/61) must
  stay green after every task — this suite covers the shared/local logic and is the
  regression net for the whole migration.
- **No forking**: `render.mjs`, `themes.mjs`, `contrast.mjs`, `customTheme.mjs`,
  `itinerary-schema.mjs`, `timezone.mjs`, `composio.mjs` stay single-sourced and get
  used by both the local CLI and the Worker. Where a shared file currently touches
  `fs` (see Task 2), split out the I/O, don't duplicate the logic.
- **Zack-only items — stop and ask, do not fake or bypass**: `wrangler login` /
  Cloudflare API token, `ANTHROPIC_API_KEY`, `COMPOSIO_API_KEY` + 3 auth config IDs,
  Turnstile site key + secret, Cloudflare rate-limiting rule, Workers Paid upgrade
  decision. Tasks that need these are marked 🛑 below — implementation and tests for
  the surrounding code can proceed with mocked/local values, but nothing gets
  actually deployed, provisioned, or live-verified until Zack provides the real
  thing.
- **Corrected premise (verified against current code, not a new decision)**: the
  spec's §4 framing ("motifs 生成但不渲染，這次要做 escaped render path") describes
  the pre-2026-07-15 state. Commit `70f0c9b` already wired `stampText`/`eyebrow`
  through the existing `esc()` helper into the SVG `<text>` node, and
  `tests/render-custom.test.mjs` already has a passing `<script>`-breakout
  regression test. Task 1 below closes the remaining gap (spec calls out three
  payload shapes; only one is tested today) rather than re-implementing escaping
  that already exists.

---

### Task 1: Harden motifs injection tests (close spec §4, no prod code change expected)

**Files:**
- Modify: `tests/render-custom.test.mjs`
- Modify (if a gap is found): `pipeline/render.mjs` (only if a real bypass is found — expected: none)
- Modify: `docs/history/progress-2026-07.md` (mark the motifs deviation resolved, with commit refs)

**Interfaces:** no new exports; this is regression-test hardening.

- [ ] **Step 1**: Add two test cases to `render-custom.test.mjs` alongside the existing
  `<script>` breakout test: (a) an attribute-escape payload for both `stampText`
  and `eyebrow` (`"><img src=x onerror=alert(1)>` style), asserting the raw
  payload never appears unescaped and the generated HTML still parses as
  well-formed around that node; (b) an SVG event-handler payload
  (`<svg onload=alert(1)>` embedded in the motif string), asserting no
  `onload=`/`onerror=` attribute appears in the output attached to attacker
  input.
- [ ] **Step 2**: Run `npm test`. If both new cases pass with zero prod changes
  (expected, since `esc()` + JSON-string-literal wrapping already neutralizes
  all three shapes), proceed to Step 3. If a real gap surfaces, fix it in
  `render.mjs` at the motif interpolation sites (~line 1295, ~1399) and re-run.
- [ ] **Step 3**: Update `docs/history/progress-2026-07.md` — append a line marking the
  §4.4 motifs deviation as resolved as of commit `70f0c9b`, verified more fully
  in this task's commit.
- [ ] **Step 4**: Commit: `test: harden motifs injection coverage (attribute + SVG event-handler payloads)`.

---

### Task 2: Split file-writing out of `render.mjs` / `pwa.mjs` (pure generation vs fs I/O)

**Why:** `renderItinerary()` and `writePwaAssets()` currently call `fs.mkdirSync` /
`fs.writeFileSync` / `fs.existsSync` / `fs.readdirSync` directly (render.mjs:5,
1277, 1618-1630; pwa.mjs:17, 251-255). Workers have no `fs`. To keep this logic
single-sourced (spec §5), the file-producing logic must return a `{ path: content
}` map (or async iterable of `{path, body}`) that a *thin* platform adapter
writes — `fs` locally, R2 in the Worker.

**Files:**
- Modify: `pipeline/render.mjs`, `pipeline/pwa.mjs`
- Modify: `pipeline/trip.mjs`, `pipeline/orchestrator.mjs` (update call sites to use the new fs-writing wrapper)
- Test: extend `tests/render-custom.test.mjs`, `tests/render-only-custom.test.mjs` to assert against the pure file-map function directly, not just side effects on disk

**Interfaces:**
- Produces: `buildItineraryFiles(itinerary, opts): Map<string, string|Buffer>` (pure,
  no fs) — same computation `renderItinerary` does today, minus the write.
  `writePwaAssetsFiles(...): Map<string, string|Buffer>` — pwa.mjs equivalent.
- `renderItinerary(itinerary, opts)` keeps its exact current signature and
  behavior for every existing caller (writes to `outDir` via `fs`) — it becomes a
  thin wrapper: `const files = buildItineraryFiles(...); for (const [p, body] of files) fs.writeFileSync(...)`.
  **Zero behavior change for local callers; existing tests must pass unmodified
  wherever they test through `renderItinerary`.**
- Consumes: nothing new.

- [ ] **Step 1**: Write a test asserting `buildItineraryFiles()` returns a Map
  containing `index.html`, each `day-*.html`, and (when applicable) PWA files,
  with content matching what `renderItinerary` currently writes to disk for the
  same input (compare bytes after extraction, on an existing fixture trip).
- [ ] **Step 2**: Refactor `render.mjs`: extract the body of `renderItinerary` (from
  right after `outDir` is known, through the loop that builds `homeHtml`/`dayHtml`
  per day) into `buildItineraryFiles`, collecting outputs into a `Map` instead of
  writing them. Keep the `fs.existsSync(posterSrc)` poster-detection read as an
  `opts.hasPoster` input the caller must pass in (fs read moves to the wrapper),
  so the pure function touches zero fs APIs.
- [ ] **Step 3**: Rewrite `renderItinerary` as the thin fs wrapper: check poster
  existence, call `buildItineraryFiles`, mkdir + write each entry, clean up stale
  `.html` files as today (this cleanup logic itself stays fs-only, local-only).
- [ ] **Step 4**: Same split for `pwa.mjs`: `writePwaAssetsFiles(...)` pure, then
  `writePwaAssets` becomes the fs-writing wrapper calling it. Update
  `buildItineraryFiles` to call `writePwaAssetsFiles` and merge its entries into
  the returned Map (instead of `renderItinerary` calling `writePwaAssets`
  directly for side effects).
- [ ] **Step 5**: Run `npm test` — all 61+ existing tests must stay green with no
  changes to their assertions (only the new tests from Step 1 are additions).
- [ ] **Step 6**: Commit: `refactor: separate pure file generation from fs writes in render.mjs/pwa.mjs`.

---

### Task 3: Split `agents.mjs` into portable core vs local-only backend

**Why:** spec §5 requires `agents.mjs` split into "LLM 呼叫核心（共用）vs backend
選擇（平台各自）". Today `spawnWithStdin`, `runCliJson`, `hasCommand`,
`posterViaCodex`'s `execFileSync`/fs calls, and each agent's `if (ctx.backend ===
'cli')` branch are Node-only (`node:child_process`, `node:fs`) and must never be
imported by the Worker bundle — even unused Node-builtin imports at module scope
can break Workers bundling/execution.

**Files:**
- Create: `pipeline/agents-local.mjs` (cli backend, codex/gemini poster fs paths)
- Modify: `pipeline/agents.mjs` (becomes the portable core: schemas, `MODEL`,
  `runStructuredJson`'s `sdk` branch only, the six agent functions with their
  `cli` branches removed, `posterPrompt`)
- Modify: `pipeline/orchestrator.mjs`, `pipeline/trip.mjs` (import cli/poster
  pieces from `agents-local.mjs`, everything else from `agents.mjs` as before)
- Test: update `tests/agents-connectors.test.mjs`, `tests/trip.test.mjs` import
  paths as needed; add a new `tests/agents-core-portable.test.mjs` asserting
  `pipeline/agents.mjs`'s static imports contain no `node:` builtins (grep-based
  guard, cheap and catches regressions early)

**Interfaces:**
- `pipeline/agents.mjs` produces (unchanged names, `cli`-branch code removed):
  `createContext({backend?: 'sdk'})` (sdk-only now — no `hasCommand`/cli
  fallback), `runTripBriefAgent`, `runLocalDiscoveryAgent`, `runTravelContextAgent`,
  `runCalendarAgent`, `runNotionAgent`, `runComposerAgent`, all schemas, `MODEL`.
- `pipeline/agents-local.mjs` produces: `createLocalContext(preferred)` (today's
  full cli+sdk backend-selection logic, calls into `agents.mjs` for the sdk path
  and keeps its own `runCliJson` for cli), `runPosterAgent` (codex/gemini/manual,
  fs-writing), re-exports whatever local-only orchestrator/trip.mjs need.
- Consumes: `agents-local.mjs` imports the sdk-branch functions from `agents.mjs`.

- [ ] **Step 1**: Add the portability guard test first (it will fail against
  today's `agents.mjs`, which is the point — TDD for the constraint itself).
- [ ] **Step 2**: Create `agents-local.mjs`, move `spawnWithStdin`, `runCliJson`,
  `hasCommand`, `extractJson`, `posterViaCodex`, the codex branch of
  `runPosterAgent`, and `PIPELINE_CLAUDE_MODEL` handling there verbatim.
- [ ] **Step 3**: In `agents.mjs`, delete every `if (ctx.backend === 'cli') return
  runCliJson(...)` branch from the six agent functions and from
  `runStructuredJson`; delete `createContext`'s cli fallback (now throws if no
  API creds, since the Worker always has creds via secrets and the local CLI now
  explicitly asks for `agents-local.mjs`'s context instead).
- [ ] **Step 4**: Update `orchestrator.mjs`/`trip.mjs` to call
  `createLocalContext` (from `agents-local.mjs`) instead of `createContext`
  everywhere they need cli fallback; everything else keeps importing from
  `agents.mjs` unchanged.
- [ ] **Step 5**: Run `npm test`. Expect the local `cli`-backend-selection tests
  (if any assert cli fallback via `agents.mjs`) to need import-path updates only
  — no behavior change for local CLI users.
- [ ] **Step 6**: Commit: `refactor: split agents.mjs into portable sdk-only core + agents-local.mjs cli/poster backend`.

---

### Task 4: 🛑 Cloudflare resource bindings in `wrangler.itinerary.toml`

**Blocked on:** `wrangler login` or an API token with Workers + R2 + KV +
Workflows permissions (docs/history/handover-cloud-2026-07-21.md confirmed **not logged in** as of
2026-07-21). Config/code below can be authored and reviewed now; the actual `wrangler
r2 bucket create` / `wrangler kv namespace create` commands and the first `wrangler
dev`/`deploy` run must wait for Zack.

**Files:**
- Modify: `wrangler.itinerary.toml` — add `[[r2_buckets]]` (binding `TRIPS_BUCKET`),
  `[[kv_namespaces]]` (binding `TRIPS_KV`), `[[workflows]]` (binding
  `TRIP_WORKFLOW`, `class_name = "TripPipelineWorkflow"`), update `main` to point
  at the new `worker/index.ts` (Task 6).
- Delete: `src/itinerary-worker.ts` (superseded by `worker/index.ts`)

- [ ] **Step 1**: Write the binding stanzas in `wrangler.itinerary.toml` with
  placeholder `id`/`bucket_name`/`database_id` values clearly marked
  `# TODO: fill in after Zack runs wrangler login + provisioning`.
- [ ] **Step 2**: **Stop here and ask Zack** for: (a) `wrangler login` completed or
  an API token, (b) confirmation to proceed with `wrangler r2 bucket create
  trip-tickets-store` and `wrangler kv namespace create TRIPS_KV` (these create
  real billable-adjacent cloud resources — confirm before running, per this
  project's "check before hard-to-reverse/shared-state actions" norm).
- [ ] **Step 3** (after Zack unblocks): run the create commands, paste the real
  IDs into `wrangler.itinerary.toml`, commit: `chore: provision R2 bucket + KV namespace, wire bindings`.

---

### Task 5: `worker/storage.mjs` — R2/KV adapter (miniflare-testable, no live account needed)

**Files:**
- Create: `worker/storage.mjs`
- Test: `tests/worker/storage.test.mjs` (uses `wrangler`'s built-in miniflare
  bindings via `unstable_dev` or `vitest`-less `Miniflare` instance with an
  in-memory R2/KV — no network/account required for this task)

**Interfaces:**
- Produces: `saveTripFiles(env, tripId, fileMap: Map<string,string|Buffer>):
  Promise<void>` (R2 put per entry, key prefix `trips/<tripId>/`),
  `saveTripJson(env, tripId, itinerary): Promise<void>` (R2 put,
  `trips/<tripId>/itinerary.json`), `getTripFile(env, tripId, path):
  Promise<Response|null>` (R2 get → Response, for serving `/trips/<slug>/*`),
  `writeStatus(env, tripId, status): Promise<void>` (KV put,
  `trip:<tripId>:status`, JSON, mirrors `server.mjs`'s `/api/status` shape —
  `{phase, agents, log, manifest, error}`), `readStatus(env, tripId):
  Promise<object|null>` (KV get).
- Consumes: `env.TRIPS_BUCKET` (R2Bucket), `env.TRIPS_KV` (KVNamespace) — both
  from Task 4's bindings, injectable/mockable in tests via a plain object
  implementing the R2/KV interface subset used.

- [ ] **Step 1**: Write tests against a mock `env` (plain JS objects backed by a
  `Map`, mimicking R2Bucket's `put`/`get` and KVNamespace's `put`/`get` — this
  is enough to TDD the adapter's contract without needing real bindings yet;
  Task 4's real bindings get exercised later in `wrangler dev`).
- [ ] **Step 2**: Implement `storage.mjs` against the R2Bucket/KVNamespace API
  shape (`put(key, value, opts)`, `get(key)` returning an object with `.body`/`.text()`).
- [ ] **Step 3**: `npm test` — new suite green, existing 61 untouched.
- [ ] **Step 4**: Commit: `feat: R2/KV storage adapter for Worker`.

---

### Task 6: `worker/pipeline-workflow.ts` — Cloudflare Workflow definition

**Files:**
- Create: `worker/pipeline-workflow.ts` (extends `WorkflowEntrypoint` from
  `cloudflare:workers`), `worker/env.d.ts` (Env interface: bindings + secrets)
- Test: `tests/worker/pipeline-workflow.test.mjs` — drive each step function
  directly (steps as plain exported async functions the class delegates to,
  so they're unit-testable without spinning up a real Workflow instance),
  mocking `agents.mjs` LLM calls and `composio.mjs` connector calls exactly like
  `tests/trip.test.mjs` does for `planTrip`.

**Interfaces:**
- Produces: `TripPipelineWorkflow` class with `run(event, step)` calling, in
  order: `step.do('brief', ...)`, `step.do('timezone', ...)`,
  `step.do('discovery', ...)` ∥ `step.do('gmail', ...)` ∥ `step.do('calendar',
  ...)` ∥ `step.do('notion', ...)` (Workflows run `step.do` calls concurrently
  when not awaited sequentially — use `Promise.all` over 4 `step.do` calls),
  `step.do('composer', ...)`, `step.do('custom_theme', ...)` (only if
  `event.payload.wantsCustomTheme`), `step.do('render', ...)` (calls
  `buildItineraryFiles` from Task 2 + `storage.saveTripFiles`), `step.do('manifest', ...)`
  (writes final `status: 'done'` via `storage.writeStatus`).
  Each step also writes intermediate status via `storage.writeStatus` so
  `GET /api/trips/:id/status` (Task 8) reflects per-agent progress exactly like
  `server.mjs`'s `agents: {name: status}` map today.
- Consumes: `agents.mjs` (Task 3's portable core), `composio.mjs` (already
  portable, confirmed), `customTheme.mjs`, `render.mjs`'s `buildItineraryFiles`
  (Task 2), `worker/storage.mjs` (Task 5).

- [ ] **Step 1**: Write failing tests for a `runBriefStep(payload, ctx)`-style
  function per stage (extracted as plain functions the class's `run` calls, per
  docs/history/handover-cloud-2026-07-21.md's known trap #9 — **Workflow `step.do` bodies must not rely
  on closures capturing non-serializable state across steps; keep each step
  self-contained**).
- [ ] **Step 2**: Implement each step function reusing Task 3's agent functions
  and Task 5's storage adapter. Mirror `trip.mjs`'s existing `planTrip`/`renderTicket`
  control flow (fallback composer on failure, never-throws custom theme gate)
  rather than reinventing it — call into `trip.mjs`'s exported pure functions
  where they don't touch fs (need to audit `planTrip`/`renderTicket` during this
  task for any remaining fs reads beyond what Task 2 removed; expect none beyond
  the final write calls already excised).
- [ ] **Step 3**: Wire `TripPipelineWorkflow.run` to call the step functions via
  `step.do(name, () => stepFn(...))` in the dependency order from spec §3.
- [ ] **Step 4**: `npm test` (portable suite) + new Workflow unit tests green.
- [ ] **Step 5**: Commit: `feat: Workflow definition for trip pipeline (brief→...→manifest)`.

---

### Task 7: `POST /api/trips` — 🛑 Turnstile-gated trip creation + rate limit

**Blocked on (for live verification only):** Turnstile secret key,
`ANTHROPIC_API_KEY`/Composio secrets (Task 4's secrets step). Route logic and
unit tests (mocked Turnstile response, mocked bindings) can be written now.

**Files:**
- Create: `worker/routes/create-trip.mjs` (or `.ts`)
- Test: `tests/worker/create-trip.test.mjs`

**Interfaces:**
- Produces: `handleCreateTrip(request, env): Promise<Response>` — validates
  Turnstile token via `siteverify` (`fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', ...)`),
  validates body (`sentence` string, `visitor_id` matching
  `[A-Za-z0-9_-]{8,128}` per spec §2.1/README's existing composio.mjs
  convention), generates `trip_id`, calls `env.TRIP_WORKFLOW.create({params:
  {...}})`, writes initial KV status (`phase: 'queued'`), returns
  `{trip_id}` (201).
- Consumes: `worker/storage.mjs` (Task 5), `env.TRIP_WORKFLOW` (Task 4 binding).

- [ ] **Step 1**: Test: missing/invalid Turnstile token → 403 with friendly
  message (mock `fetch` to Cloudflare's siteverify endpoint).
- [ ] **Step 2**: Test: valid token + valid body → 201 + workflow triggered
  (assert `env.TRIP_WORKFLOW.create` called with expected payload shape).
- [ ] **Step 3**: Test: malformed `visitor_id`/oversized `sentence` → 400.
- [ ] **Step 4**: Implement to green.
- [ ] **Step 5**: Commit: `feat: POST /api/trips with Turnstile verification`.

*(Per-IP rate limiting itself is a Cloudflare dashboard/zone-level rule — Task 10,
not application code. This route's job is only to reject requests Turnstile/
validation reject; the 429 for rate-limit-exceeded requests never reaches this
handler.)*

---

### Task 8: `GET /api/trips/:id/status` + connect-accounts endpoints

**Files:**
- Create: `worker/routes/status.mjs`, `worker/routes/connect.mjs`
- Test: `tests/worker/status.test.mjs`, `tests/worker/connect.test.mjs`

**Interfaces:**
- `handleTripStatus(request, env, tripId): Promise<Response>` — KV read via
  `storage.readStatus`, 404 if unknown trip, else the `{phase, agents, log,
  manifest, error}` JSON (mirrors `server.mjs`'s existing shape, per Explore
  findings — keep the same field names so the frontend/polling logic ports with
  minimal changes).
- `handleConnectLink(request, env, tripId, provider): Promise<Response>` — calls
  `composio.mjs`'s `createConnectorLink`-equivalent using the visitor's stable
  id, returns `{authorization_url}`.
- `handleConnectStatus(request, env, tripId, provider): Promise<Response>` —
  calls `composio.mjs`'s connector-status check, returns `{connected: boolean}`.

- [ ] **Step 1**: Tests for status: unknown id → 404; known id → JSON shape match.
- [ ] **Step 2**: Tests for connect: mocked Composio client, link returns url,
  status reflects connected/not-connected.
- [ ] **Step 3**: Implement to green.
- [ ] **Step 4**: Commit: `feat: trip status + connect-account routes`.

---

### Task 9: Trip page serving — `/trips/<slug>/*` from R2

**Files:**
- Modify: `worker/index.ts` (routing: `/api/*` → route handlers, `/trips/<slug>/*`
  → `storage.getTripFile`, everything else → static app-shell assets)

**Interfaces:**
- `worker/index.ts` default export `fetch(request, env)`: path-based dispatch.
  App-shell (home/connect/progress pages, Task 11-13) served as Worker
  `[assets]` (small static bundle, separate from per-trip R2 content — the old
  single-`dist/`-as-assets model from `src/itinerary-worker.ts` doesn't fit
  anymore since trip content is generated per-request, not at build time).

- [ ] **Step 1**: Test: `GET /trips/unknown-id/` → 404. `GET /trips/<known>/`
  → 200 with R2-stored `index.html` content-type `text/html`.
  `GET /trips/<known>/manifest.webmanifest` → correct content-type (mirrors
  `server.mjs`'s existing manifest content-type handling).
- [ ] **Step 2**: Implement routing.
- [ ] **Step 3**: Commit: `feat: serve rendered trip sites from R2`.

---

### Task 10: 🛑 Frontend — home / connect-accounts / progress pages

**Blocked on:** nothing to *write* the pages, but real end-to-end click-through
needs Turnstile site key (Task 7) to render the widget, and a real deployed
Worker to test OAuth redirect round-trips (Task 4/15).

**Files:**
- Create: `worker/public/index.html` (paste-a-sentence + Turnstile widget),
  `worker/public/connect.html` (3 cards: Gmail/Calendar/Notion, skip button),
  `worker/public/progress.html` (polls `GET /api/trips/:id/status`)
- **Read `docs/design-system.md` before writing any of these** — reuse existing tokens
  (`--ink`/`--paper`/`--rail`/etc.), Archivo/Noto Sans TC/IBM Plex Mono role
  rules, ticket/coupon/stub component vocabulary already established for the
  Studio (`pipeline/studio.html` is the closest existing analog — same product,
  same visual language, adapt rather than invent).

- [ ] **Step 1**: Home page: textarea + Turnstile widget + submit → `POST
  /api/trips` → redirect to `connect.html?trip=<id>`.
- [ ] **Step 2**: Connect page: 3 cards calling Task 8's connect endpoints,
  "開始出票" (triggers workflow if not already triggered) + "跳過，直接出票"
  (explicit skip, per spec §2.2 — must not be a dark pattern; skip button as
  visually prominent as connect cards).
- [ ] **Step 3**: Progress page: poll `GET /api/trips/:id/status` every ~1.5s
  (matches `studio.html`'s existing polling cadence and diff-guard pattern —
  reuse that approach, don't reinvent), per-agent status list, redirect to
  `/trips/<id>/` on `phase: 'done'`.
- [ ] **Step 4**: Manual verification in `wrangler dev` (mocked bindings) —
  visually check against docs/design-system.md tokens; automated a11y checks where the
  existing Studio has them.
- [ ] **Step 5**: Commit: `feat: public-facing home/connect/progress pages`.

---

### Task 11: 🛑 Zack-provided secrets + rate-limit rule + first real deploy

**Blocked on:** every item in docs/history/handover-cloud-2026-07-21.md's Zack list. **Do not proceed
past Step 1 without them; do not substitute placeholder/fake values.**

- [ ] **Step 1**: Ask Zack for (re-confirming what's needed, all can arrive at once
  or incrementally): `wrangler login` done / API token; `ANTHROPIC_API_KEY`;
  `COMPOSIO_API_KEY` + 3 auth config IDs; Turnstile site key + secret;
  green light for the R2 bucket / KV namespace / Workflow provisioning
  (Task 4 Step 2); decision on Workers Paid upgrade (only needed if free-tier
  10ms CPU is hit during real render testing).
- [ ] **Step 2** (after keys arrive): `wrangler secret put ANTHROPIC_API_KEY`,
  `wrangler secret put COMPOSIO_API_KEY`, `wrangler secret put
  COMPOSIO_GMAIL_AUTH_CONFIG_ID` (×3), `wrangler secret put
  TURNSTILE_SECRET_KEY`. Put the Turnstile **site key** (public) into the
  frontend config, not as a secret.
- [ ] **Step 3**: `wrangler dev --remote` smoke: full flow once against real
  bindings — paste a sentence, see connect page, skip, see progress, land on
  `/trips/<slug>/`.
- [ ] **Step 4**: Ask Zack to add the Cloudflare rate-limiting rule (dashboard) —
  per-IP trip creation cap (spec says start at 5/hour). Offer to do it via API/
  Terraform if Zack provides a token with zone permissions; otherwise this is
  purely his action.
- [ ] **Step 5**: `wrangler deploy --config wrangler.itinerary.toml`.
- [ ] **Step 6**: Run through docs/history/handover-cloud-2026-07-21.md's 驗收基準 end-to-end on the live
  URL: fresh browser → paste sentence → connect page (skippable) → progress →
  `/trips/<slug>/` persists across browser restart; a connected-Gmail/Calendar
  trip shows `agent_statuses` `ok` and reflects personal data, skipped ones show
  `skipped`; motif injection payloads render as plain text; `npm test` +
  Worker/miniflare tests green; missing-Turnstile-token request rejected;
  over-quota same-IP request gets 429.
- [ ] **Step 7**: If free-tier 10ms CPU limit is hit on the render step during
  Step 6, report back to Zack with the actual measured timing before deciding
  to upgrade (don't preemptively assume Paid is needed).

---

## Task sequencing summary

Tasks 1-3 are unblocked and portable-logic-only — start immediately, no
Cloudflare account needed. Tasks 5-6 need only Task 4's *config* (bindings can
be authored/tested against mocks before real provisioning). Task 4's actual
resource creation, and all of Tasks 7/10/11's live-integration points, need
Zack. Recommended order: 1 → 2 → 3 → 4(config only) → 5 → 6 → 7 → 8 → 9 → 10 →
[stop, ask Zack] → 4(provision) → 11.
