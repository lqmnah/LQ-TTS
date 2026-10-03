# LQ-TTS Web Client, Container and Public Release Implementation Plan (2C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the LQ-TTS browser app (React Router 7 + Vite + Tailwind), package it with the plan-2B Express server into one OrbStack image, and release it on mac-studio as `tts-stg.lq-studio.com` (behind Cloudflare Access) and then `tts.lq-studio.com`, gated by Playwright proof.

**Architecture:** `web/client/` is a single-page app that only talks to the plan-2B browser API (contract C2) through one API module (`src/lib/api.js`); live progress comes from the SSE endpoint and goes through a pure reducer (`src/lib/progress.js`). The plan-2B server serves `client/dist` and `/api` from one Node 26 process; `web/Dockerfile` builds the client and the server into one image, and `web/compose.yaml` runs `lq-tts-web-stg` (127.0.0.1:8750) and `lq-tts-web-prod` (127.0.0.1:8751). A new remotely-managed Cloudflare tunnel `lq-tts`, run by pm2 on mac-studio, publishes both hostnames.

**Tech Stack:** React 19.3, react-router 7.18.4 (library mode), Vite 8.3, Tailwind CSS 4.3 (`@tailwindcss/vite`), `@phosphor-icons/react` 2.1.10 (inline SVG icons), Space Grotesk + JetBrains Mono (self-hosted via `@fontsource-variable`), Vitest 5 + Testing Library + jsdom, Playwright 1.63, Docker (OrbStack) + Compose, cloudflared 2026.7.1 under pm2, Cloudflare API through omp's `xd://mcp__cloudflare_execute`.

**Spec:** `docs/superpowers/specs/2026-10-02-web-app-design.md` on branch `main` of `~/Developer/LQ-TTS` (mac-studio). Read it with `git show main:docs/superpowers/specs/2026-10-02-web-app-design.md`. Sections this plan implements: §3 Screens, §8 errors 1/4/5/6/7 (client side), §9 UI testing, visual design and release order (2) and (3).

## Global Constraints

- Every command runs on **mac-studio** in `~/Developer/LQ-TTS/web` unless a step says otherwise. Non-interactive ssh needs `export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH` first (node, npm, npx, pm2, docker, psql, cloudflared live there).
- Branch: `feat/web-app`, created in place from `feat/voice-engine` in `~/Developer/LQ-TTS` by plan 2B Task 1. Never switch the checkout to another branch: pm2 runs the live engine from this same checkout.
- Commits: author `lqmnah <lqmnah@users.noreply.github.com>` via `git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit ...`; no `Co-Authored-By`, no Claude/Anthropic/AI wording anywhere in messages (SOP G8).
- Secrets are never printed: never `cat`/`echo`/display an `.env*` file or a token file. A secret may be read only inside a pipe whose sink is `ops/env-set.mjs`, `ops/env-container.mjs` or `umask 077; cat > file`; the sinks print key names and lengths only.
- Browser API = contract C2 exactly (paths, bodies, `X-Requested-With: lq-tts` on every non-GET, errors `{error:{code,message}}`). The client never calls the engine or LQ-Studio directly.
- `POST /api/voices` multipart: text fields first, `audio` **last** (plan 2B streams the file and checks consent/name/limit before it).
- `Me.voiceCount` and `Me.balance` may be `null` (engine or LQ-Studio unreachable); render `–`, never crash.
- Pricing shown in the UI: `credits = max(1, ceil(chars / 1000 × 10))`, `1 credit = Rp100`; voice limits Free 3 / paid 25 come from `Me.voiceLimit`; consent version `v1` is recorded by the server.
- Upload limits enforced in the browser: MP3/WAV/M4A/FLAC, ≤ **95 MB** (`95 * 1024 * 1024` = 99,614,720 bytes; controller ruling 2026-10-03: Cloudflare Free caps request bodies at 100 MB, the engine keeps 200 MB for internal callers); the server enforces the same 95 MB with code `too_large`. Too-large copy suggests exporting the recording as MP3 or M4A. Scripts ≤ 20,000 characters.
- Settings sent to `POST /api/jobs` are engine-native snake_case: `{speed: 0.7–1.3 (default 0.9), pause_sentence_s: 0–3 (0.45), pause_paragraph_s: 0–3 (0.80), formats: subset of ["mp3","wav","srt","vtt"] (all)}`.
- UI copy: Indonesian ⇄ English, complete dictionaries, **zero em dashes** (`—`) anywhere in UI text, no emoji, no Unicode glyphs as icons: every icon is an inline SVG from `@phosphor-icons/react` (SOP G4).
- SOP G4 skills load together before any UI edit: `~/.claude/skills/ui-pro-max/SKILL.md`, `~/.claude/skills/impeccable/SKILL.md` (Operate mode; run `node ~/.claude/skills/impeccable/scripts/context.mjs --target web/client/src` once per session from `~/Developer/LQ-TTS`; read `~/.claude/skills/impeccable/reference/operate.md`; read `~/.claude/skills/impeccable/reference/craft-floor.md` **right before** the first UI file edit of each session), `~/.claude/skills/design-taste-frontend/SKILL.md`, `~/.claude/skills/gpt-taste/SKILL.md`. On mac-studio the skills live at the same `~/.claude/skills/` paths.
- SOP G5 proof is Playwright on mac-studio: screenshots, clean console, clean network, real interaction (click/type/submit then re-read), measurements with `getBoundingClientRect()` (never `getComputedStyle().width`), strict text matching (`exact: true`), `.value` for form fields.
- Ports: staging `127.0.0.1:8750`, PROD `127.0.0.1:8751`, Playwright-local server `127.0.0.1:8760`, fake LQ-Studio `127.0.0.1:8798`. Engine `127.0.0.1:8740` (host) / `http://host.internal:8740` (containers). Postgres `127.0.0.1:5432` (host) / `host.internal:5432` (containers), database `lq_tts`, role `lq_tts_web`, schemas `lq_tts_web_stg` / `lq_tts_web` / `lq_tts_web_e2e`.
- LQ-Studio internal API from mac-studio: staging `http://100.80.128.19:3112`, PROD `http://100.80.128.19:3101` (relay forwards only `/api/internal/tts/*` and `GET /api/health`). LQ-Studio public origin: staging `https://demo.lq-studio.com`, PROD `https://lq-studio.com`.
- Cloudflare: account zone `lq-studio.com` = `ef276f9dab10a565f64091c07d92ac8c`; Zero Trust org `lq-studio.cloudflareaccess.com`; One-time-PIN IdP `1259c1fd-e5f7-4cc8-a7a9-b6555bc1d9d2`; owner email `lqmnah26@gmail.com`; tunnels run `--protocol http2` (QUIC caused 502/520 blips on 2026-09-02). Never `GET …/cfd_tunnel/{id}/token` into a transcript: only inside an eval kernel that pipes it to the host.
- Release order (spec §9): plan 2A deployed to LQ-Studio staging → `lq-tts-web-stg` + `tts-stg.lq-studio.com` behind Access → Playwright journey green on staging → plan 2A PROD → `lq-tts-web-prod` + `tts.lq-studio.com`.

## Dependencies on other plans

Plan 2B (server, `web/`), consumed exactly as follows:
- `web/package.json` (server deps, `"type":"module"`, scripts `start`=`node server/index.js`, `migrate`, `test`=`vitest run` scoped to `server/**`), `web/package-lock.json`, entry `web/server/index.js`.
- Static files from env `CLIENT_DIST` (default `<web>/client/dist`), SPA fallback for non-`/api` GET.
- Env (required unless defaulted): `HOST` (default 127.0.0.1; containers set `0.0.0.0`), `PORT` (8750), `DATABASE_URL`, `DB_SCHEMA`, `ENGINE_URL`, `ENGINE_TOKEN`, `ENGINE_CALLBACK_SECRET`, `ENGINE_CALLBACK_URL`, `LQSTUDIO_URL`, `LQSTUDIO_TOKEN` (≥32 chars), `LQSTUDIO_PUBLIC_URL`, `COOKIE_SECURE` (default true; `"false"` for http), `CLIENT_DIST`, `MAX_UPLOAD_BYTES` (99614720 = 95 MB per the controller ruling; this plan also sets it explicitly in `compose.yaml`), `RECONCILE_INTERVAL_MS` (60000). Migrations run at startup (idempotent, advisory lock).
- `web/.env.stg` (gitignored by plan 2B's `.env.*` rule, mode 600) written by plan 2B with `ENGINE_TOKEN`/`ENGINE_CALLBACK_SECRET` of engine caller `lq-tts-stg` and `DATABASE_URL` of role `lq_tts_web`.
- `web/server/test/fakes/fake-lqstudio.js` exports `startFakeLqStudio({port, token, users}) → {url, state, close()}`; user shape `{id, name, email, username, password, totp: null|"<6 digits>", verified, suspended, plan, paid, balance}`; `verify-2fa` accepts `code === totp`.
- `GET /api/health` always 200 `{engine, lqstudio}`; SSE relay writes `: keepalive` every 15 s; `CF-Connecting-IP` used as end-user IP.

Plan 2A (LQ-Studio, lq-server): internal TTS API live on staging (`:3112`) before Task 13 and on PROD (`:3101`) before Task 15; token `LQ_TTS_INTERNAL_TOKEN` in `/home/lq/lq-studio-stg/.env` (staging) and `/home/lq/lq-studio-prod/repo/.env` (PROD), one line `LQ_TTS_INTERNAL_TOKEN=<64 hex>`.

## Design direction (SOP G4: ui-pro-max + impeccable + design-taste-frontend + gpt-taste)

**Design read:** an Operate-mode tool for LQ-Studio creators who write scripts and listen back sentence by sentence at a desk, sometimes on a phone; it must feel like a sibling of LQ-Studio (same account, same wallet) and disappear into the task.

**Dials (design-taste §1):** DESIGN_VARIANCE 3 (predictable app grid), MOTION_INTENSITY 3 (state-only motion), VISUAL_DENSITY 5 (daily app). design-taste §13 marks dense product UI as out of its scope, so only its anti-slop bans apply (no em dash, no Inter default, no AI purple, no three equal cards, no fake data, one accent, one radius system, label above input, no placeholder-as-label, button contrast, CTA never wraps). gpt-taste's AIDA/GSAP/bento rules target landing pages; the parts applied here are: headings never wrap into walls (wide containers, `text-wrap: balance`), no meta-labels or section numbers, perfect button contrast, `overflow-x` guard on the page, no emoji. No GSAP: impeccable Operate forbids decorative choreography.

**Incumbent visual truth:** LQ-Studio client (`/home/lq/lq-studio-prod/repo/client/src/index.css`, `tailwind.config.js`): near-black `#0A0A0C`, surfaces `#17181C`/`#1E2025`, ink `#F9FBFC`, mint accent `#7CF3D1` on dark / `#0F7D66` on light, Space Grotesk + JetBrains Mono. LQ TTS reuses these so a user crossing from LQ-Studio sees the same family; LQ-Studio's serif display face is not used (product UI: one family).

**Theme:** follows `prefers-color-scheme`, dark is the reference (LQ-Studio users live in dark); both themes are verified in Playwright.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--c-bg` | `#0A0A0C` | `#FBFCFD` | page |
| `--c-surface` | `#17181C` | `#FFFFFF` | panels, sidebar, inputs |
| `--c-surface-2` | `#1E2025` | `#F4F6F8` | hover, segmented track, editor tray |
| `--c-line` | `#2A2C33` | `#DCE1E6` | 1px borders and dividers |
| `--c-ink` | `#F9FBFC` | `#0C1116` | primary text |
| `--c-muted` | `#9BA6BC` | `#4A5561` | secondary text (≥ 7:1) |
| `--c-dim` | `#8490AB` | `#5E6B78` | tertiary text (≥ 4.5:1 on surface) |
| `--c-accent` | `#7CF3D1` | `#0F7D66` | primary action, current nav, progress, focus ring |
| `--c-accent-ink` | `#0A0A0C` | `#FFFFFF` | text on accent |
| `--c-accent-soft` | `#15302A` | `#E3F4EF` | selected nav, arrival flash |
| `--c-danger` / soft | `#FF6B6B` / `#2E1717` | `#B3261E` / `#FBE9E7` | errors, destructive |
| `--c-warning` / soft | `#FFD166` / `#2E2614` | `#8A5A00` / `#FDF3DC` | banners, top-up prompts |
| `--c-success` / soft | `#4ADE80` / `#13291C` | `#12714A` / `#E2F3EA` | ready, done |

- **Type:** Space Grotesk Variable for all UI text; JetBrains Mono Variable only for measurements (credits, characters, durations, scores, OTP code). Fixed rem scale, ratio ≈ 1.2: `xs 12/16`, `sm 14/20`, `base 16/24` (inputs stay 16 px so iOS never zooms), `lg 20/28`, `xl 24/32`, `2xl 28/36` (page titles). Weights 400/500/600. Headings `letter-spacing -0.01em`, `text-wrap: balance`. Prose measure ≤ 70ch.
- **Spacing:** 4-px base, used steps 4/8/12/16/20/24/32/48. Tight inside groups (8–12), loose between groups (24–32).
- **Radius (one documented rule):** controls (buttons, inputs, selects, chips of formats) 10 px; panels 14 px; status chips and round icon buttons (play) full; segmented inner thumb 6 px (outer 10 − padding 4).
- **Elevation:** only the account popover floats (`--shadow-pop`, offset + soft blur, tinted to the background). Everything else is flat with 1 px lines.
- **Motion (ui-pro-max timing budget, Operate 150–250 ms):** press `scale(0.98)` instantly (≤ 50 ms feedback); color/border transitions 150 ms ease-out; popover enter 180 ms `cubic-bezier(0.16,1,0.3,1)`, caret rotate 200 ms; progress fill `transform: scaleX` 300 ms ease-out; sentence arrival = one authored moment: 700 ms accent-soft wash fading out (`animate-arrive`) when a sentence turns done; skeleton pulse 1.6 s; spinners linear. All motion collapses under `prefers-reduced-motion: reduce`.
- **Layout:** ≥ 1024 px sidebar 232 px + content max 1120 px; 768–1023 px icon rail 72 px (labels become `title`/sr-only); < 768 px top bar + fixed bottom tab bar 64 px (+ safe area). Text to Speech ≥ 1024 px: script editor (fluid) + 320 px settings column; below 1024 px stacked. History and Credits use real tables (columns drop below `md`/`lg`).
- **States (every interactive element):** default, hover, focus-visible (2 px accent outline, 2 px offset), active, disabled (`text-dim`, `cursor-not-allowed`, never opacity), loading (spinner inside the button, label changes), error (message below the field naming the fix). Touch targets ≥ 44 px on coarse pointers (`pointer-coarse:min-h-11`). Destructive actions use an inline two-step confirm whose button verb repeats the action ("Hapus suara"), never "Ya".
- **Refused (craft floor):** eyebrow/kicker labels, gradient text, glass, colored side borders, hero-metric blocks, nested cards, modals (none are needed: forms and confirms are inline), display fonts in UI, Unicode glyph icons.
- **z-index scale:** `--z-sticky 10`, `--z-popover 30`, `--z-skip 50` (declared once in `styles.css`).

## File Structure

```
web/
  client/
    package.json, package-lock.json      client deps + scripts (dev/build/test)
    vite.config.js                       React + Tailwind plugins, /api dev proxy, Vitest config
    index.html, public/favicon.svg       shell document + brand mark
    src/
      main.jsx                           providers + RouterProvider
      router.jsx                         route table (grows per page task)
      styles.css                         Tailwind v4 import, tokens, base layer, keyframes
      i18n/id.js, i18n/en.js             complete dictionaries (flat keys)
      i18n/index.jsx                     I18nProvider, useI18n, translate, translateCount, hasKey, LANG_OPTIONS
      lib/types.js                       JSDoc typedefs of contract C2 shapes
      lib/api.js                         the only HTTP module: request, ApiError, api.*, createVoice (XHR), urls, openJobEvents
      lib/errors.js                      error code → localized text (API, voice, job)
      lib/pricing.js                     credit formula, number/rupiah formatting, charCount
      lib/format.js                      date, duration, bytes
      lib/progress.js                    SSE progress reducer
      lib/session.jsx                    SessionProvider/useSession (me, refresh, signedIn, logout, changeLang)
      lib/useResource.js                 load/reload hook
      lib/useHealth.js                   /api/health poller
      lib/useAudioToggle.js              one-at-a-time audio playback
      lib/links.js                       LQ-Studio origin, safe ?next=
      lib/draft.js                       per-user script/settings draft in localStorage
      lib/voices.js                      upload validation, limit counting
      lib/download.js                    programmatic download
      components/ui.jsx                  Button, buttonClass, Field, inputClass, Select, Notice, Skeleton, EmptyState, StatusChip, PageHeader, Segmented
      components/status.jsx              JobStatus, SentenceStatus, VoiceStatus chips
      components/PlayButton.jsx          round play/pause toggle
      components/AppShell.jsx            sidebar/rail/bottom nav, header, banner, <Outlet context={{health}}>
      components/AccountMenu.jsx         name/email/plan, ID⇄EN, log out
      components/EngineBanner.jsx        engine restarting / LQ-Studio down
      components/RequireSession.jsx      session gate + loading/error shells
      pages/LoginPage.jsx                credentials → 2FA → needs-verification
      pages/TtsPage.jsx                  script editor, voice picker, settings, price, Generate
      pages/JobPage.jsx                  live progress, sentences, play/edit/regenerate, revisions, downloads, cancel/delete
      pages/VoicesPage.jsx               list, clone form with consent and limit, preview, delete
      pages/HistoryPage.jsx              paged table, open/download/delete
      pages/CreditsPage.jsx              balance, top-up, usage
      pages/NotFoundPage.jsx
      test/setup.js, test/render.jsx     Vitest setup + provider/router render helper
      **/*.test.js(x)                    unit and component tests next to the code
  e2e/
    package.json, package-lock.json      @playwright/test only
    playwright.config.js                 projects journey → screens, smoke
    target.mjs                           targets local / staging-public / prod, credentials, constants
    harness/fake-lqstudio.mjs            launches plan 2B's fake LQ-Studio
    harness/run-server.mjs               launches the real server against fake LQ-Studio + real engine
    harness/totp.mjs, totp.test.mjs      RFC 6238 TOTP for the staging account
    harness/layout.mjs                   overflow / touch-target / font measurements
    staging/seed-lqstudio-user.mjs       creates the staging-only LQ-Studio account (runs inside lq-studio-stg-lqs)
    tests/fixtures.js                    console + network guard fixture
    tests/journey.spec.js                spec §9 journey
    tests/screens.spec.js                390/768/1440 screenshots + measurements (dark, plus light at 1440)
    tests/smoke.spec.js                  public smoke for PROD
    .gitignore
  ops/
    env-lib.mjs, env-lib.test.mjs        env parsing/writing (mode 600), engine pairs, DB host rewrite
    env-set.mjs                          stdin → one key in an env file
    env-container.mjs                    native env → container secrets file
    env-check.mjs                        presence/length check without printing values
  Dockerfile, .dockerignore, compose.yaml
```

---

### Task 1: Client package, design tokens, pricing and formatting

**Files:**
- Create: `web/client/package.json` (via npm), `web/client/vite.config.js`, `web/client/index.html`, `web/client/public/favicon.svg`, `web/client/src/styles.css`, `web/client/src/test/setup.js`, `web/client/src/lib/pricing.js`, `web/client/src/lib/format.js`
- Test: `web/client/src/lib/pricing.test.js`, `web/client/src/lib/format.test.js`

**Interfaces:**
- Produces: `creditsFor(chars:number):number`, `rupiahFor(credits:number):number`, `charCount(text:string):number` (Unicode code points), `formatNumber(n:number, lang:'id'|'en'):string`, `formatRupiah(n:number, lang):string` (`"Rp1.100"` / `"Rp1,100"`), `CREDITS_PER_1K_CHARS=10`, `RUPIAH_PER_CREDIT=100`; `formatDateTime(iso:string|null, lang):string`, `formatDuration(seconds:number|null):string` (`"1:05"`, `"1:01:05"`, `"–"` for null), `formatBytes(bytes:number, lang):string` (`"12,3 MB"` / `"12.3 MB"`). Tailwind color utilities `bg-bg`, `bg-surface`, `bg-surface-2`, `border-line`, `text-ink`, `text-muted`, `text-dim`, `bg-accent`, `text-accent`, `text-accent-ink`, `bg-accent-soft`, `text-danger`, `bg-danger-soft`, `text-warning`, `bg-warning-soft`, `text-success`, `bg-success-soft`, radii `rounded-control`/`rounded-panel`, animations `animate-arrive`, `animate-skeleton`, `animate-pop`.

- [ ] **Step 1: Load SOP G4 skills and impeccable context**

Read the four SKILL.md files and `operate.md` listed in Global Constraints. Then, from `~/Developer/LQ-TTS`:

Run: `node ~/.claude/skills/impeccable/scripts/context.mjs --target web/client/src`
Expected: it prints its directives (PRODUCT.md/DESIGN.md are absent; treat this plan's Design direction section as the brief). Do not rerun it this session.

- [ ] **Step 2: Create the package and install exact versions**

```bash
mkdir -p ~/Developer/LQ-TTS/web/client && cd ~/Developer/LQ-TTS/web/client
npm init -y >/dev/null
npm pkg set name=lq-tts-web-client private=true type=module
npm pkg delete main description keywords author license scripts.test
npm pkg set scripts.dev="vite" scripts.build="vite build" scripts.test="vitest run"
npm install --save-exact react@19.3.0 react-dom@19.3.0 react-router@7.18.4 @phosphor-icons/react@2.1.10 @fontsource-variable/space-grotesk@5.3.0 @fontsource-variable/jetbrains-mono@5.3.0
npm install --save-exact --save-dev vite@8.3.2 @vitejs/plugin-react@6.1.1 tailwindcss@4.3.3 @tailwindcss/vite@4.3.3 vitest@5.0.3 jsdom@30.1.1 @testing-library/react@16.3.3 @testing-library/dom@10.4.2 @testing-library/jest-dom@7.0.1 @testing-library/user-event@14.6.7
```
Expected: `added N packages`, no `ERESOLVE`. `package.json` has `"type": "module"` and the three scripts.

- [ ] **Step 3: Write `vite.config.js`**

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.LQTTS_API ?? 'http://127.0.0.1:8760' } },
  },
  build: { outDir: 'dist', sourcemap: false },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    css: false,
    include: ['src/**/*.test.{js,jsx}'],
  },
});
```

- [ ] **Step 4: Write `index.html` and `public/favicon.svg`**

`index.html`:
```html
<!doctype html>
<html lang="id">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark light" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0A0A0C" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#FBFCFD" />
    <title>LQ TTS</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

`public/favicon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0A0A0C"/><g fill="#7CF3D1"><rect x="7" y="13" width="3" height="6" rx="1.5"/><rect x="12" y="9" width="3" height="14" rx="1.5"/><rect x="17" y="6" width="3" height="20" rx="1.5"/><rect x="22" y="11" width="3" height="10" rx="1.5"/></g></svg>
```

- [ ] **Step 5: Write `src/styles.css` (tokens from the Design direction table)**

```css
@import "tailwindcss";
@import "@fontsource-variable/space-grotesk";
@import "@fontsource-variable/jetbrains-mono";

:root {
  color-scheme: light dark;
  --c-bg: #fbfcfd;
  --c-surface: #ffffff;
  --c-surface-2: #f4f6f8;
  --c-line: #dce1e6;
  --c-ink: #0c1116;
  --c-muted: #4a5561;
  --c-dim: #5e6b78;
  --c-accent: #0f7d66;
  --c-accent-ink: #ffffff;
  --c-accent-soft: #e3f4ef;
  --c-danger: #b3261e;
  --c-danger-soft: #fbe9e7;
  --c-warning: #8a5a00;
  --c-warning-soft: #fdf3dc;
  --c-success: #12714a;
  --c-success-soft: #e2f3ea;
  --shadow-pop: 0 8px 24px -8px rgb(12 17 22 / 0.18), 0 2px 6px -2px rgb(12 17 22 / 0.1);
  --z-sticky: 10;
  --z-popover: 30;
  --z-skip: 50;
}

@media (prefers-color-scheme: dark) {
  :root {
    --c-bg: #0a0a0c;
    --c-surface: #17181c;
    --c-surface-2: #1e2025;
    --c-line: #2a2c33;
    --c-ink: #f9fbfc;
    --c-muted: #9ba6bc;
    --c-dim: #8490ab;
    --c-accent: #7cf3d1;
    --c-accent-ink: #0a0a0c;
    --c-accent-soft: #15302a;
    --c-danger: #ff6b6b;
    --c-danger-soft: #2e1717;
    --c-warning: #ffd166;
    --c-warning-soft: #2e2614;
    --c-success: #4ade80;
    --c-success-soft: #13291c;
    --shadow-pop: 0 12px 32px -12px rgb(0 0 0 / 0.6), 0 2px 8px -2px rgb(0 0 0 / 0.4);
  }
}

@theme inline {
  --font-sans: "Space Grotesk Variable", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono Variable", ui-monospace, monospace;
  --color-bg: var(--c-bg);
  --color-surface: var(--c-surface);
  --color-surface-2: var(--c-surface-2);
  --color-line: var(--c-line);
  --color-ink: var(--c-ink);
  --color-muted: var(--c-muted);
  --color-dim: var(--c-dim);
  --color-accent: var(--c-accent);
  --color-accent-ink: var(--c-accent-ink);
  --color-accent-soft: var(--c-accent-soft);
  --color-danger: var(--c-danger);
  --color-danger-soft: var(--c-danger-soft);
  --color-warning: var(--c-warning);
  --color-warning-soft: var(--c-warning-soft);
  --color-success: var(--c-success);
  --color-success-soft: var(--c-success-soft);
}

@theme {
  --text-xs: 0.75rem;
  --text-xs--line-height: 1rem;
  --text-sm: 0.875rem;
  --text-sm--line-height: 1.25rem;
  --text-base: 1rem;
  --text-base--line-height: 1.5rem;
  --text-lg: 1.25rem;
  --text-lg--line-height: 1.75rem;
  --text-xl: 1.5rem;
  --text-xl--line-height: 2rem;
  --text-2xl: 1.75rem;
  --text-2xl--line-height: 2.25rem;
  --radius-control: 10px;
  --radius-panel: 14px;
  --animate-arrive: sentence-arrive 700ms cubic-bezier(0.16, 1, 0.3, 1);
  --animate-skeleton: skeleton-pulse 1.6s ease-in-out infinite;
  --animate-pop: pop-in 180ms cubic-bezier(0.16, 1, 0.3, 1);

  @keyframes sentence-arrive {
    from { background-color: var(--c-accent-soft); }
    to { background-color: transparent; }
  }
  @keyframes skeleton-pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }
  @keyframes pop-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to { opacity: 1; transform: none; }
  }
}

@layer base {
  html {
    background-color: var(--c-bg);
    color: var(--c-ink);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  body { min-height: 100dvh; overflow-x: hidden; }
  h1, h2, h3 { letter-spacing: -0.01em; text-wrap: balance; }
  :focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; }
  ::selection { background-color: var(--c-accent-soft); }
  .tabular { font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
}
```

- [ ] **Step 6: Write `src/test/setup.js`**

```js
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
```

- [ ] **Step 7: Write the failing tests**

`src/lib/pricing.test.js`:
```js
import { describe, expect, it } from 'vitest';
import { CREDITS_PER_1K_CHARS, RUPIAH_PER_CREDIT, charCount, creditsFor, formatNumber, formatRupiah, rupiahFor } from './pricing.js';

describe('creditsFor (spec §4: max(1, ceil(chars/1000*10)))', () => {
  it('charges nothing for an empty script', () => {
    expect(creditsFor(0)).toBe(0);
  });
  it('charges the 1-credit minimum for tiny scripts', () => {
    expect(creditsFor(1)).toBe(1);
    expect(creditsFor(100)).toBe(1);
  });
  it('rounds up at every 100 characters', () => {
    expect(creditsFor(101)).toBe(2);
    expect(creditsFor(1000)).toBe(10);
    expect(creditsFor(1001)).toBe(11);
    expect(creditsFor(20000)).toBe(200);
  });
  it('uses the configured constants', () => {
    expect(CREDITS_PER_1K_CHARS).toBe(10);
    expect(RUPIAH_PER_CREDIT).toBe(100);
    expect(rupiahFor(11)).toBe(1100);
  });
});

describe('charCount', () => {
  it('counts code points, not UTF-16 units (matches the Python engine)', () => {
    expect(charCount('abc')).toBe(3);
    expect(charCount('é')).toBe(1);
    expect(charCount('𝄞')).toBe(1);
  });
});

describe('number formatting', () => {
  it('groups thousands per language', () => {
    expect(formatNumber(20000, 'id')).toBe('20.000');
    expect(formatNumber(20000, 'en')).toBe('20,000');
  });
  it('writes rupiah without a space, as in the spec', () => {
    expect(formatRupiah(1100, 'id')).toBe('Rp1.100');
    expect(formatRupiah(1100, 'en')).toBe('Rp1,100');
  });
});
```

`src/lib/format.test.js`:
```js
import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration } from './format.js';

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65.4)).toBe('1:05');
    expect(formatDuration(599.6)).toBe('10:00');
  });
  it('adds hours past one hour', () => {
    expect(formatDuration(3665)).toBe('1:01:05');
  });
  it('renders a dash for unknown values', () => {
    expect(formatDuration(null)).toBe('–');
    expect(formatDuration(Number.NaN)).toBe('–');
  });
});

describe('formatBytes', () => {
  it('uses MB with one decimal and the language separator', () => {
    expect(formatBytes(12.3 * 1024 * 1024, 'id')).toBe('12,3 MB');
    expect(formatBytes(12.3 * 1024 * 1024, 'en')).toBe('12.3 MB');
  });
  it('uses KB below one megabyte', () => {
    expect(formatBytes(2048, 'en')).toBe('2 KB');
  });
});
```

- [ ] **Step 8: Run tests to verify they fail**

Run: `cd ~/Developer/LQ-TTS/web/client && npx vitest run src/lib`
Expected: FAIL, `Failed to resolve import "./pricing.js"` and `"./format.js"`.

- [ ] **Step 9: Implement `src/lib/pricing.js`**

```js
export const CREDITS_PER_1K_CHARS = 10;
export const RUPIAH_PER_CREDIT = 100;

const LOCALES = { id: 'id-ID', en: 'en-US' };

/** Number of Unicode code points (the engine counts characters the same way). */
export function charCount(text) {
  return [...text].length;
}

/** Spec §4: credits = max(1, ceil(chars / 1000 × 10)); an empty script costs nothing. */
export function creditsFor(chars) {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.max(1, Math.ceil((chars * CREDITS_PER_1K_CHARS) / 1000));
}

export function rupiahFor(credits) {
  return credits * RUPIAH_PER_CREDIT;
}

export function formatNumber(n, lang) {
  return new Intl.NumberFormat(LOCALES[lang] ?? LOCALES.id).format(n);
}

export function formatRupiah(n, lang) {
  return `Rp${formatNumber(n, lang)}`;
}
```

- [ ] **Step 10: Implement `src/lib/format.js`**

```js
const LOCALES = { id: 'id-ID', en: 'en-US' };
const DASH = '–';

export function formatDateTime(iso, lang) {
  if (!iso) return DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return DASH;
  return new Intl.DateTimeFormat(LOCALES[lang] ?? LOCALES.id, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH;
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatBytes(bytes, lang) {
  const locale = LOCALES[lang] ?? LOCALES.id;
  if (bytes < 1024 * 1024) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bytes / 1024)} KB`;
  }
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MB`;
}
```

- [ ] **Step 11: Run tests to verify they pass**

Run: `npx vitest run src/lib`
Expected: PASS, 2 files, 12 tests.

- [ ] **Step 12: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/client/package.json web/client/package-lock.json web/client/vite.config.js web/client/index.html web/client/public/favicon.svg web/client/src/styles.css web/client/src/test/setup.js web/client/src/lib/pricing.js web/client/src/lib/pricing.test.js web/client/src/lib/format.js web/client/src/lib/format.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: package, design tokens, pricing and formatting"
```

---

### Task 2: Complete ID/EN dictionaries and the i18n provider

**Files:**
- Create: `web/client/src/i18n/id.js`, `web/client/src/i18n/en.js`, `web/client/src/i18n/index.jsx`
- Test: `web/client/src/i18n/i18n.test.js`

**Interfaces:**
- Produces: `I18nProvider({children, initialLang?})`, `useI18n() → {lang, setLang(lang), t(key, vars?), tn(key, count, vars?)}`, `translate(lang, key, vars?)`, `translateCount(lang, key, count, vars?)` (picks `<key>_one` when `count === 1`, else `<key>_other`; `{count}` defaults to the raw count), `hasKey(key)`, `DICTS`, `LANG_OPTIONS = [{value:'id', label:'ID', ariaLabel:'Bahasa Indonesia'}, {value:'en', label:'EN', ariaLabel:'English'}]`. Language persisted in `localStorage['lqtts_lang']`, mirrored to `<html lang>`. Default `id`.
- Dynamic key families later tasks build at runtime (all present in both dictionaries): `plan.{free,pro,ultra,sultan}`, `error.<C2 code>` + `error.{network,generic,rate_limited_later}`, `job.status.{queued,running,done,failed,canceled}`, `job.failed.{synthesis_failed,worker_crashed,internal_error,canceled,unknown}`, `job.sentence.status.{pending,running,done,needs_review}`, `voices.status.{processing,ready,failed}`, `voices.language.{auto,id,en}`, `voices.error.{no_clean_speech,unsupported_audio,internal_error,unknown}`, `credits.kind.{job,regenerate}`, `credits.state.{held,settled,refunded}`.

- [ ] **Step 1: Write the failing test `src/i18n/i18n.test.js`**

```js
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import en from './en.js';
import id from './id.js';
import { translate, translateCount } from './index.jsx';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'i18n' || name === 'test' ? [] : sourceFiles(path);
    return /\.(js|jsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const C2_ERROR_CODES = ['unauthorized', 'invalid_request', 'invalid_credentials', 'invalid_code', 'rate_limited', 'suspended',
  'needs_verification', 'lqstudio_unavailable', 'engine_unavailable', 'insufficient_credits', 'voice_limit_reached',
  'consent_required', 'not_found', 'too_large', 'unsupported_audio', 'not_regeneratable', 'voice_not_ready'];

const DYNAMIC_FAMILIES = {
  plan: ['free', 'pro', 'ultra', 'sultan'],
  error: [...C2_ERROR_CODES, 'network', 'generic', 'rate_limited_later'],
  'job.status': ['queued', 'running', 'done', 'failed', 'canceled'],
  'job.failed': ['synthesis_failed', 'worker_crashed', 'internal_error', 'canceled', 'unknown'],
  'job.sentence.status': ['pending', 'running', 'done', 'needs_review'],
  'voices.status': ['processing', 'ready', 'failed'],
  'voices.language': ['auto', 'id', 'en'],
  'voices.error': ['no_clean_speech', 'unsupported_audio', 'internal_error', 'unknown'],
  'credits.kind': ['job', 'regenerate'],
  'credits.state': ['held', 'settled', 'refunded'],
};

describe('dictionaries', () => {
  it('ID and EN define exactly the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(id).sort());
  });

  it('have no empty strings, no em dash and no emoji', () => {
    for (const [lang, dict] of Object.entries({ id, en })) {
      for (const [key, value] of Object.entries(dict)) {
        expect(typeof value, `${lang}.${key}`).toBe('string');
        expect(value.trim(), `${lang}.${key} empty`).not.toBe('');
        expect(value.includes('—'), `${lang}.${key} has an em dash`).toBe(false);
        expect(/\p{Extended_Pictographic}/u.test(value), `${lang}.${key} has an emoji`).toBe(false);
      }
    }
  });

  it('use the same placeholders in both languages', () => {
    for (const key of Object.keys(id)) {
      expect(placeholders(en[key]), key).toEqual(placeholders(id[key]));
    }
  });

  it('pair every _one key with an _other key', () => {
    for (const key of Object.keys(id).filter((k) => k.endsWith('_one'))) {
      expect(Object.hasOwn(id, key.replace(/_one$/, '_other')), key).toBe(true);
    }
  });

  it('cover every runtime-built key family', () => {
    for (const [prefix, names] of Object.entries(DYNAMIC_FAMILIES)) {
      for (const name of names) expect(Object.hasOwn(id, `${prefix}.${name}`), `${prefix}.${name}`).toBe(true);
    }
  });

  it('define every literal key the source code uses', () => {
    const missing = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*'([a-z0-9_.]+)'/g)) if (!Object.hasOwn(id, m[1])) missing.push(`${file}: ${m[1]}`);
      for (const m of text.matchAll(/\btn\(\s*'([a-z0-9_.]+)'/g)) if (!Object.hasOwn(id, `${m[1]}_other`)) missing.push(`${file}: ${m[1]}_other`);
    }
    expect(missing).toEqual([]);
  });
});

describe('translate', () => {
  it('interpolates variables and leaves unknown ones visible', () => {
    expect(translate('en', 'voices.usage', { count: 2, limit: 3 })).toBe('2 of 3 voices used');
    expect(translate('en', 'voices.usage', { count: 2 })).toBe('2 of {limit} voices used');
  });
  it('does not treat {{style: ...}} markup as a placeholder', () => {
    expect(translate('en', 'tts.script_help')).toContain('{{style: cheerful, slightly faster}}');
  });
  it('falls back to Indonesian, then to the key', () => {
    expect(translate('xx', 'nav.voices')).toBe('Suara');
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });
  it('chooses singular and plural forms', () => {
    expect(translateCount('en', 'tts.price', 1, { credits: '1', rupiah: '100' })).toBe('About 1 credit (Rp100)');
    expect(translateCount('en', 'tts.price', 2, { credits: '2', rupiah: '200' })).toBe('About 2 credits (Rp200)');
    expect(translateCount('id', 'tts.price', 2, { credits: '2', rupiah: '200' })).toBe('Sekitar 2 kredit (Rp200)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/i18n`
Expected: FAIL, `Failed to resolve import "./en.js"`.

- [ ] **Step 3: Write `src/i18n/id.js`**

```js
export default {
  'nav.label': 'Navigasi utama',
  'nav.tts': 'Teks ke Suara',
  'nav.voices': 'Suara',
  'nav.history': 'Riwayat',
  'nav.credits': 'Kredit',
  'nav.skip': 'Lewati ke konten',

  'account.menu': 'Menu akun',
  'account.language': 'Bahasa',
  'account.logout': 'Keluar',
  'account.plan': 'Paket {plan}',
  'account.lang_error': 'Bahasa belum tersimpan di server. Coba lagi.',

  'plan.free': 'Free',
  'plan.pro': 'Pro',
  'plan.ultra': 'Ultra',
  'plan.sultan': 'Sultan',

  'banner.engine_restarting': 'Mesin suara sedang dimulai ulang, mohon tunggu. Pekerjaan baru tetap masuk antrean.',
  'banner.lqstudio_down': 'LQ-Studio sedang tidak dapat dihubungi. Voiceover baru belum bisa dibuat, tapi audio yang sudah jadi tetap bisa diputar dan diunduh.',

  'shell.error_title': 'Aplikasi belum bisa dimuat',

  'login.title': 'Masuk ke LQ TTS',
  'login.subtitle': 'Pakai akun LQ-Studio kamu. Kreditnya juga sama.',
  'login.identifier': 'Email atau username',
  'login.password': 'Kata sandi',
  'login.submit': 'Masuk',
  'login.submitting': 'Memeriksa...',
  'login.no_account': 'Belum punya akun?',
  'login.signup': 'Daftar di LQ-Studio',
  'login.twofa_title': 'Verifikasi dua langkah',
  'login.twofa_help': 'Masukkan 6 digit dari aplikasi authenticator, atau salah satu kode cadangan.',
  'login.code': 'Kode',
  'login.verify': 'Verifikasi',
  'login.back': 'Kembali',
  'login.verify_title': 'Selesaikan verifikasi akun',
  'login.verify_help': 'Selesaikan verifikasi email dan nomor HP kamu di LQ-Studio, lalu masuk lagi di sini.',
  'login.verify_cta': 'Buka LQ-Studio',
  'login.required': 'Isi kolom ini.',
  'login.code_format': 'Kode berisi 6 digit, atau kode cadangan 8 sampai 16 karakter.',

  'error.unauthorized': 'Sesi kamu sudah berakhir. Silakan masuk lagi.',
  'error.invalid_request': 'Permintaan tidak valid. Periksa isian lalu coba lagi.',
  'error.invalid_credentials': 'Email/username atau kata sandi salah.',
  'error.invalid_code': 'Kode salah atau sudah kedaluwarsa. Coba kode terbaru.',
  'error.rate_limited': 'Terlalu banyak percobaan. Coba lagi dalam {seconds} detik.',
  'error.rate_limited_later': 'Terlalu banyak percobaan. Coba lagi sebentar lagi.',
  'error.suspended': 'Akun ini dinonaktifkan. Hubungi dukungan LQ-Studio.',
  'error.needs_verification': 'Selesaikan verifikasi email dan nomor HP di LQ-Studio dulu.',
  'error.lqstudio_unavailable': 'LQ-Studio sedang tidak dapat dihubungi. Coba lagi sebentar lagi.',
  'error.engine_unavailable': 'Mesin suara sedang tidak dapat dihubungi. Coba lagi sebentar lagi.',
  'error.insufficient_credits': 'Kredit kamu tidak cukup. Top up dulu di LQ-Studio.',
  'error.voice_limit_reached': 'Batas suara paket kamu sudah penuh. Hapus satu suara atau upgrade paket.',
  'error.consent_required': 'Centang persetujuan dulu sebelum mengkloning suara.',
  'error.not_found': 'Data ini tidak ditemukan atau sudah dihapus.',
  'error.too_large': 'Terlalu besar: rekaman maksimal 95 MB (ekspor ulang sebagai MP3 atau M4A) dan naskah maksimal 20.000 karakter.',
  'error.unsupported_audio': 'Format audio tidak didukung. Pakai MP3, WAV, M4A, atau FLAC.',
  'error.not_regeneratable': 'Kalimat ini belum bisa dibuat ulang. Tunggu proses yang sedang berjalan selesai.',
  'error.voice_not_ready': 'Suara ini belum siap. Tunggu sampai statusnya Siap.',
  'error.network': 'Server tidak bisa dihubungi. Periksa koneksi internet kamu lalu coba lagi.',
  'error.generic': 'Ada yang tidak beres di server. Coba lagi.',

  'common.retry': 'Coba lagi',
  'common.cancel': 'Batal',
  'common.delete': 'Hapus',
  'common.download': 'Unduh',
  'common.topup': 'Top up kredit',
  'common.load_more': 'Muat lagi',

  'tts.title': 'Teks ke Suara',
  'tts.script': 'Naskah',
  'tts.script_help': 'Pisahkan paragraf dengan baris kosong. Beri gaya pada satu kalimat dengan menulis {{style: ceria, sedikit cepat}} di depannya.',
  'tts.script_placeholder': 'Tulis atau tempel naskah di sini.',
  'tts.chars': '{count} / {max} karakter',
  'tts.sentences_one': '{count} kalimat',
  'tts.sentences_other': '{count} kalimat',
  'tts.text_too_long': 'Naskah maksimal 20.000 karakter. Pendekkan atau bagi menjadi beberapa voiceover.',
  'tts.voice': 'Suara',
  'tts.voice_create': 'Kloning suara',
  'tts.empty_voices_title': 'Kloning suara dulu',
  'tts.empty_voices_body': 'Unggah rekaman berisi minimal 10 detik ucapan yang jernih. Setelah siap, suaranya muncul di sini.',
  'tts.settings': 'Pengaturan',
  'tts.speed': 'Kecepatan',
  'tts.speed_value': '{value}x',
  'tts.pause_sentence': 'Jeda antar kalimat',
  'tts.pause_paragraph': 'Jeda antar paragraf',
  'tts.seconds': '{value} dtk',
  'tts.formats': 'Format unduhan',
  'tts.formats_required': 'Pilih minimal satu format.',
  'tts.reset': 'Kembalikan bawaan',
  'tts.price_one': 'Sekitar {credits} kredit (Rp{rupiah})',
  'tts.price_other': 'Sekitar {credits} kredit (Rp{rupiah})',
  'tts.price_empty': 'Tulis naskah untuk melihat harganya.',
  'tts.balance_one': 'Saldo: {balance} kredit',
  'tts.balance_other': 'Saldo: {balance} kredit',
  'tts.balance_unknown': 'Saldo belum bisa dibaca dari LQ-Studio.',
  'tts.topup_needed': 'Kredit belum cukup untuk naskah ini.',
  'tts.lqstudio_down': 'Voiceover baru menunggu LQ-Studio bisa dihubungi lagi.',
  'tts.generate': 'Buat audio',
  'tts.generating': 'Mengirim...',

  'job.back': 'Kembali ke Teks ke Suara',
  'job.not_found_title': 'Voiceover tidak ditemukan',
  'job.not_found_body': 'Voiceover ini sudah dihapus atau bukan milik akun ini.',
  'job.chars_one': '{count} karakter',
  'job.chars_other': '{count} karakter',
  'job.credits_one': '{count} kredit',
  'job.credits_other': '{count} kredit',
  'job.progress_heading': 'Progres',
  'job.progress': '{done} dari {total} kalimat',
  'job.reconnecting': 'Menyambung ulang ke progres langsung...',
  'job.estimate': 'Perkiraan selesai dalam {time}',
  'job.live': 'Kalimat selesai satu per satu.',
  'job.cancel': 'Batalkan proses',
  'job.done_notice': 'Voiceover kamu sudah jadi. Dengarkan, perbaiki kalimat yang perlu, lalu unduh.',
  'job.needs_review_one': '{count} kalimat perlu didengar ulang.',
  'job.needs_review_other': '{count} kalimat perlu didengar ulang.',
  'job.output': 'Hasil',
  'job.revision': 'Revisi',
  'job.revision_n': 'Revisi {n}',
  'job.sentences': 'Kalimat',
  'job.delete': 'Hapus voiceover',
  'job.delete_confirm': 'Hapus voiceover ini beserta semua revisinya? Tindakan ini tidak bisa dibatalkan.',
  'job.status.queued': 'Dalam antrean',
  'job.status.running': 'Diproses',
  'job.status.done': 'Selesai',
  'job.status.failed': 'Gagal',
  'job.status.canceled': 'Dibatalkan',
  'job.failed.synthesis_failed': 'Mesin gagal membuat audio untuk naskah ini. Kredit sudah dikembalikan.',
  'job.failed.worker_crashed': 'Mesin berhenti di tengah proses tiga kali. Kredit sudah dikembalikan, silakan buat lagi.',
  'job.failed.internal_error': 'Terjadi kesalahan di mesin suara. Kredit sudah dikembalikan.',
  'job.failed.canceled': 'Proses dibatalkan. Kredit sudah dikembalikan.',
  'job.failed.unknown': 'Proses gagal. Kredit sudah dikembalikan.',
  'job.sentence.style_label': 'Gaya: {style}',
  'job.sentence.score': 'Akurasi {score}%',
  'job.sentence.play': 'Putar kalimat {n}',
  'job.sentence.edit': 'Ubah',
  'job.sentence.text': 'Teks kalimat',
  'job.sentence.one_sentence': 'Isi tepat satu kalimat.',
  'job.sentence.style': 'Gaya (opsional)',
  'job.sentence.style_placeholder': 'mis. ceria, sedikit lebih cepat',
  'job.sentence.regenerate': 'Buat ulang',
  'job.sentence.regenerate_price_one': 'Biaya {count} kredit',
  'job.sentence.regenerate_price_other': 'Biaya {count} kredit',
  'job.sentence.status.pending': 'Menunggu',
  'job.sentence.status.running': 'Diproses',
  'job.sentence.status.done': 'Selesai',
  'job.sentence.status.needs_review': 'Perlu didengar',

  'voices.title': 'Suara',
  'voices.usage': '{count} dari {limit} suara terpakai',
  'voices.clone': 'Kloning suara',
  'voices.limit': 'Batas {limit} suara untuk paket kamu sudah penuh. Hapus satu suara atau upgrade paket di LQ-Studio.',
  'voices.upgrade': 'Upgrade paket',
  'voices.empty_title': 'Belum ada suara',
  'voices.empty_body': 'Kloning suara dari rekaman MP3, WAV, M4A, atau FLAC. Satu rekaman jernih sudah cukup.',
  'voices.status.processing': 'Diproses',
  'voices.status.ready': 'Siap',
  'voices.status.failed': 'Gagal',
  'voices.language.auto': 'Otomatis',
  'voices.language.id': 'Indonesia',
  'voices.language.en': 'Inggris',
  'voices.ref_seconds': 'Klip {seconds} dtk',
  'voices.preview': 'Dengarkan contoh {name}',
  'voices.delete': 'Hapus',
  'voices.delete_named': 'Hapus suara {name}',
  'voices.delete_confirm': 'Hapus {name}? Semua voiceover yang memakai suara ini ikut terhapus.',
  'voices.error.no_clean_speech': 'Rekaman perlu minimal 8 detik ucapan jernih tanpa musik atau jeda panjang.',
  'voices.error.unsupported_audio': 'Berkas audio tidak bisa dibaca. Coba ekspor ulang sebagai MP3 atau WAV.',
  'voices.error.internal_error': 'Mesin gagal memproses rekaman ini. Coba unggah lagi.',
  'voices.error.unknown': 'Suara gagal diproses. Coba unggah lagi.',
  'voices.form.title': 'Kloning suara baru',
  'voices.form.audio': 'Rekaman',
  'voices.form.audio_help': 'MP3, WAV, M4A, atau FLAC, maksimal 95 MB. Rekaman 10 sampai 20 detik ucapan jernih memberi hasil terbaik.',
  'voices.form.audio_required': 'Pilih berkas rekaman.',
  'voices.form.audio_type': 'Format ini tidak didukung. Pakai MP3, WAV, M4A, atau FLAC.',
  'voices.form.audio_empty': 'Berkas ini kosong.',
  'voices.form.audio_size': 'Berkas lebih dari 95 MB. Ekspor ulang rekamannya sebagai MP3 atau M4A supaya lebih kecil.',
  'voices.form.name': 'Nama suara',
  'voices.form.name_required': 'Beri nama suara ini.',
  'voices.form.language': 'Bahasa',
  'voices.form.transcript': 'Transkrip (opsional)',
  'voices.form.transcript_help': 'Isi bila rekaman paling lama 20 detik dan kamu tahu persis ucapannya. Bila kosong, transkrip dibuat otomatis.',
  'voices.form.consent': 'Saya pemilik suara ini atau punya izin tertulis dari pemiliknya untuk mengkloningnya, dan saya tidak akan memakainya untuk menipu atau meniru orang tanpa izin.',
  'voices.form.submit': 'Mulai kloning',
  'voices.form.uploading': 'Mengunggah {percent}%',
  'voices.form.upload_progress': 'Progres unggahan',
  'voices.form.success': 'Suara sedang diproses. Biasanya selesai dalam satu menit.',

  'history.title': 'Riwayat',
  'history.empty_title': 'Belum ada voiceover',
  'history.empty_body': 'Voiceover yang kamu buat akan tersimpan di sini, lengkap dengan revisi dan unduhannya.',
  'history.empty_cta': 'Buat voiceover pertama',
  'history.col.voiceover': 'Voiceover',
  'history.col.status': 'Status',
  'history.col.chars': 'Karakter',
  'history.col.credits': 'Kredit',
  'history.col.duration': 'Durasi',
  'history.col.actions': 'Aksi',
  'history.voice_deleted': 'Suara terhapus',
  'history.download_named': 'Unduh {title}',
  'history.delete_named': 'Hapus {title}',

  'credits.title': 'Kredit',
  'credits.shared': 'Kredit dipakai bersama dengan LQ-Studio.',
  'credits.balance': 'Saldo LQ-Studio',
  'credits.balance_value_one': '{count} kredit',
  'credits.balance_value_other': '{count} kredit',
  'credits.balance_unknown': 'Belum terbaca',
  'credits.rate': '1 kredit = Rp100 · 10 kredit per 1.000 karakter',
  'credits.usage': 'Pemakaian TTS',
  'credits.empty_title': 'Belum ada pemakaian',
  'credits.empty_body': 'Setiap voiceover dan kalimat yang dibuat ulang tercatat di sini.',
  'credits.col.date': 'Tanggal',
  'credits.col.voiceover': 'Voiceover',
  'credits.col.kind': 'Jenis',
  'credits.col.chars': 'Karakter',
  'credits.col.credits': 'Kredit',
  'credits.col.state': 'Status',
  'credits.kind.job': 'Voiceover',
  'credits.kind.regenerate': 'Buat ulang kalimat',
  'credits.state.held': 'Ditahan',
  'credits.state.settled': 'Terpotong',
  'credits.state.refunded': 'Dikembalikan',

  'notfound.title': 'Halaman tidak ditemukan',
  'notfound.body': 'Alamat ini tidak ada di LQ TTS.',
  'notfound.home': 'Ke Teks ke Suara',
};
```

- [ ] **Step 4: Write `src/i18n/en.js`**

```js
export default {
  'nav.label': 'Main navigation',
  'nav.tts': 'Text to Speech',
  'nav.voices': 'Voices',
  'nav.history': 'History',
  'nav.credits': 'Credits',
  'nav.skip': 'Skip to content',

  'account.menu': 'Account menu',
  'account.language': 'Language',
  'account.logout': 'Log out',
  'account.plan': '{plan} plan',
  'account.lang_error': 'The language was not saved on the server. Try again.',

  'plan.free': 'Free',
  'plan.pro': 'Pro',
  'plan.ultra': 'Ultra',
  'plan.sultan': 'Sultan',

  'banner.engine_restarting': 'The voice engine is restarting, please wait. New jobs still queue.',
  'banner.lqstudio_down': 'LQ-Studio is temporarily unavailable. New voiceovers are paused, but finished audio still plays and downloads.',

  'shell.error_title': 'The app could not load',

  'login.title': 'Log in to LQ TTS',
  'login.subtitle': 'Use your LQ-Studio account. Your credits are shared too.',
  'login.identifier': 'Email or username',
  'login.password': 'Password',
  'login.submit': 'Log in',
  'login.submitting': 'Checking...',
  'login.no_account': 'No account?',
  'login.signup': 'Sign up on LQ-Studio',
  'login.twofa_title': 'Two-step verification',
  'login.twofa_help': 'Enter the 6-digit code from your authenticator app, or one of your backup codes.',
  'login.code': 'Code',
  'login.verify': 'Verify',
  'login.back': 'Back',
  'login.verify_title': 'Finish verifying your account',
  'login.verify_help': 'Finish verifying your email and phone on LQ-Studio, then log in here again.',
  'login.verify_cta': 'Open LQ-Studio',
  'login.required': 'Fill in this field.',
  'login.code_format': 'Codes are 6 digits, or a backup code of 8 to 16 characters.',

  'error.unauthorized': 'Your session has ended. Please log in again.',
  'error.invalid_request': 'That request was not valid. Check the form and try again.',
  'error.invalid_credentials': 'Wrong email/username or password.',
  'error.invalid_code': 'That code is wrong or expired. Try the latest code.',
  'error.rate_limited': 'Too many attempts. Try again in {seconds} seconds.',
  'error.rate_limited_later': 'Too many attempts. Try again in a moment.',
  'error.suspended': 'This account is suspended. Contact LQ-Studio support.',
  'error.needs_verification': 'Finish verifying your email and phone on LQ-Studio first.',
  'error.lqstudio_unavailable': 'LQ-Studio is temporarily unavailable. Try again shortly.',
  'error.engine_unavailable': 'The voice engine is unreachable right now. Try again shortly.',
  'error.insufficient_credits': 'Not enough credits. Top up on LQ-Studio first.',
  'error.voice_limit_reached': 'Your plan\'s voice limit is full. Delete a voice or upgrade your plan.',
  'error.consent_required': 'Tick the consent box before cloning a voice.',
  'error.not_found': 'This item does not exist or was deleted.',
  'error.too_large': 'Too large: recordings up to 95 MB (export as MP3 or M4A) and scripts up to 20,000 characters.',
  'error.unsupported_audio': 'That audio format is not supported. Use MP3, WAV, M4A or FLAC.',
  'error.not_regeneratable': 'This sentence cannot be regenerated yet. Wait for the current run to finish.',
  'error.voice_not_ready': 'This voice is not ready yet. Wait until it shows Ready.',
  'error.network': 'Cannot reach the server. Check your connection and try again.',
  'error.generic': 'Something went wrong on our side. Please try again.',

  'common.retry': 'Try again',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.download': 'Download',
  'common.topup': 'Top up credits',
  'common.load_more': 'Load more',

  'tts.title': 'Text to Speech',
  'tts.script': 'Script',
  'tts.script_help': 'Separate paragraphs with a blank line. Style one sentence by writing {{style: cheerful, slightly faster}} before it.',
  'tts.script_placeholder': 'Write or paste your script here.',
  'tts.chars': '{count} / {max} characters',
  'tts.sentences_one': '{count} sentence',
  'tts.sentences_other': '{count} sentences',
  'tts.text_too_long': 'Scripts are limited to 20,000 characters. Shorten it or split it into several voiceovers.',
  'tts.voice': 'Voice',
  'tts.voice_create': 'Clone a voice',
  'tts.empty_voices_title': 'Clone a voice first',
  'tts.empty_voices_body': 'Upload a recording with at least 10 seconds of clear speech. Once it is ready it shows up here.',
  'tts.settings': 'Settings',
  'tts.speed': 'Speed',
  'tts.speed_value': '{value}x',
  'tts.pause_sentence': 'Pause between sentences',
  'tts.pause_paragraph': 'Pause between paragraphs',
  'tts.seconds': '{value} s',
  'tts.formats': 'Download formats',
  'tts.formats_required': 'Pick at least one format.',
  'tts.reset': 'Reset to defaults',
  'tts.price_one': 'About {credits} credit (Rp{rupiah})',
  'tts.price_other': 'About {credits} credits (Rp{rupiah})',
  'tts.price_empty': 'Write a script to see its price.',
  'tts.balance_one': 'Balance: {balance} credit',
  'tts.balance_other': 'Balance: {balance} credits',
  'tts.balance_unknown': 'Balance could not be read from LQ-Studio.',
  'tts.topup_needed': 'Not enough credits for this script.',
  'tts.lqstudio_down': 'New voiceovers wait until LQ-Studio is reachable again.',
  'tts.generate': 'Generate',
  'tts.generating': 'Sending...',

  'job.back': 'Back to Text to Speech',
  'job.not_found_title': 'Voiceover not found',
  'job.not_found_body': 'This voiceover was deleted or belongs to another account.',
  'job.chars_one': '{count} character',
  'job.chars_other': '{count} characters',
  'job.credits_one': '{count} credit',
  'job.credits_other': '{count} credits',
  'job.progress_heading': 'Progress',
  'job.progress': '{done} of {total} sentences',
  'job.reconnecting': 'Reconnecting to live progress...',
  'job.estimate': 'Estimated to finish in {time}',
  'job.live': 'Sentences finish one by one.',
  'job.cancel': 'Cancel job',
  'job.done_notice': 'Your voiceover is ready. Listen, fix any sentence that needs it, then download.',
  'job.needs_review_one': '{count} sentence needs a listen.',
  'job.needs_review_other': '{count} sentences need a listen.',
  'job.output': 'Output',
  'job.revision': 'Revision',
  'job.revision_n': 'Revision {n}',
  'job.sentences': 'Sentences',
  'job.delete': 'Delete voiceover',
  'job.delete_confirm': 'Delete this voiceover and all its revisions? This cannot be undone.',
  'job.status.queued': 'Queued',
  'job.status.running': 'Generating',
  'job.status.done': 'Done',
  'job.status.failed': 'Failed',
  'job.status.canceled': 'Canceled',
  'job.failed.synthesis_failed': 'The engine could not generate this script. Your credits were refunded.',
  'job.failed.worker_crashed': 'The engine stopped mid-run three times. Your credits were refunded, please try again.',
  'job.failed.internal_error': 'The voice engine hit an error. Your credits were refunded.',
  'job.failed.canceled': 'The job was canceled. Your credits were refunded.',
  'job.failed.unknown': 'The job failed. Your credits were refunded.',
  'job.sentence.style_label': 'Style: {style}',
  'job.sentence.score': 'Accuracy {score}%',
  'job.sentence.play': 'Play sentence {n}',
  'job.sentence.edit': 'Edit',
  'job.sentence.text': 'Sentence text',
  'job.sentence.one_sentence': 'Enter exactly one sentence.',
  'job.sentence.style': 'Style (optional)',
  'job.sentence.style_placeholder': 'e.g. cheerful, slightly faster',
  'job.sentence.regenerate': 'Regenerate',
  'job.sentence.regenerate_price_one': 'Costs {count} credit',
  'job.sentence.regenerate_price_other': 'Costs {count} credits',
  'job.sentence.status.pending': 'Waiting',
  'job.sentence.status.running': 'Generating',
  'job.sentence.status.done': 'Done',
  'job.sentence.status.needs_review': 'Needs a listen',

  'voices.title': 'Voices',
  'voices.usage': '{count} of {limit} voices used',
  'voices.clone': 'Clone a voice',
  'voices.limit': 'Your plan\'s limit of {limit} voices is full. Delete a voice or upgrade your plan on LQ-Studio.',
  'voices.upgrade': 'Upgrade plan',
  'voices.empty_title': 'No voices yet',
  'voices.empty_body': 'Clone a voice from an MP3, WAV, M4A or FLAC recording. One clear recording is enough.',
  'voices.status.processing': 'Processing',
  'voices.status.ready': 'Ready',
  'voices.status.failed': 'Failed',
  'voices.language.auto': 'Auto',
  'voices.language.id': 'Indonesian',
  'voices.language.en': 'English',
  'voices.ref_seconds': '{seconds} s clip',
  'voices.preview': 'Preview {name}',
  'voices.delete': 'Delete',
  'voices.delete_named': 'Delete voice {name}',
  'voices.delete_confirm': 'Delete {name}? Every voiceover made with this voice is deleted too.',
  'voices.error.no_clean_speech': 'The recording needs at least 8 seconds of clear speech without music or long gaps.',
  'voices.error.unsupported_audio': 'The audio file could not be read. Try exporting it again as MP3 or WAV.',
  'voices.error.internal_error': 'The engine could not process this recording. Try uploading it again.',
  'voices.error.unknown': 'The voice could not be processed. Try uploading it again.',
  'voices.form.title': 'Clone a new voice',
  'voices.form.audio': 'Recording',
  'voices.form.audio_help': 'MP3, WAV, M4A or FLAC, up to 95 MB. 10 to 20 seconds of clear speech gives the best result.',
  'voices.form.audio_required': 'Choose a recording file.',
  'voices.form.audio_type': 'That format is not supported. Use MP3, WAV, M4A or FLAC.',
  'voices.form.audio_empty': 'This file is empty.',
  'voices.form.audio_size': 'The file is larger than 95 MB. Export the recording as MP3 or M4A to make it smaller.',
  'voices.form.name': 'Voice name',
  'voices.form.name_required': 'Give this voice a name.',
  'voices.form.language': 'Language',
  'voices.form.transcript': 'Transcript (optional)',
  'voices.form.transcript_help': 'Fill this in when the recording is 20 seconds or shorter and you know exactly what is said. Left empty, it is transcribed automatically.',
  'voices.form.consent': 'I own this voice or have written permission from its owner to clone it, and I will not use it to deceive or impersonate anyone without consent.',
  'voices.form.submit': 'Start cloning',
  'voices.form.uploading': 'Uploading {percent}%',
  'voices.form.upload_progress': 'Upload progress',
  'voices.form.success': 'Your voice is processing. It usually takes about a minute.',

  'history.title': 'History',
  'history.empty_title': 'No voiceovers yet',
  'history.empty_body': 'Every voiceover you make is kept here with its revisions and downloads.',
  'history.empty_cta': 'Make your first voiceover',
  'history.col.voiceover': 'Voiceover',
  'history.col.status': 'Status',
  'history.col.chars': 'Characters',
  'history.col.credits': 'Credits',
  'history.col.duration': 'Duration',
  'history.col.actions': 'Actions',
  'history.voice_deleted': 'Deleted voice',
  'history.download_named': 'Download {title}',
  'history.delete_named': 'Delete {title}',

  'credits.title': 'Credits',
  'credits.shared': 'Credits are shared with LQ-Studio.',
  'credits.balance': 'LQ-Studio balance',
  'credits.balance_value_one': '{count} credit',
  'credits.balance_value_other': '{count} credits',
  'credits.balance_unknown': 'Not available',
  'credits.rate': '1 credit = Rp100 · 10 credits per 1,000 characters',
  'credits.usage': 'TTS usage',
  'credits.empty_title': 'No usage yet',
  'credits.empty_body': 'Every voiceover and regenerated sentence is listed here.',
  'credits.col.date': 'Date',
  'credits.col.voiceover': 'Voiceover',
  'credits.col.kind': 'Type',
  'credits.col.chars': 'Characters',
  'credits.col.credits': 'Credits',
  'credits.col.state': 'Status',
  'credits.kind.job': 'Voiceover',
  'credits.kind.regenerate': 'Sentence regenerate',
  'credits.state.held': 'On hold',
  'credits.state.settled': 'Charged',
  'credits.state.refunded': 'Refunded',

  'notfound.title': 'Page not found',
  'notfound.body': 'This address does not exist in LQ TTS.',
  'notfound.home': 'Go to Text to Speech',
};
```

- [ ] **Step 5: Write `src/i18n/index.jsx`**

```jsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from './en.js';
import id from './id.js';

export const DICTS = { id, en };
export const LANG_OPTIONS = [
  { value: 'id', label: 'ID', ariaLabel: 'Bahasa Indonesia' },
  { value: 'en', label: 'EN', ariaLabel: 'English' },
];
const STORAGE_KEY = 'lqtts_lang';

export function hasKey(key) {
  return Object.hasOwn(DICTS.id, key);
}

export function translate(lang, key, vars) {
  const dict = DICTS[lang] ?? DICTS.id;
  const template = dict[key] ?? DICTS.id[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : match));
}

export function translateCount(lang, key, count, vars = {}) {
  const variant = count === 1 && hasKey(`${key}_one`) ? `${key}_one` : `${key}_other`;
  return translate(lang, variant, { count, ...vars });
}

function storedLang() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'id' || value === 'en' ? value : null;
  } catch {
    return null;
  }
}

const I18nContext = createContext(null);

export function I18nProvider({ children, initialLang }) {
  const [lang, setLangState] = useState(() => initialLang ?? storedLang() ?? 'id');

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next) => {
    if (next !== 'id' && next !== 'en') return;
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode: the choice still lives in memory and on the server session.
    }
  }, []);

  const value = useMemo(() => ({
    lang,
    setLang,
    t: (key, vars) => translate(lang, key, vars),
    tn: (key, count, vars) => translateCount(lang, key, count, vars),
  }), [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/i18n`
Expected: PASS, 10 tests. (The "every literal key the source code uses" test grows stricter as pages land; it must stay green after every later task.)

- [ ] **Step 7: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/client/src/i18n
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: complete ID and EN dictionaries with i18n provider"
```

---

### Task 3: Typed API client (contract C2) and error mapping

**Files:**
- Create: `web/client/src/lib/types.js`, `web/client/src/lib/api.js`, `web/client/src/lib/errors.js`
- Test: `web/client/src/lib/api.test.js`, `web/client/src/lib/errors.test.js`

**Interfaces:**
- Consumes: `hasKey`, `translate` (Task 2).
- Produces (`api.js`): `class ApiError extends Error {status:number, code:string, retryAfter:number|null}`; `request(path, {method?, body?, signal?})` (prefixes `/api`); `toApiError(res:Response):Promise<ApiError>`; `onUnauthorized(fn) → unsubscribe`; `api.{login(identifier,password), verify2fa(challenge,code), logout(), me(), setLang(lang), health(), voices(), deleteVoice(id), estimate(text, signal?), createJob(voiceId,text,settings), jobs({limit?,before?}), job(id), sentences(id), regenerate(id, idx, {text?,style?}), cancelJob(id), deleteJob(id), credits()}`; `buildVoiceForm({file,name,language,transcript,consent}) → FormData` (audio last); `createVoice(fields, {onProgress?, signal?}) → Promise<{id,status}>` (XHR with upload progress); `urls.{voicePreview(id), sentenceAudio(jobId, idx, version), file(jobId, name, revision?), events(jobId)}`; `openJobEvents(jobId, {onEvent, onOpen?, onError?}) → close()` where `onEvent` receives `{type:'sentence_done', idx, status, score, revision} | {type:'job_done', revision} | {type:'job_failed', status, errorCode}`.
- Produces (`errors.js`): `errorText(t, err)`, `voiceErrorText(t, code)`, `jobFailureText(t, status, code)`.

- [ ] **Step 1: Write the failing tests**

`src/lib/api.test.js`:
```js
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, buildVoiceForm, onUnauthorized, urls } from './api.js';

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const html = (status) => new Response('<html>Cloudflare</html>', { status, headers: { 'Content-Type': 'text/html' } });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('error mapping', () => {
  it('turns {error:{code,message}} into an ApiError with that code', async () => {
    fetch.mockResolvedValue(json(402, { error: { code: 'insufficient_credits', message: 'need 12, have 3' } }));
    await expect(api.createJob('v1', 'Halo.', {})).rejects.toMatchObject({
      name: 'ApiError', status: 402, code: 'insufficient_credits', message: 'need 12, have 3',
    });
  });

  it('falls back by status when the body is not JSON', async () => {
    fetch.mockResolvedValueOnce(html(413));
    await expect(api.voices()).rejects.toMatchObject({ code: 'too_large' });
    fetch.mockResolvedValueOnce(html(502));
    await expect(api.voices()).rejects.toMatchObject({ code: 'network' });
    fetch.mockResolvedValueOnce(html(500));
    await expect(api.voices()).rejects.toMatchObject({ code: 'generic' });
  });

  it('reads retryAfter from the body first, then from Retry-After', async () => {
    fetch.mockResolvedValueOnce(json(429, { error: { code: 'rate_limited', retryAfter: 30 } }));
    await expect(api.login('ana', 'x')).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 30 });
    fetch.mockResolvedValueOnce(json(429, { error: { code: 'rate_limited' } }, { 'Retry-After': '45' }));
    await expect(api.login('ana', 'x')).rejects.toMatchObject({ retryAfter: 45 });
  });

  it('wraps a rejected fetch as a network error', async () => {
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await api.me().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('network');
    expect(err.status).toBe(0);
  });

  it('notifies the session only for an expired session, not for a wrong password', async () => {
    const seen = vi.fn();
    const off = onUnauthorized(seen);
    fetch.mockResolvedValueOnce(json(401, { error: { code: 'invalid_credentials' } }));
    await api.login('ana', 'bad').catch(() => {});
    expect(seen).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(json(401, { error: { code: 'unauthorized' } }));
    await api.me().catch(() => {});
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('requests', () => {
  it('sends the CSRF header on mutating requests only', async () => {
    fetch.mockResolvedValue(json(200, { ok: true }));
    await api.voices();
    expect(fetch.mock.calls[0][1].headers['X-Requested-With']).toBeUndefined();
    await api.setLang('en');
    const [url, init] = fetch.mock.calls[1];
    expect(url).toBe('/api/me');
    expect(init.method).toBe('PATCH');
    expect(init.headers['X-Requested-With']).toBe('lq-tts');
    expect(JSON.parse(init.body)).toEqual({ lang: 'en' });
    expect(init.credentials).toBe('same-origin');
  });

  it('returns null for 204', async () => {
    fetch.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.deleteJob('j1')).resolves.toBeNull();
  });

  it('builds the history query with limit and before', async () => {
    fetch.mockResolvedValue(json(200, { items: [], nextBefore: null }));
    await api.jobs({ limit: 20, before: '2026-10-03T10:00:00.000Z' });
    expect(fetch.mock.calls[0][0]).toBe('/api/jobs?limit=20&before=2026-10-03T10%3A00%3A00.000Z');
  });

  it('omits unchanged fields from a regenerate body', async () => {
    fetch.mockResolvedValue(json(202, { revision: 2, credits: 1 }));
    await api.regenerate('j1', 3, { text: 'Kalimat baru.' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/jobs/j1/sentences/3/regenerate');
    expect(JSON.parse(init.body)).toEqual({ text: 'Kalimat baru.' });
  });
});

describe('buildVoiceForm', () => {
  it('appends text fields first and the audio file last', () => {
    const file = new File(['RIFF'], 'pandji.wav', { type: 'audio/wav' });
    const form = buildVoiceForm({ file, name: 'Pandji', language: 'id', transcript: 'Halo semua.', consent: true });
    expect([...form.keys()]).toEqual(['name', 'language', 'transcript', 'consent', 'audio']);
    expect(form.get('consent')).toBe('true');
  });
  it('skips an empty transcript', () => {
    const file = new File(['RIFF'], 'a.wav', { type: 'audio/wav' });
    const form = buildVoiceForm({ file, name: 'A', language: 'auto', transcript: '', consent: true });
    expect([...form.keys()]).toEqual(['name', 'language', 'consent', 'audio']);
  });
});

describe('urls', () => {
  it('encodes ids and carries revision or cache version', () => {
    expect(urls.file('j/1', 'final.mp3', 2)).toBe('/api/jobs/j%2F1/files/final.mp3?revision=2');
    expect(urls.file('j1', 'subs.srt')).toBe('/api/jobs/j1/files/subs.srt');
    expect(urls.sentenceAudio('j1', 4, 3)).toBe('/api/jobs/j1/sentences/4/audio?v=3');
    expect(urls.voicePreview('v1')).toBe('/api/voices/v1/preview');
    expect(urls.events('j1')).toBe('/api/jobs/j1/events');
  });
});
```

`src/lib/errors.test.js`:
```js
import { describe, expect, it } from 'vitest';
import { translate } from '../i18n/index.jsx';
import { errorText, jobFailureText, voiceErrorText } from './errors.js';

const t = (key, vars) => translate('en', key, vars);

describe('errorText', () => {
  it('uses the dictionary text for a known code', () => {
    expect(errorText(t, { code: 'invalid_credentials' })).toBe('Wrong email/username or password.');
  });
  it('includes the wait time for rate limits when known', () => {
    expect(errorText(t, { code: 'rate_limited', retryAfter: 30 })).toBe('Too many attempts. Try again in 30 seconds.');
    expect(errorText(t, { code: 'rate_limited', retryAfter: null })).toBe('Too many attempts. Try again in a moment.');
  });
  it('falls back to the generic text for unknown codes and non-API errors', () => {
    expect(errorText(t, { code: 'teapot' })).toBe('Something went wrong on our side. Please try again.');
    expect(errorText(t, new Error('boom'))).toBe('Something went wrong on our side. Please try again.');
  });
});

describe('voice and job failure texts', () => {
  it('explains engine voice error codes', () => {
    expect(voiceErrorText(t, 'no_clean_speech')).toMatch(/at least 8 seconds of clear speech/);
    expect(voiceErrorText(t, 'something_new')).toBe('The voice could not be processed. Try uploading it again.');
  });
  it('explains failed and canceled jobs with the refund', () => {
    expect(jobFailureText(t, 'failed', 'worker_crashed')).toMatch(/refunded/);
    expect(jobFailureText(t, 'canceled', null)).toBe('The job was canceled. Your credits were refunded.');
    expect(jobFailureText(t, 'failed', null)).toBe('The job failed. Your credits were refunded.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/api.test.js src/lib/errors.test.js`
Expected: FAIL, `Failed to resolve import "./api.js"` / `"./errors.js"`.

- [ ] **Step 3: Write `src/lib/types.js` (contract C2 shapes)**

```js
// JSDoc shapes of contract C2 (LQ-TTS browser API). Imported only for editor type checking.

/** @typedef {'id'|'en'} Lang */
/** @typedef {{id:string, name:string, email:string, plan:string, paid:boolean, lang:Lang, balance:number|null, voiceLimit:number, voiceCount:number|null, topupUrl:string}} Me */
/** @typedef {{status:'ok', user:Me} | {status:'need_2fa', challenge:string} | {status:'needs_verification', verifyUrl:string}} LoginResult */
/** @typedef {{engine:'ok'|'restarting', lqstudio:'ok'|'down'}} Health */
/** @typedef {{id:string, name:string, language:string, status:'processing'|'ready'|'failed', errorCode:string|null, refSeconds:number|null, createdAt:string, previewUrl:string}} Voice */
/** @typedef {{chars:number, credits:number, rupiah:number, balance:number|null, sentences:number}} Estimate */
/** @typedef {{speed:number, pause_sentence_s:number, pause_paragraph_s:number, formats:Array<'mp3'|'wav'|'srt'|'vtt'>}} JobSettings */
/** @typedef {{id:string, title:string, voiceId:string, voiceName:string|null, status:'queued'|'running'|'done'|'failed'|'canceled', chars:number, credits:number, audioSeconds:number|null, revision:number, createdAt:string, finishedAt:string|null}} JobSummary */
/** @typedef {JobSummary & {progress:{done:number,total:number}, needsReview:number, settings:JobSettings, files:Record<string,string>, revisions:number[], errorCode?:string|null}} JobDetail */
/** @typedef {{idx:number, paragraphIdx:number, text:string, style:string|null, status:'pending'|'running'|'done'|'needs_review', score:number|null, durationS:number|null, startS:number|null, endS:number|null, audioUrl:string|null}} Sentence */
/** @typedef {{id:string, jobId:string|null, title:string, kind:'job'|'regenerate', chars:number, credits:number, state:'held'|'settled'|'refunded', createdAt:string}} UsageRow */
/** @typedef {{balance:number|null, topupUrl:string, usage:UsageRow[]}} Credits */

export {};
```

- [ ] **Step 4: Write `src/lib/api.js`**

```js
// @ts-check
/** @typedef {import('./types.js').Me} Me */
/** @typedef {import('./types.js').LoginResult} LoginResult */
/** @typedef {import('./types.js').Health} Health */
/** @typedef {import('./types.js').Voice} Voice */
/** @typedef {import('./types.js').Estimate} Estimate */
/** @typedef {import('./types.js').JobSettings} JobSettings */
/** @typedef {import('./types.js').JobSummary} JobSummary */
/** @typedef {import('./types.js').JobDetail} JobDetail */
/** @typedef {import('./types.js').Sentence} Sentence */
/** @typedef {import('./types.js').Credits} Credits */

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status, 0 when the server was unreachable
   * @param {string} code contract C2 error code, or 'network' / 'generic'
   * @param {string} message server message (diagnostic only; the UI shows localized text)
   * @param {{retryAfter?: number|null}} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = extra.retryAfter ?? null;
  }
}

/** @type {Record<number, string>} */
const STATUS_FALLBACK = {
  400: 'invalid_request',
  401: 'unauthorized',
  402: 'insufficient_credits',
  404: 'not_found',
  413: 'too_large',
  415: 'unsupported_audio',
  429: 'rate_limited',
};

/** @type {((err: ApiError) => void) | null} */
let unauthorizedHandler = null;

/** @param {(err: ApiError) => void} fn */
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
  return () => {
    if (unauthorizedHandler === fn) unauthorizedHandler = null;
  };
}

/** @param {ApiError} err */
function notify(err) {
  if (err.code === 'unauthorized' && unauthorizedHandler) unauthorizedHandler(err);
  return err;
}

/** @param {Response} res @returns {Promise<ApiError>} */
export async function toApiError(res) {
  /** @type {any} */
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const e = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  const fallback = STATUS_FALLBACK[res.status] ?? (res.status >= 502 && res.status <= 504 ? 'network' : 'generic');
  const code = typeof e?.code === 'string' ? e.code : fallback;
  const header = Number(res.headers.get('Retry-After'));
  const retryAfter = Number.isFinite(e?.retryAfter) ? e.retryAfter : Number.isFinite(header) && header > 0 ? header : null;
  return new ApiError(res.status, code, typeof e?.message === 'string' ? e.message : '', { retryAfter });
}

/**
 * @param {string} path path below /api
 * @param {{method?: string, body?: unknown, signal?: AbortSignal}} [options]
 * @returns {Promise<any>}
 */
export async function request(path, { method = 'GET', body, signal } = {}) {
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') headers['X-Requested-With'] = 'lq-tts';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw notify(await toApiError(res));
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const enc = encodeURIComponent;

export const api = {
  /** @returns {Promise<LoginResult>} */
  login: (identifier, password) => request('/auth/login', { method: 'POST', body: { identifier, password } }),
  /** @returns {Promise<{status:'ok', user: Me}>} */
  verify2fa: (challenge, code) => request('/auth/2fa', { method: 'POST', body: { challenge, code } }),
  /** @returns {Promise<null>} */
  logout: () => request('/auth/logout', { method: 'POST' }),
  /** @returns {Promise<Me>} */
  me: () => request('/me'),
  /** @param {'id'|'en'} lang @returns {Promise<Me>} */
  setLang: (lang) => request('/me', { method: 'PATCH', body: { lang } }),
  /** @returns {Promise<Health>} */
  health: () => request('/health'),
  /** @returns {Promise<Voice[]>} */
  voices: () => request('/voices'),
  /** @param {string} id @returns {Promise<null>} */
  deleteVoice: (id) => request(`/voices/${enc(id)}`, { method: 'DELETE' }),
  /** @param {string} text @param {AbortSignal} [signal] @returns {Promise<Estimate>} */
  estimate: (text, signal) => request('/jobs/estimate', { method: 'POST', body: { text }, signal }),
  /** @param {string} voiceId @param {string} text @param {JobSettings} settings @returns {Promise<{id:string, credits:number, estimatedSeconds:number}>} */
  createJob: (voiceId, text, settings) => request('/jobs', { method: 'POST', body: { voiceId, text, settings } }),
  /** @param {{limit?: number, before?: string|null}} [query] @returns {Promise<{items: JobSummary[], nextBefore: string|null}>} */
  jobs: ({ limit = 20, before = null } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);
    return request(`/jobs?${params}`);
  },
  /** @param {string} id @returns {Promise<JobDetail>} */
  job: (id) => request(`/jobs/${enc(id)}`),
  /** @param {string} id @returns {Promise<Sentence[]>} */
  sentences: (id) => request(`/jobs/${enc(id)}/sentences`),
  /** @param {string} id @param {number} idx @param {{text?: string, style?: string}} changes @returns {Promise<{revision:number, credits:number}>} */
  regenerate: (id, idx, changes) => request(`/jobs/${enc(id)}/sentences/${idx}/regenerate`, { method: 'POST', body: changes }),
  /** @param {string} id @returns {Promise<null>} */
  cancelJob: (id) => request(`/jobs/${enc(id)}/cancel`, { method: 'POST' }),
  /** @param {string} id @returns {Promise<null>} */
  deleteJob: (id) => request(`/jobs/${enc(id)}`, { method: 'DELETE' }),
  /** @returns {Promise<Credits>} */
  credits: () => request('/credits'),
};

/**
 * Contract C2 + plan 2B: text fields first, `audio` last (the server checks consent, name and limit before the file part).
 * @param {{file: File, name: string, language: string, transcript: string, consent: boolean}} fields
 */
export function buildVoiceForm({ file, name, language, transcript, consent }) {
  const form = new FormData();
  form.append('name', name);
  form.append('language', language);
  if (transcript) form.append('transcript', transcript);
  form.append('consent', consent ? 'true' : 'false');
  form.append('audio', file, file.name);
  return form;
}

/**
 * Upload with real progress (fetch cannot report upload progress).
 * @param {{file: File, name: string, language: string, transcript: string, consent: boolean}} fields
 * @param {{onProgress?: (percent: number) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<{id: string, status: string}>}
 */
export function createVoice(fields, { onProgress, signal } = {}) {
  const form = buildVoiceForm(fields);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/voices');
    xhr.setRequestHeader('X-Requested-With', 'lq-tts');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText ? JSON.parse(xhr.responseText) : null);
        return;
      }
      const res = new Response(xhr.responseText || null, {
        status: xhr.status,
        headers: {
          'Content-Type': xhr.getResponseHeader('Content-Type') ?? 'text/plain',
          'Retry-After': xhr.getResponseHeader('Retry-After') ?? '',
        },
      });
      reject(notify(await toApiError(res)));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'upload failed'));
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(form);
  });
}

export const urls = {
  /** @param {string} id */
  voicePreview: (id) => `/api/voices/${enc(id)}/preview`,
  /** `v` busts the browser cache after a regenerate (same path, new take). @param {string} jobId @param {number} idx @param {number} version */
  sentenceAudio: (jobId, idx, version) => `/api/jobs/${enc(jobId)}/sentences/${idx}/audio?v=${version}`,
  /** @param {string} jobId @param {string} name @param {number} [revision] */
  file: (jobId, name, revision) => `/api/jobs/${enc(jobId)}/files/${enc(name)}${revision ? `?revision=${revision}` : ''}`,
  /** @param {string} jobId */
  events: (jobId) => `/api/jobs/${enc(jobId)}/events`,
};

const EVENT_TYPES = /** @type {const} */ (['sentence_done', 'job_done', 'job_failed']);

/**
 * Live job events. The browser reconnects by itself after a drop; the reducer treats replayed events idempotently.
 * @param {string} jobId
 * @param {{onEvent: (event: any) => void, onOpen?: () => void, onError?: () => void}} handlers
 * @returns {() => void} close
 */
export function openJobEvents(jobId, { onEvent, onOpen, onError }) {
  const source = new EventSource(urls.events(jobId), { withCredentials: true });
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (event) => {
      let data;
      try {
        data = JSON.parse(/** @type {MessageEvent} */ (event).data);
      } catch {
        return;
      }
      onEvent({ ...data, type });
    });
  }
  source.onopen = () => onOpen?.();
  source.onerror = () => onError?.();
  return () => source.close();
}
```

- [ ] **Step 5: Write `src/lib/errors.js`**

```js
import { hasKey } from '../i18n/index.jsx';

const VOICE_ERRORS = new Set(['no_clean_speech', 'unsupported_audio', 'internal_error']);
const JOB_ERRORS = new Set(['synthesis_failed', 'worker_crashed', 'internal_error']);

/** Localized, actionable text for any thrown error (ApiError or otherwise). */
export function errorText(t, err) {
  const code = typeof err?.code === 'string' ? err.code : 'generic';
  if (code === 'rate_limited') {
    return err.retryAfter ? t('error.rate_limited', { seconds: err.retryAfter }) : t('error.rate_limited_later');
  }
  return hasKey(`error.${code}`) ? t(`error.${code}`) : t('error.generic');
}

/** Readable reason for a failed voice (engine `error_code`, spec §8.5). */
export function voiceErrorText(t, code) {
  return t(VOICE_ERRORS.has(code) ? `voices.error.${code}` : 'voices.error.unknown');
}

/** Readable reason for a failed or canceled job; both are refunded in full (spec §4). */
export function jobFailureText(t, status, code) {
  if (status === 'canceled') return t('job.failed.canceled');
  return t(JOB_ERRORS.has(code) ? `job.failed.${code}` : 'job.failed.unknown');
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/api.test.js src/lib/errors.test.js src/i18n`
Expected: PASS (api 12, errors 5, i18n 10).

- [ ] **Step 7: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/client/src/lib/types.js web/client/src/lib/api.js web/client/src/lib/api.test.js web/client/src/lib/errors.js web/client/src/lib/errors.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: typed C2 API client with error mapping"
```

---

### Task 4: SSE progress reducer

**Files:**
- Create: `web/client/src/lib/progress.js`
- Test: `web/client/src/lib/progress.test.js`

**Interfaces:**
- Consumes: SSE event objects from `openJobEvents` (Task 3).
- Produces: `TERMINAL: Set<'done'|'failed'|'canceled'>`; `progressReducer(state, action)` with actions `{type:'snapshot', job:JobDetail, sentences:Sentence[]}`, `{type:'sentence_done', idx, status, score, revision}`, `{type:'job_done', revision}`, `{type:'job_failed', status, errorCode}`, `{type:'regenerate_started', idx, revision}`; state `{status, revision, errorCode, total, sentences: Record<idx,{status,score}>, lastArrived: number|null}`; `doneCount(state):number` (done + needs_review).

- [ ] **Step 1: Write the failing test `src/lib/progress.test.js`**

```js
import { describe, expect, it } from 'vitest';
import { TERMINAL, doneCount, progressReducer } from './progress.js';

const job = (over = {}) => ({ id: 'j1', status: 'running', revision: 1, errorCode: null, progress: { done: 0, total: 3 }, ...over });
const sentence = (idx, status = 'pending', score = null) => ({ idx, status, score });
const snapshot = (j = job(), s = [sentence(0), sentence(1), sentence(2)]) =>
  progressReducer(null, { type: 'snapshot', job: j, sentences: s });

describe('progressReducer', () => {
  it('builds state from a snapshot', () => {
    const state = snapshot(job(), [sentence(0, 'done', 0.97), sentence(1), sentence(2)]);
    expect(state.status).toBe('running');
    expect(state.total).toBe(3);
    expect(doneCount(state)).toBe(1);
  });

  it('marks sentences done one by one and moves a queued job to running', () => {
    let state = snapshot(job({ status: 'queued' }));
    state = progressReducer(state, { type: 'sentence_done', idx: 0, status: 'done', score: 0.95, revision: 1 });
    expect(state.status).toBe('running');
    expect(state.lastArrived).toBe(0);
    state = progressReducer(state, { type: 'sentence_done', idx: 1, status: 'needs_review', score: 0.7, revision: 1 });
    expect(doneCount(state)).toBe(2);
  });

  it('ignores an identical replayed event (reconnect) without changing identity', () => {
    let state = snapshot();
    state = progressReducer(state, { type: 'sentence_done', idx: 0, status: 'done', score: 0.95, revision: 1 });
    const again = progressReducer(state, { type: 'sentence_done', idx: 0, status: 'done', score: 0.95, revision: 1 });
    expect(again).toBe(state);
  });

  it('drops events from an older revision', () => {
    const state = snapshot(job({ revision: 2 }));
    expect(progressReducer(state, { type: 'sentence_done', idx: 0, status: 'done', score: 1, revision: 1 })).toBe(state);
    expect(progressReducer(state, { type: 'job_done', revision: 1 })).toBe(state);
  });

  it('keeps a finished job finished when old sentences are replayed', () => {
    let state = snapshot(job({ status: 'done' }), [sentence(0, 'done', 0.9), sentence(1, 'done', 0.9), sentence(2, 'done', 0.9)]);
    state = progressReducer(state, { type: 'sentence_done', idx: 1, status: 'done', score: 0.91, revision: 1 });
    expect(state.status).toBe('done');
  });

  it('finishes and fails jobs', () => {
    const done = progressReducer(snapshot(), { type: 'job_done', revision: 1 });
    expect(done.status).toBe('done');
    expect(TERMINAL.has(done.status)).toBe(true);
    const failed = progressReducer(snapshot(), { type: 'job_failed', status: 'failed', errorCode: 'synthesis_failed' });
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'synthesis_failed' });
    const canceled = progressReducer(snapshot(), { type: 'job_failed', status: 'canceled', errorCode: null });
    expect(canceled.status).toBe('canceled');
  });

  it('restarts one sentence on regenerate under the new revision', () => {
    let state = snapshot(job({ status: 'done' }), [sentence(0, 'done', 0.9), sentence(1, 'done', 0.9), sentence(2, 'done', 0.9)]);
    state = progressReducer(state, { type: 'regenerate_started', idx: 1, revision: 2 });
    expect(state).toMatchObject({ status: 'queued', revision: 2 });
    expect(state.sentences[1]).toEqual({ status: 'pending', score: null });
    expect(doneCount(state)).toBe(2);
    state = progressReducer(state, { type: 'sentence_done', idx: 1, status: 'done', score: 0.96, revision: 2 });
    state = progressReducer(state, { type: 'job_done', revision: 2 });
    expect(state.status).toBe('done');
    expect(doneCount(state)).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/progress.test.js`
Expected: FAIL, `Failed to resolve import "./progress.js"`.

- [ ] **Step 3: Implement `src/lib/progress.js`**

```js
export const TERMINAL = new Set(['done', 'failed', 'canceled']);

const FINISHED = new Set(['done', 'needs_review']);

function fromSnapshot(job, sentences) {
  return {
    status: job.status,
    revision: job.revision,
    errorCode: job.errorCode ?? null,
    total: sentences.length || job.progress?.total || 0,
    sentences: Object.fromEntries(sentences.map((s) => [s.idx, { status: s.status, score: s.score ?? null }])),
    lastArrived: null,
  };
}

export function doneCount(state) {
  return Object.values(state.sentences).filter((s) => FINISHED.has(s.status)).length;
}

export function progressReducer(state, action) {
  switch (action.type) {
    case 'snapshot':
      return fromSnapshot(action.job, action.sentences);
    case 'sentence_done': {
      if (!state || action.revision < state.revision) return state;
      const prev = state.sentences[action.idx];
      const score = action.score ?? null;
      if (prev && prev.status === action.status && prev.score === score && action.revision === state.revision) return state;
      return {
        ...state,
        revision: Math.max(state.revision, action.revision),
        status: state.status === 'queued' ? 'running' : state.status,
        sentences: { ...state.sentences, [action.idx]: { status: action.status, score } },
        lastArrived: action.idx,
      };
    }
    case 'job_done':
      if (!state || action.revision < state.revision) return state;
      return { ...state, status: 'done', revision: action.revision, errorCode: null };
    case 'job_failed':
      if (!state) return state;
      return { ...state, status: action.status === 'canceled' ? 'canceled' : 'failed', errorCode: action.errorCode ?? null };
    case 'regenerate_started':
      if (!state) return state;
      return {
        ...state,
        status: 'queued',
        revision: action.revision,
        errorCode: null,
        sentences: { ...state.sentences, [action.idx]: { status: 'pending', score: null } },
        lastArrived: null,
      };
    default:
      return state;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/progress.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/client/src/lib/progress.js web/client/src/lib/progress.test.js
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: SSE progress reducer"
```

---
### Task 5: Session, UI primitives and the app shell

**Files:**
- Create: `web/client/src/lib/session.jsx`, `web/client/src/lib/useResource.js`, `web/client/src/lib/useHealth.js`, `web/client/src/components/ui.jsx`, `web/client/src/components/RequireSession.jsx`, `web/client/src/components/AppShell.jsx`, `web/client/src/components/AccountMenu.jsx`, `web/client/src/components/EngineBanner.jsx`, `web/client/src/pages/NotFoundPage.jsx`, `web/client/src/router.jsx`, `web/client/src/main.jsx`, `web/client/src/test/render.jsx`
- Test: `web/client/src/components/AppShell.test.jsx`, `web/client/src/components/RequireSession.test.jsx`

**Interfaces:**
- Consumes: `api`, `ApiError`, `onUnauthorized` (Task 3); `useI18n`, `LANG_OPTIONS`, `hasKey` (Task 2); `errorText` (Task 3).
- Produces:
  - `SessionProvider({children, initial?})`, `useSession() → {status:'unknown'|'loading'|'authed'|'anon'|'error', me:Me|null, error, refresh():Promise<Me|null>, signedIn(me), logout():Promise<void>, changeLang(lang):Promise<void>}`.
  - `useResource(fetcher, deps) → {data, error, loading, reload():Promise, setData(valueOrUpdater)}`; `useHealth(intervalMs=15000) → Health|null`.
  - `ui.jsx`: `buttonClass(variant='secondary'|'primary'|'ghost'|'danger', size='sm'|'md'|'lg', extra?)`, `Button({variant,size,loading,icon,type,...})`, `inputClass`, `Field({id,label,help?,error?,children})`, `Select({id,value,onChange,children,...})`, `Notice({tone:'info'|'success'|'warning'|'danger', children, action?, testId?})`, `Skeleton({className})` (renders `data-skeleton`), `EmptyState({icon,title,body,action?})`, `StatusChip({tone:'neutral'|'progress'|'success'|'warning'|'danger', icon?, spinning?, children, testId?, status?})`, `PageHeader({title, subtitle?, actions?})`, `Segmented({options:[{value,label,ariaLabel?}], value, onChange, labelledBy})`.
  - `AppShell` renders `<Outlet context={{ health }} />`; pages read it with `useOutletContext() ?? {}`.
  - `routes` (exported from `router.jsx`), `renderRoutes(routes, {path?, me?, lang?, session?})` and `ME` fixture from `src/test/render.jsx`.

- [ ] **Step 1: Re-read the craft floor (SOP G4)**

Read `~/.claude/skills/impeccable/reference/craft-floor.md` now, immediately before the first UI file of this session. Apply it with the Design direction section of this plan.

- [ ] **Step 2: Write `src/test/render.jsx`**

```jsx
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { I18nProvider } from '../i18n/index.jsx';
import { SessionProvider } from '../lib/session.jsx';

export const ME = {
  id: 'u1',
  name: 'Rara Wibisono',
  email: 'rara@example.com',
  plan: 'free',
  paid: false,
  lang: 'id',
  balance: 240,
  voiceLimit: 3,
  voiceCount: 1,
  topupUrl: 'https://demo.lq-studio.com/upgrade-plan',
};

export function renderRoutes(routes, { path = '/', me = ME, lang = 'id', session } = {}) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const initial = session ?? (me ? { status: 'authed', me, error: null } : { status: 'anon', me: null, error: null });
  const utils = render(
    <I18nProvider initialLang={lang}>
      <SessionProvider initial={initial}>
        <RouterProvider router={router} />
      </SessionProvider>
    </I18nProvider>,
  );
  return { ...utils, router };
}
```

- [ ] **Step 3: Write the failing tests**

`src/components/AppShell.test.jsx`:
```jsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoutes, ME } from '../test/render.jsx';
import AppShell from './AppShell.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { health: vi.fn(), setLang: vi.fn(), logout: vi.fn(), me: vi.fn() } };
});
const { api } = await import('../lib/api.js');

const routes = [
  { path: '/', element: <AppShell />, children: [{ index: true, element: <p>home</p> }] },
  { path: '/login', element: <p>login screen</p> },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.health.mockResolvedValue({ engine: 'ok', lqstudio: 'ok' });
});

describe('AppShell', () => {
  it('switches the UI to English and saves it on the server', async () => {
    api.setLang.mockResolvedValue({ ...ME, lang: 'en' });
    const user = userEvent.setup();
    renderRoutes(routes);
    expect(screen.getAllByRole('link', { name: 'Suara' }).length).toBeGreaterThan(0);
    await user.click(screen.getByTestId('account-button'));
    await user.click(screen.getByRole('radio', { name: 'English' }));
    expect(api.setLang).toHaveBeenCalledWith('en');
    expect((await screen.findAllByRole('link', { name: 'Voices' })).length).toBeGreaterThan(0);
    expect(document.documentElement.lang).toBe('en');
  });

  it('shows the engine-restarting banner from /api/health', async () => {
    api.health.mockResolvedValue({ engine: 'restarting', lqstudio: 'ok' });
    renderRoutes(routes);
    expect(await screen.findByText('Mesin suara sedang dimulai ulang, mohon tunggu. Pekerjaan baru tetap masuk antrean.')).toBeInTheDocument();
  });

  it('logs out and returns to the login screen', async () => {
    api.logout.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRoutes(routes);
    await user.click(screen.getByTestId('account-button'));
    await user.click(screen.getByTestId('logout'));
    expect(await screen.findByText('login screen')).toBeInTheDocument();
    expect(api.logout).toHaveBeenCalled();
  });

  it('closes the account menu with Escape and returns focus to its button', async () => {
    const user = userEvent.setup();
    renderRoutes(routes);
    await user.click(screen.getByTestId('account-button'));
    expect(screen.getByText('rara@example.com')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('rara@example.com')).not.toBeInTheDocument());
    expect(screen.getByTestId('account-button')).toHaveFocus();
  });
});
```

`src/components/RequireSession.test.jsx`:
```jsx
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderRoutes } from '../test/render.jsx';
import RequireSession from './RequireSession.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { me: vi.fn() } };
});
const { api, ApiError } = await import('../lib/api.js');

function LoginProbe() {
  return <p>login {window.location.pathname}</p>;
}

const routes = [
  { path: '/voices', element: <RequireSession><p>private voices</p></RequireSession> },
  { path: '/login', element: <LoginProbe /> },
];

describe('RequireSession', () => {
  it('redirects an anonymous visitor to /login with ?next=', async () => {
    api.me.mockRejectedValue(new ApiError(401, 'unauthorized', ''));
    const { router } = renderRoutes(routes, { path: '/voices', session: { status: 'unknown', me: null, error: null } });
    await screen.findByText(/^login/);
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?next=%2Fvoices');
  });

  it('renders the page once /api/me answers', async () => {
    api.me.mockResolvedValue({ id: 'u1', name: 'Rara', email: 'r@example.com', plan: 'free', paid: false, lang: 'id', balance: 10, voiceLimit: 3, voiceCount: 0, topupUrl: 'https://demo.lq-studio.com/upgrade-plan' });
    renderRoutes(routes, { path: '/voices', session: { status: 'unknown', me: null, error: null } });
    expect(await screen.findByText('private voices')).toBeInTheDocument();
  });

  it('offers a retry when the server is unreachable', async () => {
    api.me.mockRejectedValue(new ApiError(0, 'network', 'down'));
    renderRoutes(routes, { path: '/voices', session: { status: 'unknown', me: null, error: null } });
    expect(await screen.findByRole('button', { name: 'Coba lagi' })).toBeInTheDocument();
    expect(screen.getByText('Server tidak bisa dihubungi. Periksa koneksi internet kamu lalu coba lagi.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run src/components`
Expected: FAIL, `Failed to resolve import "../lib/session.jsx"` / `"./AppShell.jsx"`.

- [ ] **Step 5: Write `src/lib/session.jsx`**

```jsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { ApiError, api, onUnauthorized } from './api.js';

const SessionContext = createContext(null);
const ANON = { status: 'anon', me: null, error: null };

export function SessionProvider({ children, initial }) {
  const { setLang } = useI18n();
  const [state, setState] = useState(initial ?? { status: 'unknown', me: null, error: null });

  const refresh = useCallback(async () => {
    setState((s) => (s.status === 'authed' ? s : { ...s, status: 'loading' }));
    try {
      const me = await api.me();
      setState({ status: 'authed', me, error: null });
      setLang(me.lang);
      return me;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'unauthorized') setState(ANON);
      else setState((s) => (s.status === 'authed' ? s : { status: 'error', me: null, error }));
      return null;
    }
  }, [setLang]);

  useEffect(() => onUnauthorized(() => setState(ANON)), []);

  const signedIn = useCallback((me) => {
    setState({ status: 'authed', me, error: null });
    setLang(me.lang);
  }, [setLang]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // The local session is dropped either way; the server row expires on its own.
    }
    setState(ANON);
  }, []);

  const changeLang = useCallback(async (lang) => {
    setLang(lang);
    const me = await api.setLang(lang);
    setState({ status: 'authed', me, error: null });
  }, [setLang]);

  const value = useMemo(
    () => ({ ...state, refresh, signedIn, logout, changeLang }),
    [state, refresh, signedIn, logout, changeLang],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
```

- [ ] **Step 6: Write `src/lib/useResource.js` and `src/lib/useHealth.js`**

`src/lib/useResource.js`:
```js
import { useCallback, useEffect, useRef, useState } from 'react';

/** Loads `fetcher()` on mount and when `deps` change; older responses never overwrite newer ones. */
export function useResource(fetcher, deps) {
  const [state, setState] = useState({ data: undefined, error: null, loading: true });
  const seq = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fetcher();
      if (mine === seq.current) setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      if (mine === seq.current) setState((s) => ({ data: s.data, error, loading: false }));
      return undefined;
    }
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);

  const setData = useCallback((next) => {
    setState((s) => ({ ...s, data: typeof next === 'function' ? next(s.data) : next }));
  }, []);

  return { ...state, reload, setData };
}
```

`src/lib/useHealth.js`:
```js
import { useEffect, useState } from 'react';
import { api } from './api.js';

/** Polls GET /api/health while the tab is visible (spec §8.1 and §8.4 banners). */
export function useHealth(intervalMs = 15000) {
  const [health, setHealth] = useState(null);
  useEffect(() => {
    let stopped = false;
    let timer;
    async function tick() {
      if (document.visibilityState !== 'hidden') {
        try {
          const next = await api.health();
          if (!stopped) setHealth(next);
        } catch {
          if (!stopped) setHealth(null);
        }
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [intervalMs]);
  return health;
}
```

- [ ] **Step 7: Write `src/components/ui.jsx`**

```jsx
import { CaretDownIcon, CheckCircleIcon, CircleNotchIcon, InfoIcon, WarningCircleIcon } from '@phosphor-icons/react';

const VARIANTS = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 disabled:bg-surface-2 disabled:text-dim disabled:hover:brightness-100',
  secondary: 'border border-line bg-surface text-ink hover:border-dim hover:bg-surface-2 disabled:text-dim disabled:hover:border-line disabled:hover:bg-surface',
  ghost: 'text-muted hover:bg-surface-2 hover:text-ink disabled:text-dim disabled:hover:bg-transparent',
  danger: 'border border-danger/40 bg-danger-soft text-danger hover:border-danger disabled:text-dim',
};
const SIZES = { sm: 'h-9 px-3 text-sm', md: 'h-10 px-4 text-sm', lg: 'h-12 px-5 text-base' };

export function buttonClass(variant = 'secondary', size = 'md', extra = '') {
  return [
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium',
    'transition-[background-color,border-color,color,filter,transform] duration-150 ease-out active:scale-[0.98]',
    'disabled:cursor-not-allowed disabled:active:scale-100 pointer-coarse:min-h-11',
    SIZES[size],
    VARIANTS[variant],
    extra,
  ].join(' ');
}

export function Button({ variant = 'secondary', size = 'md', loading = false, icon: Icon = null, className = '', children, disabled, type = 'button', ...rest }) {
  return (
    <button type={type} {...rest} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, size, className)}>
      {loading ? <CircleNotchIcon size={18} className="animate-spin" aria-hidden /> : Icon ? <Icon size={18} aria-hidden /> : null}
      {children}
    </button>
  );
}

export const inputClass = 'block w-full rounded-control border border-line bg-surface px-3 text-base text-ink placeholder:text-dim transition-colors duration-150 hover:border-dim focus-visible:border-accent aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:text-dim';

export function Field({ id, label, help = null, error = null, children, className = '' }) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-ink">{label}</label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-sm text-danger">
          <WarningCircleIcon size={16} className="mt-0.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : help ? (
        <p id={`${id}-help`} className="max-w-[65ch] text-sm leading-relaxed text-dim">{help}</p>
      ) : null}
    </div>
  );
}

export function Select({ id, value, onChange, children, className = '', ...rest }) {
  return (
    <div className={`relative ${className}`}>
      <select id={id} value={value} onChange={onChange} {...rest} className={`${inputClass} h-11 cursor-pointer appearance-none pr-10`}>
        {children}
      </select>
      <CaretDownIcon size={16} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
    </div>
  );
}

const TONES = {
  info: ['bg-surface-2', InfoIcon, 'text-muted'],
  success: ['bg-success-soft', CheckCircleIcon, 'text-success'],
  warning: ['bg-warning-soft', WarningCircleIcon, 'text-warning'],
  danger: ['bg-danger-soft', WarningCircleIcon, 'text-danger'],
};

export function Notice({ tone = 'info', children, action = null, testId }) {
  const [box, Icon, iconColor] = TONES[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} data-testid={testId} className={`flex flex-wrap items-start gap-3 rounded-control px-4 py-3 text-sm text-ink ${box}`}>
      <Icon size={18} aria-hidden className={`mt-0.5 shrink-0 ${iconColor}`} />
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className = '' }) {
  return <div data-skeleton aria-hidden className={`animate-skeleton rounded-control bg-surface-2 ${className}`} />;
}

export function EmptyState({ icon: Icon = null, title, body, action = null }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-panel border border-dashed border-line px-6 py-8">
      {Icon ? <Icon size={28} aria-hidden className="text-accent" /> : null}
      <div>
        <p className="text-lg font-semibold text-ink">{title}</p>
        <p className="mt-1 max-w-[56ch] text-sm leading-relaxed text-muted">{body}</p>
      </div>
      {action}
    </div>
  );
}

const CHIPS = {
  neutral: 'bg-surface-2 text-muted',
  progress: 'bg-accent-soft text-ink',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

export function StatusChip({ tone = 'neutral', icon: Icon = null, spinning = false, children, testId, status }) {
  return (
    <span data-testid={testId} data-status={status} className={`inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium ${CHIPS[tone]}`}>
      {Icon ? <Icon size={14} aria-hidden className={spinning ? 'animate-spin' : ''} /> : null}
      {children}
    </span>
  );
}

export function PageHeader({ title, subtitle = null, actions = null }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Segmented({ options, value, onChange, labelledBy }) {
  function onKeyDown(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = options.findIndex((o) => o.value === value);
    const step = event.key === 'ArrowRight' ? 1 : options.length - 1;
    const next = options[(index + step) % options.length];
    onChange(next.value);
    event.currentTarget.parentElement?.querySelector(`[data-value="${next.value}"]`)?.focus();
  }
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="inline-flex rounded-control border border-line bg-surface-2 p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            tabIndex={on ? 0 : -1}
            data-value={o.value}
            onKeyDown={onKeyDown}
            onClick={() => onChange(o.value)}
            className={`h-8 min-w-14 rounded-[6px] px-3 text-sm font-medium transition-colors duration-150 pointer-coarse:min-h-11 ${on ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/0.12)]' : 'text-muted hover:text-ink'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 8: Write `src/components/EngineBanner.jsx` and `src/components/AccountMenu.jsx`**

`src/components/EngineBanner.jsx`:
```jsx
import { WarningCircleIcon } from '@phosphor-icons/react';
import { useI18n } from '../i18n/index.jsx';

export default function EngineBanner({ health }) {
  const { t } = useI18n();
  if (!health) return null;
  const lines = [];
  if (health.engine === 'restarting') lines.push(['engine', t('banner.engine_restarting')]);
  if (health.lqstudio === 'down') lines.push(['lqstudio', t('banner.lqstudio_down')]);
  if (!lines.length) return null;
  return (
    <div role="status" data-testid="health-banner" className="border-b border-line bg-warning-soft px-4 py-3 md:px-8">
      {lines.map(([key, text]) => (
        <p key={key} className="mx-auto flex max-w-[1120px] items-start gap-2 text-sm text-ink">
          <WarningCircleIcon size={18} aria-hidden className="mt-0.5 shrink-0 text-warning" />
          {text}
        </p>
      ))}
    </div>
  );
}
```

`src/components/AccountMenu.jsx`:
```jsx
import { CaretDownIcon, SignOutIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { LANG_OPTIONS, hasKey, useI18n } from '../i18n/index.jsx';
import { useSession } from '../lib/session.jsx';
import { Button, Segmented } from './ui.jsx';

export default function AccountMenu() {
  const { t, lang } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [langError, setLangError] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    panelRef.current?.querySelector('[role="radio"][aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const me = session.me;
  if (!me) return null;
  const planName = hasKey(`plan.${me.plan}`) ? t(`plan.${me.plan}`) : me.plan;

  async function pickLang(next) {
    if (next === lang) return;
    setLangError(false);
    try {
      await session.changeLang(next);
    } catch {
      setLangError(true);
    }
  }

  async function logout() {
    await session.logout();
    navigate('/login', { replace: true });
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid="account-button"
        aria-label={t('account.menu')}
        aria-expanded={open}
        aria-controls="account-panel"
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 max-w-[14rem] items-center gap-2 rounded-control px-3 text-sm font-medium text-ink transition-colors duration-150 hover:bg-surface-2 pointer-coarse:min-h-11"
      >
        <span className="truncate">{me.name}</span>
        <CaretDownIcon size={16} aria-hidden className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div id="account-panel" ref={panelRef} className="animate-pop absolute right-0 top-12 z-[var(--z-popover)] w-72 rounded-panel border border-line bg-surface p-4 shadow-[var(--shadow-pop)]">
          <p className="truncate text-sm font-semibold text-ink">{me.name}</p>
          <p className="truncate text-sm text-muted">{me.email}</p>
          <p className="mt-1 text-xs text-dim">{t('account.plan', { plan: planName })}</p>
          <div className="mt-4">
            <p id="account-lang" className="mb-2 text-xs font-medium text-muted">{t('account.language')}</p>
            <Segmented labelledBy="account-lang" value={lang} onChange={pickLang} options={LANG_OPTIONS} />
            {langError ? <p className="mt-2 text-xs text-danger" role="alert">{t('account.lang_error')}</p> : null}
          </div>
          <Button className="mt-4 w-full" icon={SignOutIcon} onClick={logout} data-testid="logout">{t('account.logout')}</Button>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 9: Write `src/components/AppShell.jsx`**

```jsx
import { ClockCounterClockwiseIcon, CoinsIcon, TextAaIcon, UserSoundIcon, WaveformIcon } from '@phosphor-icons/react';
import { Link, NavLink, Outlet, useMatch } from 'react-router';
import { useI18n } from '../i18n/index.jsx';
import { useHealth } from '../lib/useHealth.js';
import AccountMenu from './AccountMenu.jsx';
import EngineBanner from './EngineBanner.jsx';

const NAV = [
  { to: '/', key: 'nav.tts', icon: TextAaIcon, end: true },
  { to: '/voices', key: 'nav.voices', icon: UserSoundIcon },
  { to: '/history', key: 'nav.history', icon: ClockCounterClockwiseIcon },
  { to: '/credits', key: 'nav.credits', icon: CoinsIcon },
];

function Brand({ rail = false }) {
  return (
    <Link to="/" className={`flex h-14 items-center gap-2 px-5 text-base font-semibold text-ink ${rail ? 'md:justify-center md:px-0 lg:justify-start lg:px-5' : ''}`}>
      <WaveformIcon size={22} weight="bold" aria-hidden className="text-accent" />
      <span className={rail ? 'md:sr-only lg:not-sr-only' : ''}>LQ TTS</span>
    </Link>
  );
}

export default function AppShell() {
  const { t } = useI18n();
  const health = useHealth();
  const onJob = useMatch('/jobs/:id');
  const active = (item, isActive) => isActive || (item.to === '/' && Boolean(onJob));

  return (
    <div className="min-h-[100dvh] md:grid md:grid-cols-[72px_minmax(0,1fr)] lg:grid-cols-[232px_minmax(0,1fr)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[var(--z-skip)] focus:rounded-control focus:bg-surface focus:px-4 focus:py-2 focus:text-ink">
        {t('nav.skip')}
      </a>
      <aside data-testid="sidebar" className="sticky top-0 hidden h-[100dvh] flex-col border-r border-line bg-surface md:flex">
        <Brand rail />
        <nav aria-label={t('nav.label')} className="flex flex-col gap-1 px-3 py-4">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={t(item.key)}
              className={({ isActive }) => `flex h-11 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors duration-150 md:justify-center lg:justify-start ${active(item, isActive) ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-surface-2 hover:text-ink'}`}
            >
              {({ isActive }) => (
                <>
                  <item.icon size={20} weight={active(item, isActive) ? 'fill' : 'regular'} aria-hidden className={active(item, isActive) ? 'shrink-0 text-accent' : 'shrink-0'} />
                  <span className="md:sr-only lg:not-sr-only">{t(item.key)}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-col pb-[calc(64px+env(safe-area-inset-bottom))] md:pb-0">
        <header className="sticky top-0 z-[var(--z-sticky)] flex h-14 items-center justify-between gap-4 border-b border-line bg-bg px-4 md:justify-end md:px-8">
          <div className="-ml-5 md:hidden"><Brand /></div>
          <AccountMenu />
        </header>
        <EngineBanner health={health} />
        <main id="main" className="mx-auto w-full max-w-[1120px] flex-1 px-4 py-6 md:px-8 md:py-8">
          <Outlet context={{ health }} />
        </main>
      </div>

      <nav aria-label={t('nav.label')} data-testid="bottom-nav" className="fixed inset-x-0 bottom-0 z-[var(--z-sticky)] grid grid-cols-4 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `flex h-16 flex-col items-center justify-center gap-1 text-xs font-medium transition-colors duration-150 ${active(item, isActive) ? 'text-ink' : 'text-muted'}`}
          >
            {({ isActive }) => (
              <>
                <item.icon size={22} weight={active(item, isActive) ? 'fill' : 'regular'} aria-hidden className={active(item, isActive) ? 'text-accent' : ''} />
                <span>{t(item.key)}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
```

- [ ] **Step 10: Write `src/components/RequireSession.jsx` and `src/pages/NotFoundPage.jsx`**

`src/components/RequireSession.jsx`:
```jsx
import { WarningCircleIcon } from '@phosphor-icons/react';
import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useI18n } from '../i18n/index.jsx';
import { errorText } from '../lib/errors.js';
import { useSession } from '../lib/session.jsx';
import { Button, Skeleton } from './ui.jsx';

function ShellSkeleton() {
  return (
    <div className="min-h-[100dvh] md:grid md:grid-cols-[72px_minmax(0,1fr)] lg:grid-cols-[232px_minmax(0,1fr)]" aria-busy="true">
      <div className="hidden border-r border-line bg-surface md:block" />
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-4 px-4 py-20 md:px-8">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}

export default function RequireSession({ children }) {
  const session = useSession();
  const location = useLocation();
  const { t } = useI18n();
  const { status, refresh } = session;

  useEffect(() => {
    if (status === 'unknown') refresh();
  }, [status, refresh]);

  if (status === 'authed') return children;
  if (status === 'anon') {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (status === 'error') {
    return (
      <main id="main" className="mx-auto flex min-h-[100dvh] max-w-[480px] flex-col justify-center gap-4 px-4">
        <WarningCircleIcon size={28} aria-hidden className="text-danger" />
        <h1 className="text-2xl font-semibold text-ink">{t('shell.error_title')}</h1>
        <p className="text-sm leading-relaxed text-muted">{errorText(t, session.error)}</p>
        <Button variant="primary" className="self-start" onClick={refresh}>{t('common.retry')}</Button>
      </main>
    );
  }
  return <ShellSkeleton />;
}
```

`src/pages/NotFoundPage.jsx`:
```jsx
import { CompassIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { useI18n } from '../i18n/index.jsx';
import { EmptyState, buttonClass } from '../components/ui.jsx';

export default function NotFoundPage() {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={CompassIcon}
      title={t('notfound.title')}
      body={t('notfound.body')}
      action={<Link to="/" className={buttonClass('secondary')}>{t('notfound.home')}</Link>}
    />
  );
}
```

- [ ] **Step 11: Write `src/router.jsx` and `src/main.jsx`**

`src/router.jsx` (this file grows in Tasks 6–10; each task shows the full new content):
```jsx
import AppShell from './components/AppShell.jsx';
import RequireSession from './components/RequireSession.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

export const routes = [
  {
    path: '/',
    element: <RequireSession><AppShell /></RequireSession>,
    children: [{ path: '*', element: <NotFoundPage /> }],
  },
];
```

`src/main.jsx`:
```jsx
import { IconContext } from '@phosphor-icons/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { I18nProvider } from './i18n/index.jsx';
import { SessionProvider } from './lib/session.jsx';
import { routes } from './router.jsx';
import './styles.css';

const router = createBrowserRouter(routes);
const iconDefaults = { size: 20, weight: 'regular', mirrored: false };

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <I18nProvider>
      <SessionProvider>
        <IconContext.Provider value={iconDefaults}>
          <RouterProvider router={router} />
        </IconContext.Provider>
      </SessionProvider>
    </I18nProvider>
  </StrictMode>,
);
```

- [ ] **Step 12: Verify `CompassIcon` exists, run the tests and the build**

Run: `test -f node_modules/@phosphor-icons/react/dist/csr/Compass.es.js && echo ok`
Expected: `ok`.

Run: `npx vitest run`
Expected: PASS, all files (Tasks 1–5), including `i18n.test.js` "define every literal key the source code uses".

Run: `npm run build`
Expected: `✓ built in …`, `dist/index.html`, `dist/assets/*.js`, `dist/assets/*.css`, woff2 files for Space Grotesk and JetBrains Mono; no warnings about unresolved imports.

- [ ] **Step 13: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/client/src
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: session, UI primitives and app shell"
```

---

### Task 6: Login with 2FA and needs-verification

**Files:**
- Create: `web/client/src/lib/links.js`, `web/client/src/pages/LoginPage.jsx`
- Modify: `web/client/src/router.jsx` (full content below)
- Test: `web/client/src/lib/links.test.js`, `web/client/src/pages/LoginPage.test.jsx`

**Interfaces:**
- Consumes: `api.login`, `api.verify2fa` (Task 3); `useSession().signedIn` (Task 5); `errorText`; `Segmented`, `Field`, `Button`, `Notice`, `buttonClass`, `inputClass`.
- Produces: `lqstudioOrigin(hostname?) → 'https://lq-studio.com' | 'https://demo.lq-studio.com'` (only `tts.lq-studio.com` maps to PROD), `safeNext(raw) → string` (same-origin path, never `//…` or `/login…`, default `/`). Route `/login`.

- [ ] **Step 1: Write the failing tests**

`src/lib/links.test.js`:
```js
import { describe, expect, it } from 'vitest';
import { lqstudioOrigin, safeNext } from './links.js';

describe('lqstudioOrigin', () => {
  it('maps only the PROD host to PROD LQ-Studio', () => {
    expect(lqstudioOrigin('tts.lq-studio.com')).toBe('https://lq-studio.com');
    expect(lqstudioOrigin('tts-stg.lq-studio.com')).toBe('https://demo.lq-studio.com');
    expect(lqstudioOrigin('127.0.0.1')).toBe('https://demo.lq-studio.com');
  });
});

describe('safeNext', () => {
  it('keeps same-origin paths', () => {
    expect(safeNext('/voices')).toBe('/voices');
    expect(safeNext('/jobs/abc?x=1')).toBe('/jobs/abc?x=1');
  });
  it('rejects open redirects and loops', () => {
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/login?next=/x')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});
```

`src/pages/LoginPage.test.jsx`:
```jsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ME, renderRoutes } from '../test/render.jsx';
import LoginPage from './LoginPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { login: vi.fn(), verify2fa: vi.fn() } };
});
const { api, ApiError } = await import('../lib/api.js');

const routes = [
  { path: '/login', element: <LoginPage /> },
  { path: '/voices', element: <p>voices page</p> },
  { path: '/', element: <p>home page</p> },
];
const anon = { me: null };

async function submitCredentials(user) {
  await user.type(screen.getByLabelText('Email atau username'), 'rara');
  await user.type(screen.getByLabelText('Kata sandi'), 'rahasia-123');
  await user.click(screen.getByRole('button', { name: 'Masuk' }));
}

beforeEach(() => vi.clearAllMocks());

describe('LoginPage', () => {
  it('asks for the 2FA code, then signs in and follows ?next=', async () => {
    api.login.mockResolvedValue({ status: 'need_2fa', challenge: 'ch-1' });
    api.verify2fa.mockResolvedValue({ status: 'ok', user: ME });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login?next=%2Fvoices', ...anon });
    await submitCredentials(user);
    expect(api.login).toHaveBeenCalledWith('rara', 'rahasia-123');
    expect(await screen.findByRole('heading', { name: 'Verifikasi dua langkah' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Kode'), '482 913');
    await user.click(screen.getByRole('button', { name: 'Verifikasi' }));
    expect(api.verify2fa).toHaveBeenCalledWith('ch-1', '482913');
    expect(await screen.findByText('voices page')).toBeInTheDocument();
  });

  it('validates on submit without calling the server', async () => {
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login', ...anon });
    await user.click(screen.getByRole('button', { name: 'Masuk' }));
    expect(screen.getAllByText('Isi kolom ini.')).toHaveLength(2);
    expect(api.login).not.toHaveBeenCalled();
  });

  it('sends unverified accounts to LQ-Studio', async () => {
    api.login.mockResolvedValue({ status: 'needs_verification', verifyUrl: 'https://demo.lq-studio.com/settings' });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login', ...anon });
    await submitCredentials(user);
    expect(await screen.findByRole('heading', { name: 'Selesaikan verifikasi akun' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buka LQ-Studio' })).toHaveAttribute('href', 'https://demo.lq-studio.com/settings');
  });

  it('shows readable errors for wrong credentials, rate limits and LQ-Studio outages', async () => {
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login', ...anon });
    api.login.mockRejectedValueOnce(new ApiError(401, 'invalid_credentials', ''));
    await submitCredentials(user);
    expect(await screen.findByText('Email/username atau kata sandi salah.')).toBeInTheDocument();
    api.login.mockRejectedValueOnce(new ApiError(429, 'rate_limited', '', { retryAfter: 60 }));
    await user.click(screen.getByRole('button', { name: 'Masuk' }));
    expect(await screen.findByText('Terlalu banyak percobaan. Coba lagi dalam 60 detik.')).toBeInTheDocument();
    api.login.mockRejectedValueOnce(new ApiError(503, 'lqstudio_unavailable', ''));
    await user.click(screen.getByRole('button', { name: 'Masuk' }));
    expect(await screen.findByText('LQ-Studio sedang tidak dapat dihubungi. Coba lagi sebentar lagi.')).toBeInTheDocument();
  });

  it('links to LQ-Studio sign-up and switches language before login', async () => {
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/login', ...anon });
    expect(screen.getByRole('link', { name: 'Daftar di LQ-Studio' })).toHaveAttribute('href', 'https://demo.lq-studio.com/signup');
    await user.click(screen.getByRole('radio', { name: 'English' }));
    expect(screen.getByRole('heading', { name: 'Log in to LQ TTS' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/links.test.js src/pages/LoginPage.test.jsx`
Expected: FAIL, `Failed to resolve import "./links.js"` / `"./LoginPage.jsx"`.

- [ ] **Step 3: Write `src/lib/links.js`**

```js
/** LQ-Studio origin for sign-up links. Contract C2 has no pre-login config endpoint, so the host decides. */
export function lqstudioOrigin(hostname = window.location.hostname) {
  return hostname === 'tts.lq-studio.com' ? 'https://lq-studio.com' : 'https://demo.lq-studio.com';
}

/** Only same-origin app paths are accepted as a post-login destination. */
export function safeNext(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\') || raw.startsWith('/login')) return '/';
  return raw;
}
```

- [ ] **Step 4: Write `src/pages/LoginPage.jsx`**

```jsx
import { ArrowLeftIcon, ArrowSquareOutIcon, WaveformIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { Button, Field, Notice, Segmented, buttonClass, inputClass } from '../components/ui.jsx';
import { LANG_OPTIONS, useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { errorText } from '../lib/errors.js';
import { lqstudioOrigin, safeNext } from '../lib/links.js';
import { useSession } from '../lib/session.jsx';

const CODE_PATTERN = /^(\d{6}|[A-Za-z0-9-]{8,16})$/;

export default function LoginPage() {
  const { t, lang, setLang } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [step, setStep] = useState({ kind: 'credentials' });
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (session.status === 'authed') return <Navigate to={next} replace />;

  const cleanCode = code.replace(/\s+/g, '');
  const identifierMissing = Boolean(touched.identifier) && !identifier.trim();
  const passwordMissing = Boolean(touched.password) && !password;
  const codeInvalid = Boolean(touched.code) && !CODE_PATTERN.test(cleanCode);

  function finish(user) {
    session.signedIn(user);
    navigate(next, { replace: true });
  }

  async function onCredentials(event) {
    event.preventDefault();
    setTouched({ identifier: true, password: true });
    if (!identifier.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(identifier.trim(), password);
      if (result.status === 'ok') finish(result.user);
      else if (result.status === 'need_2fa') {
        setStep({ kind: '2fa', challenge: result.challenge });
        setPassword('');
        setTouched({});
      } else if (result.status === 'needs_verification') setStep({ kind: 'verify', verifyUrl: result.verifyUrl });
      else setError({ code: 'generic' });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function onCode(event) {
    event.preventDefault();
    setTouched({ code: true });
    if (!CODE_PATTERN.test(cleanCode)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.verify2fa(step.challenge, cleanCode);
      finish(result.user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function back() {
    setStep({ kind: 'credentials' });
    setCode('');
    setError(null);
    setTouched({});
  }

  const heading = (title, body) => (
    <div>
      <h1 className="text-2xl font-semibold text-ink">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
    </div>
  );

  return (
    <div className="min-h-[100dvh] bg-bg">
      <header className="mx-auto flex h-16 max-w-[1120px] items-center justify-between px-4 md:px-8">
        <span className="flex items-center gap-2 text-base font-semibold text-ink">
          <WaveformIcon size={22} weight="bold" aria-hidden className="text-accent" />
          LQ TTS
        </span>
        <div>
          <span id="login-lang" className="sr-only">{t('account.language')}</span>
          <Segmented labelledBy="login-lang" value={lang} onChange={setLang} options={LANG_OPTIONS} />
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-[420px] px-4 pb-16 pt-[10vh]">
        {step.kind === 'credentials' ? (
          <form noValidate onSubmit={onCredentials} className="flex flex-col gap-5">
            {heading(t('login.title'), t('login.subtitle'))}
            {error ? <Notice tone="danger" testId="login-error">{errorText(t, error)}</Notice> : null}
            <Field id="identifier" label={t('login.identifier')} error={identifierMissing ? t('login.required') : null}>
              <input
                id="identifier"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                onBlur={() => setTouched((s) => ({ ...s, identifier: true }))}
                aria-invalid={identifierMissing || undefined}
                aria-describedby={identifierMissing ? 'identifier-error' : undefined}
                className={`${inputClass} h-11`}
              />
            </Field>
            <Field id="password" label={t('login.password')} error={passwordMissing ? t('login.required') : null}>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => setTouched((s) => ({ ...s, password: true }))}
                aria-invalid={passwordMissing || undefined}
                aria-describedby={passwordMissing ? 'password-error' : undefined}
                className={`${inputClass} h-11`}
              />
            </Field>
            <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
              {busy ? t('login.submitting') : t('login.submit')}
            </Button>
            <p className="text-sm text-muted">
              {t('login.no_account')}{' '}
              <a className="font-medium text-accent underline-offset-4 hover:underline" href={`${lqstudioOrigin()}/signup`} target="_blank" rel="noreferrer">
                {t('login.signup')}
              </a>
            </p>
          </form>
        ) : null}

        {step.kind === '2fa' ? (
          <form noValidate onSubmit={onCode} className="flex flex-col gap-5">
            {heading(t('login.twofa_title'), t('login.twofa_help'))}
            {error ? <Notice tone="danger" testId="login-error">{errorText(t, error)}</Notice> : null}
            <Field id="code" label={t('login.code')} error={codeInvalid ? t('login.code_format') : null}>
              <input
                id="code"
                name="one-time-code"
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={20}
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onBlur={() => setTouched({ code: true })}
                aria-invalid={codeInvalid || undefined}
                aria-describedby={codeInvalid ? 'code-error' : undefined}
                className={`${inputClass} h-12 font-mono text-lg tracking-[0.2em]`}
              />
            </Field>
            <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">{t('login.verify')}</Button>
            <Button variant="ghost" icon={ArrowLeftIcon} onClick={back} className="self-start">{t('login.back')}</Button>
          </form>
        ) : null}

        {step.kind === 'verify' ? (
          <div className="flex flex-col gap-5">
            {heading(t('login.verify_title'), t('login.verify_help'))}
            <a href={step.verifyUrl} target="_blank" rel="noreferrer" className={buttonClass('primary', 'lg', 'w-full')}>
              {t('login.verify_cta')}
              <ArrowSquareOutIcon size={18} aria-hidden />
            </a>
            <Button variant="ghost" icon={ArrowLeftIcon} onClick={back} className="self-start">{t('login.back')}</Button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
```

- [ ] **Step 5: Replace `src/router.jsx`**

```jsx
import AppShell from './components/AppShell.jsx';
import RequireSession from './components/RequireSession.jsx';
import LoginPage from './pages/LoginPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

export const routes = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <RequireSession><AppShell /></RequireSession>,
    children: [{ path: '*', element: <NotFoundPage /> }],
  },
];
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/client/src
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: login with 2FA and needs-verification states"
```

---

### Task 7: Voices (clone with consent, limit, preview, delete)

**Files:**
- Create: `web/client/src/lib/voices.js`, `web/client/src/lib/useAudioToggle.js`, `web/client/src/components/PlayButton.jsx`, `web/client/src/components/status.jsx`, `web/client/src/pages/VoicesPage.jsx`
- Modify: `web/client/src/router.jsx` (full content below)
- Test: `web/client/src/lib/voices.test.js`, `web/client/src/pages/VoicesPage.test.jsx`

**Interfaces:**
- Consumes: `api.voices`, `api.deleteVoice`, `createVoice` (Task 3); `useResource`, `useSession` (Task 5); `voiceErrorText`, `errorText`; `formatDateTime`, `formatBytes`, `formatNumber`.
- Produces: `AUDIO_EXTENSIONS`, `MAX_AUDIO_BYTES = 99614720` (95 MB), `audioFileProblem(file) → i18n key | null`, `countsTowardLimit(voice) → boolean` (processing/ready count, failed does not); `useAudioToggle(src) → {playing, toggle}` (only one audio plays app-wide); `PlayButton({src, label, testId?})` (`aria-pressed` = playing); `JobStatus({status, testId?})`, `SentenceStatus({status})`, `VoiceStatus({status})`. Route `/voices`. DOM hooks used by Playwright: `[data-testid="voice-row"][data-status]`.

- [ ] **Step 1: Write the failing tests**

`src/lib/voices.test.js`:
```js
import { describe, expect, it } from 'vitest';
import { MAX_AUDIO_BYTES, audioFileProblem, countsTowardLimit } from './voices.js';

const file = (name, size) => ({ name, size });

describe('audioFileProblem', () => {
  it('accepts the four formats, case-insensitively', () => {
    for (const name of ['a.mp3', 'b.WAV', 'c.m4a', 'd.Flac']) expect(audioFileProblem(file(name, 1000))).toBeNull();
  });
  it('rejects missing, unsupported, empty and oversized files', () => {
    expect(audioFileProblem(null)).toBe('voices.form.audio_required');
    expect(audioFileProblem(file('clip.ogg', 1000))).toBe('voices.form.audio_type');
    expect(audioFileProblem(file('noext', 1000))).toBe('voices.form.audio_type');
    expect(audioFileProblem(file('a.wav', 0))).toBe('voices.form.audio_empty');
    expect(audioFileProblem(file('a.wav', MAX_AUDIO_BYTES))).toBeNull();
    expect(audioFileProblem(file('a.wav', MAX_AUDIO_BYTES + 1))).toBe('voices.form.audio_size');
  });
});

describe('countsTowardLimit', () => {
  it('counts processing and ready voices, not failed ones (spec §4)', () => {
    expect(countsTowardLimit({ status: 'processing' })).toBe(true);
    expect(countsTowardLimit({ status: 'ready' })).toBe(true);
    expect(countsTowardLimit({ status: 'failed' })).toBe(false);
  });
});
```

`src/pages/VoicesPage.test.jsx`:
```jsx
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ME, renderRoutes } from '../test/render.jsx';
import VoicesPage from './VoicesPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { voices: vi.fn(), deleteVoice: vi.fn(), me: vi.fn() }, createVoice: vi.fn() };
});
const { api, createVoice, ApiError } = await import('../lib/api.js');

const voice = (over) => ({ id: 'v1', name: 'Pandji', language: 'id', status: 'ready', errorCode: null, refSeconds: 14.2, createdAt: '2026-10-03T08:00:00.000Z', previewUrl: '/api/voices/v1/preview', ...over });
const routes = [{ path: '/voices', element: <VoicesPage /> }];

beforeEach(() => {
  vi.clearAllMocks();
  api.me.mockResolvedValue(ME);
});

describe('VoicesPage', () => {
  it('requires consent before uploading', async () => {
    api.voices.mockResolvedValue([]);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await user.click(await screen.findByRole('button', { name: 'Kloning suara' }));
    await user.upload(screen.getByLabelText('Rekaman'), new File(['RIFF'], 'pandji.wav', { type: 'audio/wav' }));
    await user.type(screen.getByLabelText('Nama suara'), 'Pandji');
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(screen.getByText('Centang persetujuan dulu sebelum mengkloning suara.')).toBeInTheDocument();
    expect(createVoice).not.toHaveBeenCalled();

    createVoice.mockResolvedValue({ id: 'v9', status: 'processing' });
    await user.click(screen.getByRole('checkbox', { name: /Saya pemilik suara ini/ }));
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(createVoice).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Pandji', language: 'auto', transcript: '', consent: true }),
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(await screen.findByText('Suara sedang diproses. Biasanya selesai dalam satu menit.')).toBeInTheDocument();
  });

  it('rejects unsupported files in the browser', async () => {
    api.voices.mockResolvedValue([]);
    const user = userEvent.setup({ applyAccept: false });
    renderRoutes(routes, { path: '/voices' });
    await user.click(await screen.findByRole('button', { name: 'Kloning suara' }));
    await user.upload(screen.getByLabelText('Rekaman'), new File(['x'], 'clip.ogg', { type: 'audio/ogg' }));
    expect(screen.getByText('Format ini tidak didukung. Pakai MP3, WAV, M4A, atau FLAC.')).toBeInTheDocument();
  });

  it('refuses recordings over 95 MB and suggests MP3 or M4A', async () => {
    api.voices.mockResolvedValue([]);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await user.click(await screen.findByRole('button', { name: 'Kloning suara' }));
    const big = new File(['RIFF'], 'long-take.wav', { type: 'audio/wav' });
    Object.defineProperty(big, 'size', { value: 95 * 1024 * 1024 + 1 });
    await user.upload(screen.getByLabelText('Rekaman'), big);
    expect(screen.getByText('Berkas lebih dari 95 MB. Ekspor ulang rekamannya sebagai MP3 atau M4A supaya lebih kecil.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Nama suara'), 'Panjang');
    await user.click(screen.getByRole('checkbox', { name: /Saya pemilik suara ini/ }));
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(createVoice).not.toHaveBeenCalled();
  });

  it('blocks cloning at the plan limit and counts failed voices out', async () => {
    api.voices.mockResolvedValue([voice({ id: 'a' }), voice({ id: 'b', status: 'processing' }), voice({ id: 'c' }), voice({ id: 'd', status: 'failed', errorCode: 'no_clean_speech' })]);
    renderRoutes(routes, { path: '/voices' });
    expect(await screen.findByText('3 dari 3 suara terpakai')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kloning suara' })).toBeDisabled();
    expect(screen.getByTestId('voice-limit')).toHaveTextContent('Batas 3 suara untuk paket kamu sudah penuh.');
    expect(screen.getByText('Rekaman perlu minimal 8 detik ucapan jernih tanpa musik atau jeda panjang.')).toBeInTheDocument();
  });

  it('shows the server reason when the upload is refused', async () => {
    api.voices.mockResolvedValue([]);
    createVoice.mockRejectedValue(new ApiError(403, 'voice_limit_reached', ''));
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    await user.click(await screen.findByRole('button', { name: 'Kloning suara' }));
    await user.upload(screen.getByLabelText('Rekaman'), new File(['RIFF'], 'a.wav', { type: 'audio/wav' }));
    await user.type(screen.getByLabelText('Nama suara'), 'A');
    await user.click(screen.getByRole('checkbox', { name: /Saya pemilik suara ini/ }));
    await user.click(screen.getByRole('button', { name: 'Mulai kloning' }));
    expect(await screen.findByText('Batas suara paket kamu sudah penuh. Hapus satu suara atau upgrade paket.')).toBeInTheDocument();
  });

  it('deletes a voice after an inline confirmation', async () => {
    api.voices.mockResolvedValueOnce([voice()]).mockResolvedValueOnce([]);
    api.deleteVoice.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/voices' });
    const row = await screen.findByTestId('voice-row');
    await user.click(within(row).getByRole('button', { name: 'Hapus suara Pandji' }));
    expect(within(row).getByText('Hapus Pandji? Semua voiceover yang memakai suara ini ikut terhapus.')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Hapus' }));
    expect(api.deleteVoice).toHaveBeenCalledWith('v1');
    expect(await screen.findByText('Belum ada suara')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/voices.test.js src/pages/VoicesPage.test.jsx`
Expected: FAIL, `Failed to resolve import "./voices.js"` / `"./VoicesPage.jsx"`.

- [ ] **Step 3: Write `src/lib/voices.js`**

```js
export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.flac'];
// 95 MB: Cloudflare Free rejects bodies over 100 MB at the edge (controller ruling 2026-10-03); the server enforces the same limit.
export const MAX_AUDIO_BYTES = 95 * 1024 * 1024;

/** Browser-side upload check (spec §8.7); returns an i18n key or null. */
export function audioFileProblem(file) {
  if (!file) return 'voices.form.audio_required';
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (!AUDIO_EXTENSIONS.includes(ext)) return 'voices.form.audio_type';
  if (file.size === 0) return 'voices.form.audio_empty';
  if (file.size > MAX_AUDIO_BYTES) return 'voices.form.audio_size';
  return null;
}

/** Spec §4: the plan limit counts voices in status processing or ready. */
export function countsTowardLimit(voice) {
  return voice.status === 'processing' || voice.status === 'ready';
}
```

- [ ] **Step 4: Write `src/lib/useAudioToggle.js` and `src/components/PlayButton.jsx`**

`src/lib/useAudioToggle.js`:
```js
import { useCallback, useEffect, useRef, useState } from 'react';

let current = null;

/** Plays `src`; starting one clip pauses whichever clip played before. */
export function useAudioToggle(src) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);

  useEffect(() => () => {
    audioRef.current?.pause();
    if (current === audioRef.current) current = null;
  }, []);

  useEffect(() => {
    if (audioRef.current && audioRef.current.dataset.src !== src) {
      audioRef.current.pause();
      audioRef.current = null;
      setPlaying(false);
    }
  }, [src]);

  const toggle = useCallback(async () => {
    if (!src) return;
    if (playing && audioRef.current) {
      audioRef.current.pause();
      return;
    }
    if (!audioRef.current) {
      const audio = new Audio(src);
      audio.dataset.src = src;
      audio.preload = 'auto';
      audio.addEventListener('play', () => setPlaying(true));
      audio.addEventListener('pause', () => setPlaying(false));
      audio.addEventListener('ended', () => setPlaying(false));
      audioRef.current = audio;
    }
    if (current && current !== audioRef.current) current.pause();
    current = audioRef.current;
    try {
      await audioRef.current.play();
    } catch {
      setPlaying(false);
    }
  }, [src, playing]);

  return { playing, toggle };
}
```

`src/components/PlayButton.jsx`:
```jsx
import { PauseIcon, PlayIcon } from '@phosphor-icons/react';
import { useAudioToggle } from '../lib/useAudioToggle.js';

export default function PlayButton({ src, label, testId }) {
  const { playing, toggle } = useAudioToggle(src);
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={!src}
      aria-pressed={playing}
      aria-label={label}
      data-testid={testId}
      className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full border transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.96] disabled:cursor-not-allowed disabled:border-line disabled:text-dim pointer-coarse:size-11 ${playing ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface text-ink hover:border-accent'}`}
    >
      {playing ? <PauseIcon size={18} weight="fill" aria-hidden /> : <PlayIcon size={18} weight="fill" aria-hidden />}
    </button>
  );
}
```

- [ ] **Step 5: Write `src/components/status.jsx`**

```jsx
import { CheckCircleIcon, CircleNotchIcon, StopIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useI18n } from '../i18n/index.jsx';
import { StatusChip } from './ui.jsx';

const JOB = {
  queued: ['neutral', CircleNotchIcon, true],
  running: ['progress', CircleNotchIcon, true],
  done: ['success', CheckCircleIcon, false],
  failed: ['danger', WarningCircleIcon, false],
  canceled: ['neutral', StopIcon, false],
};

export function JobStatus({ status, testId }) {
  const { t } = useI18n();
  const key = JOB[status] ? status : 'queued';
  const [tone, Icon, spinning] = JOB[key];
  return <StatusChip tone={tone} icon={Icon} spinning={spinning} testId={testId} status={status}>{t(`job.status.${key}`)}</StatusChip>;
}

const SENTENCE = {
  pending: ['neutral', null, false],
  running: ['progress', CircleNotchIcon, true],
  done: ['success', CheckCircleIcon, false],
  needs_review: ['warning', WarningCircleIcon, false],
};

export function SentenceStatus({ status }) {
  const { t } = useI18n();
  const key = SENTENCE[status] ? status : 'pending';
  const [tone, Icon, spinning] = SENTENCE[key];
  return <StatusChip tone={tone} icon={Icon} spinning={spinning}>{t(`job.sentence.status.${key}`)}</StatusChip>;
}

const VOICE = {
  processing: ['progress', CircleNotchIcon, true],
  ready: ['success', CheckCircleIcon, false],
  failed: ['danger', WarningCircleIcon, false],
};

export function VoiceStatus({ status }) {
  const { t } = useI18n();
  const key = VOICE[status] ? status : 'processing';
  const [tone, Icon, spinning] = VOICE[key];
  return <StatusChip tone={tone} icon={Icon} spinning={spinning}>{t(`voices.status.${key}`)}</StatusChip>;
}
```

- [ ] **Step 6: Write `src/pages/VoicesPage.jsx`**

```jsx
import { PlusIcon, TrashIcon, UserSoundIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import PlayButton from '../components/PlayButton.jsx';
import { VoiceStatus } from '../components/status.jsx';
import { Button, EmptyState, Field, Notice, PageHeader, Segmented, Skeleton, buttonClass, inputClass } from '../components/ui.jsx';
import { hasKey, useI18n } from '../i18n/index.jsx';
import { api, createVoice } from '../lib/api.js';
import { errorText, voiceErrorText } from '../lib/errors.js';
import { formatBytes, formatDateTime } from '../lib/format.js';
import { formatNumber } from '../lib/pricing.js';
import { useSession } from '../lib/session.jsx';
import { useResource } from '../lib/useResource.js';
import { audioFileProblem, countsTowardLimit } from '../lib/voices.js';

function languageLabel(t, code) {
  return hasKey(`voices.language.${code}`) ? t(`voices.language.${code}`) : String(code ?? '').toUpperCase();
}

export default function VoicesPage() {
  const { t, lang } = useI18n();
  const session = useSession();
  const me = session.me;
  const voices = useResource(() => api.voices(), []);
  const [formOpen, setFormOpen] = useState(false);
  const [created, setCreated] = useState(false);
  const { reload } = voices;
  const list = voices.data ?? [];
  const processing = list.some((v) => v.status === 'processing');

  useEffect(() => {
    if (!processing) return undefined;
    const timer = setInterval(() => {
      reload();
    }, 4000);
    return () => clearInterval(timer);
  }, [processing, reload]);

  const loaded = voices.data !== undefined;
  const used = list.filter(countsTowardLimit).length;
  const limit = me?.voiceLimit ?? 0;
  const atLimit = loaded && used >= limit;

  function onCreated() {
    setFormOpen(false);
    setCreated(true);
    reload();
    session.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('voices.title')}
        subtitle={loaded ? t('voices.usage', { count: formatNumber(used, lang), limit: formatNumber(limit, lang) }) : null}
        actions={formOpen ? null : (
          <Button variant="primary" icon={PlusIcon} disabled={!loaded || atLimit} onClick={() => { setFormOpen(true); setCreated(false); }}>
            {t('voices.clone')}
          </Button>
        )}
      />
      {atLimit ? (
        <Notice
          tone="warning"
          testId="voice-limit"
          action={me?.paid ? null : <a className={buttonClass('secondary', 'sm')} href={me?.topupUrl} target="_blank" rel="noreferrer">{t('voices.upgrade')}</a>}
        >
          {t('voices.limit', { limit: formatNumber(limit, lang) })}
        </Notice>
      ) : null}
      {created ? <Notice tone="success">{t('voices.form.success')}</Notice> : null}
      {formOpen ? <CloneVoiceForm onCancel={() => setFormOpen(false)} onCreated={onCreated} /> : null}
      <VoiceList voices={voices} onDeleted={() => { reload(); session.refresh(); }} />
    </div>
  );
}

function VoiceList({ voices, onDeleted }) {
  const { t } = useI18n();
  if (voices.data === undefined && !voices.error) {
    return <div className="flex flex-col gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[72px]" />)}</div>;
  }
  if (voices.data === undefined) {
    return <Notice tone="danger" action={<Button size="sm" onClick={voices.reload}>{t('common.retry')}</Button>}>{errorText(t, voices.error)}</Notice>;
  }
  if (!voices.data.length) return <EmptyState icon={UserSoundIcon} title={t('voices.empty_title')} body={t('voices.empty_body')} />;
  return (
    <ul className="flex flex-col divide-y divide-line rounded-panel border border-line bg-surface">
      {voices.data.map((v) => <VoiceRow key={v.id} voice={v} onDeleted={onDeleted} />)}
    </ul>
  );
}

function VoiceRow({ voice, onDeleted }) {
  const { t, lang } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteVoice(voice.id);
      onDeleted();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <li data-testid="voice-row" data-status={voice.status} className="flex flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <PlayButton src={voice.status === 'ready' ? voice.previewUrl : null} label={t('voices.preview', { name: voice.name })} />
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{voice.name}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <VoiceStatus status={voice.status} />
            <span>{languageLabel(t, voice.language)}</span>
            {voice.refSeconds ? <span className="font-mono tabular">{t('voices.ref_seconds', { seconds: voice.refSeconds.toFixed(1) })}</span> : null}
            <span>{formatDateTime(voice.createdAt, lang)}</span>
          </p>
          {voice.status === 'failed' ? <p className="mt-1 text-sm text-danger">{voiceErrorText(t, voice.errorCode)}</p> : null}
          {error ? <p className="mt-1 text-sm text-danger" role="alert">{errorText(t, error)}</p> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:shrink-0 md:justify-end">
        {confirming ? (
          <>
            <span className="text-sm text-ink">{t('voices.delete_confirm', { name: voice.name })}</span>
            <Button variant="danger" size="sm" loading={busy} onClick={remove}>{t('common.delete')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" icon={TrashIcon} aria-label={t('voices.delete_named', { name: voice.name })} onClick={() => setConfirming(true)}>
            {t('voices.delete')}
          </Button>
        )}
      </div>
    </li>
  );
}

function CloneVoiceForm({ onCancel, onCreated }) {
  const { t, lang } = useI18n();
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('auto');
  const [transcript, setTranscript] = useState('');
  const [consent, setConsent] = useState(false);
  const [touched, setTouched] = useState({});
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  const fileProblem = audioFileProblem(file);
  const nameProblem = name.trim() ? null : 'voices.form.name_required';
  const fileError = touched.file && fileProblem ? t(fileProblem) : null;
  const nameError = touched.name && nameProblem ? t(nameProblem) : null;
  const consentError = touched.consent && !consent;
  const uploading = progress !== null;
  const languages = [
    { value: 'auto', label: t('voices.language.auto') },
    { value: 'id', label: t('voices.language.id') },
    { value: 'en', label: t('voices.language.en') },
  ];

  async function submit(event) {
    event.preventDefault();
    setTouched({ file: true, name: true, consent: true });
    if (fileProblem || nameProblem || !consent) return;
    setError(null);
    setProgress(0);
    try {
      await createVoice({ file, name: name.trim(), language, transcript: transcript.trim(), consent }, { onProgress: setProgress });
      onCreated();
    } catch (err) {
      setError(err);
      setProgress(null);
    }
  }

  return (
    <form noValidate onSubmit={submit} data-testid="clone-form" className="flex flex-col gap-5 rounded-panel border border-line bg-surface p-5 md:p-6">
      <h2 className="text-lg font-semibold text-ink">{t('voices.form.title')}</h2>
      {error ? <Notice tone="danger">{errorText(t, error)}</Notice> : null}
      <Field id="voice-audio" label={t('voices.form.audio')} help={t('voices.form.audio_help')} error={fileError}>
        <input
          id="voice-audio"
          type="file"
          accept=".mp3,.wav,.m4a,.flac,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/flac"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setTouched((s) => ({ ...s, file: true })); }}
          aria-invalid={fileError ? true : undefined}
          aria-describedby={fileError ? 'voice-audio-error' : 'voice-audio-help'}
          disabled={uploading}
          className="block w-full text-sm text-muted file:mr-3 file:h-11 file:cursor-pointer file:rounded-control file:border file:border-line file:bg-surface-2 file:px-4 file:text-sm file:font-medium file:text-ink hover:file:border-dim"
        />
      </Field>
      {file && !fileProblem ? <p className="-mt-3 font-mono text-sm text-muted">{file.name} · {formatBytes(file.size, lang)}</p> : null}
      <Field id="voice-name" label={t('voices.form.name')} error={nameError}>
        <input
          id="voice-name"
          maxLength={60}
          value={name}
          disabled={uploading}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched((s) => ({ ...s, name: true }))}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? 'voice-name-error' : undefined}
          className={`${inputClass} h-11`}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <span id="voice-language" className="text-sm font-medium text-ink">{t('voices.form.language')}</span>
        <Segmented labelledBy="voice-language" value={language} onChange={setLanguage} options={languages} />
      </div>
      <Field id="voice-transcript" label={t('voices.form.transcript')} help={t('voices.form.transcript_help')}>
        <textarea
          id="voice-transcript"
          rows={3}
          value={transcript}
          disabled={uploading}
          onChange={(e) => setTranscript(e.target.value)}
          aria-describedby="voice-transcript-help"
          className={`${inputClass} py-2 leading-relaxed`}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed text-ink">
          <input
            type="checkbox"
            checked={consent}
            disabled={uploading}
            onChange={(e) => setConsent(e.target.checked)}
            aria-invalid={consentError || undefined}
            aria-describedby={consentError ? 'consent-error' : undefined}
            className="mt-0.5 size-5 shrink-0 cursor-pointer accent-accent"
          />
          <span>{t('voices.form.consent')}</span>
        </label>
        {consentError ? <p id="consent-error" className="text-sm text-danger">{t('error.consent_required')}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" loading={uploading}>
          {uploading ? t('voices.form.uploading', { percent: progress }) : t('voices.form.submit')}
        </Button>
        <Button variant="ghost" disabled={uploading} onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
      {uploading ? (
        <div role="progressbar" aria-label={t('voices.form.upload_progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-1 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full w-full origin-left bg-accent transition-transform duration-300 ease-out" style={{ transform: `scaleX(${progress / 100})` }} />
        </div>
      ) : null}
    </form>
  );
}
```

- [ ] **Step 7: Replace `src/router.jsx`**

```jsx
import AppShell from './components/AppShell.jsx';
import RequireSession from './components/RequireSession.jsx';
import LoginPage from './pages/LoginPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import VoicesPage from './pages/VoicesPage.jsx';

export const routes = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <RequireSession><AppShell /></RequireSession>,
    children: [
      { path: 'voices', element: <VoicesPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 9: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/client/src
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: voices page with consent, plan limit, preview and delete"
```

---

### Task 8: Text to Speech composer (editor, voice, settings, live price, Generate)

**Files:**
- Create: `web/client/src/lib/draft.js`, `web/client/src/pages/TtsPage.jsx`
- Modify: `web/client/src/router.jsx` (full content below)
- Test: `web/client/src/lib/draft.test.js`, `web/client/src/pages/TtsPage.test.jsx`

**Interfaces:**
- Consumes: `api.voices`, `api.estimate`, `api.createJob` (Task 3); `creditsFor`, `rupiahFor`, `charCount`, `formatNumber` (Task 1); `useResource`, `useSession` (Task 5); `useOutletContext().health` (Task 5).
- Produces: `FORMATS`, `DEFAULT_SETTINGS`, `MAX_SCRIPT_CHARS = 20000`, `loadDraft(userId) → {text, voiceId, settings}`, `saveDraft(userId, draft)`, `normalizeSettings(raw)`; index route `/`. After a successful create it navigates to `/jobs/:id` with `location.state.estimatedSeconds`. DOM hooks: `#script` (label "Naskah"/"Script"), `#voice` select (label "Suara"/"Voice"), `[data-testid="price"]`, `[data-testid="balance"]`, `[data-testid="generate"]`.

- [ ] **Step 1: Write the failing tests**

`src/lib/draft.test.js`:
```js
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadDraft, normalizeSettings, saveDraft } from './draft.js';

describe('draft', () => {
  it('starts empty with engine defaults', () => {
    expect(loadDraft('u1')).toEqual({ text: '', voiceId: '', settings: DEFAULT_SETTINGS });
    expect(DEFAULT_SETTINGS).toEqual({ speed: 0.9, pause_sentence_s: 0.45, pause_paragraph_s: 0.8, formats: ['mp3', 'wav', 'srt', 'vtt'] });
  });
  it('keeps one draft per account', () => {
    saveDraft('u1', { text: 'Halo.', voiceId: 'v1', settings: DEFAULT_SETTINGS });
    expect(loadDraft('u1').text).toBe('Halo.');
    expect(loadDraft('u2').text).toBe('');
  });
  it('clamps settings into the engine ranges and drops unknown formats', () => {
    expect(normalizeSettings({ speed: 2, pause_sentence_s: -1, pause_paragraph_s: 'x', formats: ['wav', 'ogg'] }))
      .toEqual({ speed: 1.3, pause_sentence_s: 0, pause_paragraph_s: 0.8, formats: ['wav'] });
  });
  it('survives a corrupted entry', () => {
    window.localStorage.setItem('lqtts_draft:u1', '{nope');
    expect(loadDraft('u1').text).toBe('');
  });
});
```

`src/pages/TtsPage.test.jsx`:
```jsx
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ME, renderRoutes } from '../test/render.jsx';
import TtsPage from './TtsPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { voices: vi.fn(), estimate: vi.fn(), createJob: vi.fn(), me: vi.fn() } };
});
const { api, ApiError } = await import('../lib/api.js');

const ready = { id: 'v1', name: 'Pandji', language: 'id', status: 'ready', errorCode: null, refSeconds: 14, createdAt: '2026-10-03T08:00:00Z', previewUrl: '/api/voices/v1/preview' };
const routes = [
  { path: '/', element: <TtsPage /> },
  { path: '/jobs/:id', element: <p>job page</p> },
  { path: '/voices', element: <p>voices page</p> },
];
const SCRIPT_150 = 'a'.repeat(150);

beforeEach(() => {
  vi.clearAllMocks();
  api.voices.mockResolvedValue([ready]);
  api.me.mockResolvedValue(ME);
  api.estimate.mockImplementation(async (text) => ({ chars: [...text].length, credits: Math.max(1, Math.ceil([...text].length / 100)), rupiah: 0, balance: 240, sentences: 1 }));
});

describe('TtsPage', () => {
  it('shows the live price and balance as the script is typed', async () => {
    const user = userEvent.setup();
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji' });
    expect(screen.getByTestId('price')).toHaveTextContent('Tulis naskah untuk melihat harganya.');
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste(SCRIPT_150);
    expect(screen.getByTestId('price')).toHaveTextContent('Sekitar 2 kredit (Rp200)');
    expect(screen.getByTestId('balance')).toHaveTextContent('Saldo: 240 kredit');
  });

  it('blocks Generate and offers top-up when the balance is too low', async () => {
    const user = userEvent.setup();
    renderRoutes(routes, { me: { ...ME, balance: 1 } });
    api.estimate.mockResolvedValue({ chars: 150, credits: 2, rupiah: 200, balance: 1, sentences: 1 });
    await screen.findByRole('option', { name: 'Pandji' });
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste(SCRIPT_150);
    expect(screen.getByText('Kredit belum cukup untuk naskah ini.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Top up kredit' })).toHaveAttribute('href', ME.topupUrl);
    expect(screen.getByTestId('generate')).toBeDisabled();
  });

  it('sends the script with engine-native settings and opens the job', async () => {
    api.createJob.mockResolvedValue({ id: 'j1', credits: 2, estimatedSeconds: 12 });
    const user = userEvent.setup();
    const { router } = renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji' });
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste('  Halo semua. Ini kalimat kedua.  ');
    await user.click(screen.getByRole('button', { name: 'WAV' }));
    await user.click(screen.getByTestId('generate'));
    expect(api.createJob).toHaveBeenCalledWith('v1', 'Halo semua. Ini kalimat kedua.', {
      speed: 0.9, pause_sentence_s: 0.45, pause_paragraph_s: 0.8, formats: ['mp3', 'srt', 'vtt'],
    });
    expect(await screen.findByText('job page')).toBeInTheDocument();
    expect(router.state.location.state).toEqual({ estimatedSeconds: 12 });
  });

  it('shows an inline top-up prompt when the hold is refused with 402', async () => {
    api.createJob.mockRejectedValue(new ApiError(402, 'insufficient_credits', ''));
    const user = userEvent.setup();
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji' });
    await user.click(screen.getByLabelText('Naskah'));
    await user.paste('Halo semua.');
    await user.click(screen.getByTestId('generate'));
    expect(await screen.findByText('Kredit kamu tidak cukup. Top up dulu di LQ-Studio.')).toBeInTheDocument();
  });

  it('teaches cloning when no voice is ready', async () => {
    api.voices.mockResolvedValue([{ ...ready, status: 'processing' }]);
    renderRoutes(routes);
    expect(await screen.findByText('Kloning suara dulu')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kloning suara' })).toHaveAttribute('href', '/voices');
  });

  it('rejects scripts over 20,000 characters', async () => {
    renderRoutes(routes);
    await screen.findByRole('option', { name: 'Pandji' });
    const box = screen.getByLabelText('Naskah');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, 'a'.repeat(20001));
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(screen.getByText('Naskah maksimal 20.000 karakter. Pendekkan atau bagi menjadi beberapa voiceover.')).toBeInTheDocument();
    expect(screen.getByTestId('generate')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/draft.test.js src/pages/TtsPage.test.jsx`
Expected: FAIL, `Failed to resolve import "./draft.js"` / `"./TtsPage.jsx"`.

- [ ] **Step 3: Write `src/lib/draft.js`**

```js
export const FORMATS = ['mp3', 'wav', 'srt', 'vtt'];
export const MAX_SCRIPT_CHARS = 20000;
export const DEFAULT_SETTINGS = Object.freeze({ speed: 0.9, pause_sentence_s: 0.45, pause_paragraph_s: 0.8, formats: FORMATS });

const keyFor = (userId) => `lqtts_draft:${userId}`;
const clamp = (value, lo, hi, fallback) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback);

export function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    speed: clamp(s.speed, 0.7, 1.3, 0.9),
    pause_sentence_s: clamp(s.pause_sentence_s, 0, 3, 0.45),
    pause_paragraph_s: clamp(s.pause_paragraph_s, 0, 3, 0.8),
    formats: Array.isArray(s.formats) ? FORMATS.filter((f) => s.formats.includes(f)) : [...FORMATS],
  };
}

export function loadDraft(userId) {
  try {
    const raw = JSON.parse(window.localStorage.getItem(keyFor(userId)) ?? 'null');
    if (raw && typeof raw.text === 'string') {
      return { text: raw.text, voiceId: typeof raw.voiceId === 'string' ? raw.voiceId : '', settings: normalizeSettings(raw.settings) };
    }
  } catch {
    // A corrupted draft is discarded.
  }
  return { text: '', voiceId: '', settings: normalizeSettings(DEFAULT_SETTINGS) };
}

export function saveDraft(userId, draft) {
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(draft));
  } catch {
    // Storage full or disabled: the draft only lives in memory.
  }
}
```

- [ ] **Step 4: Write `src/pages/TtsPage.jsx`**

```jsx
import { UserSoundIcon, WaveformIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router';
import { Button, EmptyState, Field, Notice, PageHeader, Select, Skeleton, buttonClass } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { DEFAULT_SETTINGS, FORMATS, MAX_SCRIPT_CHARS, loadDraft, normalizeSettings, saveDraft } from '../lib/draft.js';
import { errorText } from '../lib/errors.js';
import { charCount, creditsFor, formatNumber, rupiahFor } from '../lib/pricing.js';
import { useSession } from '../lib/session.jsx';
import { useResource } from '../lib/useResource.js';

export default function TtsPage() {
  const { t, tn, lang } = useI18n();
  const session = useSession();
  const me = session.me;
  const navigate = useNavigate();
  const { health } = useOutletContext() ?? {};
  const voices = useResource(() => api.voices(), []);
  const [draft, setDraft] = useState(() => loadDraft(me.id));
  const [estimate, setEstimate] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    saveDraft(me.id, draft);
  }, [me.id, draft]);

  const trimmed = draft.text.trim();
  const chars = charCount(trimmed);
  const tooLong = chars > MAX_SCRIPT_CHARS;

  useEffect(() => {
    if (!trimmed || tooLong) {
      setEstimate(null);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const result = await api.estimate(trimmed, controller.signal);
        setEstimate({ ...result, forText: trimmed });
      } catch (err) {
        if (err?.name !== 'AbortError') setEstimate(null);
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, tooLong]);

  const ready = (voices.data ?? []).filter((v) => v.status === 'ready');
  const voiceId = ready.some((v) => v.id === draft.voiceId) ? draft.voiceId : (ready[0]?.id ?? '');
  const fresh = estimate !== null && estimate.forText === trimmed;
  const credits = fresh ? estimate.credits : creditsFor(chars);
  const balance = fresh && estimate.balance != null ? estimate.balance : (me.balance ?? null);
  const short = chars > 0 && balance !== null && credits > balance;
  const lqsDown = health?.lqstudio === 'down';
  const noFormats = draft.settings.formats.length === 0;
  const canGenerate = chars > 0 && !tooLong && voiceId !== '' && !noFormats && !short && !lqsDown && !submitting;
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setSetting = (key, value) => setDraft((d) => ({ ...d, settings: { ...d.settings, [key]: value } }));

  async function generate() {
    setSubmitting(true);
    setError(null);
    try {
      const job = await api.createJob(voiceId, trimmed, normalizeSettings(draft.settings));
      session.refresh();
      navigate(`/jobs/${job.id}`, { state: { estimatedSeconds: job.estimatedSeconds } });
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  }

  const topUp = <a className={buttonClass('primary', 'sm')} href={me.topupUrl} target="_blank" rel="noreferrer">{t('common.topup')}</a>;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('tts.title')} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-8">
        <section className="flex flex-col gap-2">
          <label htmlFor="script" className="text-sm font-medium text-ink">{t('tts.script')}</label>
          <textarea
            id="script"
            data-testid="script"
            value={draft.text}
            onChange={(e) => update({ text: e.target.value })}
            placeholder={t('tts.script_placeholder')}
            spellCheck
            aria-invalid={tooLong || undefined}
            aria-describedby="script-help script-count"
            className="min-h-[22rem] w-full resize-y rounded-panel border border-line bg-surface p-4 text-base leading-relaxed text-ink placeholder:text-dim transition-colors duration-150 hover:border-dim focus-visible:border-accent aria-[invalid=true]:border-danger"
          />
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
            <p id="script-help" className="max-w-[65ch] leading-relaxed text-dim">{t('tts.script_help')}</p>
            <p id="script-count" className={`font-mono tabular ${tooLong ? 'text-danger' : 'text-muted'}`}>
              {t('tts.chars', { count: formatNumber(chars, lang), max: formatNumber(MAX_SCRIPT_CHARS, lang) })}
              {fresh && estimate.sentences > 0 ? ` · ${tn('tts.sentences', estimate.sentences, { count: formatNumber(estimate.sentences, lang) })}` : ''}
            </p>
          </div>
          {tooLong ? <p className="text-sm text-danger" role="alert">{t('tts.text_too_long')}</p> : null}
        </section>

        <aside className="flex flex-col gap-6 lg:sticky lg:top-20">
          <VoicePicker voices={voices} ready={ready} value={voiceId} onChange={(id) => update({ voiceId: id })} />
          <SettingsPanel settings={draft.settings} onSet={setSetting} onReset={() => update({ settings: normalizeSettings(DEFAULT_SETTINGS) })} noFormats={noFormats} />
          <section className="flex flex-col gap-3" aria-live="polite">
            <div className="text-sm">
              <p data-testid="price" className="font-medium text-ink">
                {chars > 0
                  ? tn('tts.price', credits, { credits: formatNumber(credits, lang), rupiah: formatNumber(rupiahFor(credits), lang) })
                  : t('tts.price_empty')}
              </p>
              <p data-testid="balance" className="mt-0.5 text-muted">
                {balance === null ? t('tts.balance_unknown') : tn('tts.balance', balance, { balance: formatNumber(balance, lang) })}
              </p>
            </div>
            {short ? <Notice tone="warning" action={topUp}>{t('tts.topup_needed')}</Notice> : null}
            {error && !short ? (
              error.code === 'insufficient_credits'
                ? <Notice tone="warning" action={topUp}>{errorText(t, error)}</Notice>
                : <Notice tone="danger">{errorText(t, error)}</Notice>
            ) : null}
            {lqsDown ? <Notice tone="warning">{t('tts.lqstudio_down')}</Notice> : null}
            <Button variant="primary" size="lg" icon={WaveformIcon} loading={submitting} disabled={!canGenerate} onClick={generate} data-testid="generate" className="w-full">
              {submitting ? t('tts.generating') : t('tts.generate')}
            </Button>
          </section>
        </aside>
      </div>
    </div>
  );
}

function VoicePicker({ voices, ready, value, onChange }) {
  const { t } = useI18n();
  if (voices.data === undefined && !voices.error) return <Skeleton className="h-[72px]" />;
  if (voices.data === undefined) {
    return <Notice tone="danger" action={<Button size="sm" onClick={voices.reload}>{t('common.retry')}</Button>}>{errorText(t, voices.error)}</Notice>;
  }
  if (!ready.length) {
    return (
      <EmptyState
        icon={UserSoundIcon}
        title={t('tts.empty_voices_title')}
        body={t('tts.empty_voices_body')}
        action={<Link to="/voices" className={buttonClass('primary')}>{t('tts.voice_create')}</Link>}
      />
    );
  }
  return (
    <Field id="voice" label={t('tts.voice')}>
      <Select id="voice" data-testid="voice-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {ready.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      </Select>
    </Field>
  );
}

function RangeField({ id, label, value, min, max, step, display, onChange }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-ink">{label}</label>
        <output htmlFor={id} className="font-mono text-sm tabular text-muted">{display}</output>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-11 w-full cursor-pointer accent-accent" />
    </div>
  );
}

function SettingsPanel({ settings, onSet, onReset, noFormats }) {
  const { t } = useI18n();
  const toggleFormat = (f) => {
    const on = settings.formats.includes(f);
    onSet('formats', on ? settings.formats.filter((x) => x !== f) : FORMATS.filter((x) => x === f || settings.formats.includes(x)));
  };
  return (
    <section className="flex flex-col gap-4 rounded-panel border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{t('tts.settings')}</h2>
        <Button variant="ghost" size="sm" onClick={onReset}>{t('tts.reset')}</Button>
      </div>
      <RangeField id="speed" label={t('tts.speed')} value={settings.speed} min={0.7} max={1.3} step={0.05} display={t('tts.speed_value', { value: settings.speed.toFixed(2) })} onChange={(v) => onSet('speed', v)} />
      <RangeField id="pause-sentence" label={t('tts.pause_sentence')} value={settings.pause_sentence_s} min={0} max={3} step={0.05} display={t('tts.seconds', { value: settings.pause_sentence_s.toFixed(2) })} onChange={(v) => onSet('pause_sentence_s', v)} />
      <RangeField id="pause-paragraph" label={t('tts.pause_paragraph')} value={settings.pause_paragraph_s} min={0} max={3} step={0.05} display={t('tts.seconds', { value: settings.pause_paragraph_s.toFixed(2) })} onChange={(v) => onSet('pause_paragraph_s', v)} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-ink">{t('tts.formats')}</legend>
        <div className="grid grid-cols-4 gap-2">
          {FORMATS.map((f) => {
            const on = settings.formats.includes(f);
            return (
              <button
                key={f}
                type="button"
                aria-pressed={on}
                onClick={() => toggleFormat(f)}
                className={`h-10 rounded-control border text-sm font-medium transition-colors duration-150 pointer-coarse:min-h-11 ${on ? 'border-accent bg-accent-soft text-ink' : 'border-line text-muted hover:border-dim hover:text-ink'}`}
              >
                {f.toUpperCase()}
              </button>
            );
          })}
        </div>
        {noFormats ? <p className="text-sm text-danger" role="alert">{t('tts.formats_required')}</p> : null}
      </fieldset>
    </section>
  );
}
```

- [ ] **Step 5: Replace `src/router.jsx`**

```jsx
import AppShell from './components/AppShell.jsx';
import RequireSession from './components/RequireSession.jsx';
import LoginPage from './pages/LoginPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import TtsPage from './pages/TtsPage.jsx';
import VoicesPage from './pages/VoicesPage.jsx';

export const routes = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <RequireSession><AppShell /></RequireSession>,
    children: [
      { index: true, element: <TtsPage /> },
      { path: 'voices', element: <VoicesPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/client/src
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: text to speech composer with live price"
```

---
### Task 9: Job view (live progress, sentences, play, edit and regenerate, revisions, downloads, cancel, delete)

**Files:**
- Create: `web/client/src/pages/JobPage.jsx`
- Modify: `web/client/src/router.jsx` (full content below)
- Test: `web/client/src/pages/JobPage.test.jsx`

**Interfaces:**
- Consumes: `api.job`, `api.sentences`, `api.regenerate`, `api.cancelJob`, `api.deleteJob`, `openJobEvents`, `urls` (Task 3); `progressReducer`, `doneCount`, `TERMINAL` (Task 4); `JobStatus`, `SentenceStatus`, `PlayButton` (Task 7); `useSession().refresh` (Task 5); `creditsFor`, `charCount` (Task 1).
- Produces: route `/jobs/:id`. DOM hooks used by Playwright: `[data-testid="job-status"][data-status]`, `[data-testid="progress"][data-done][data-total]`, `[data-testid="sentence-<idx>"][data-status]`, play buttons named "Putar kalimat N"/"Play sentence N" with `aria-pressed`, `#revision` (`data-testid="revision-select"`), `[data-testid="download-mp3|wav|srt|vtt"]`, `[data-testid="job-finished"]`, `[data-testid="final-audio"]`.

- [ ] **Step 1: Write the failing test `src/pages/JobPage.test.jsx`**

```jsx
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ME, renderRoutes } from '../test/render.jsx';
import JobPage from './JobPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    api: { job: vi.fn(), sentences: vi.fn(), regenerate: vi.fn(), cancelJob: vi.fn(), deleteJob: vi.fn(), me: vi.fn() },
    openJobEvents: vi.fn(),
  };
});
const { api, openJobEvents } = await import('../lib/api.js');

const job = (over = {}) => ({
  id: 'j1', title: 'Halo semua. Ini kalimat kedua.', voiceId: 'v1', voiceName: 'Pandji', status: 'running', chars: 30, credits: 1,
  audioSeconds: null, revision: 1, createdAt: '2026-10-03T08:00:00Z', finishedAt: null, progress: { done: 0, total: 2 },
  needsReview: 0, settings: { speed: 0.9, pause_sentence_s: 0.45, pause_paragraph_s: 0.8, formats: ['mp3', 'wav', 'srt', 'vtt'] },
  files: {}, revisions: [1], errorCode: null, ...over,
});
const sentence = (idx, status, text = `Kalimat ${idx + 1}.`) => ({
  idx, paragraphIdx: 0, text, style: null, status, score: status === 'pending' ? null : 0.95,
  durationS: status === 'pending' ? null : 1.8, startS: null, endS: null, audioUrl: status === 'pending' ? null : `/api/jobs/j1/sentences/${idx}/audio`,
});
const FILES = {
  'final.mp3': '/api/jobs/j1/files/final.mp3?revision=1', 'final.wav': '/api/jobs/j1/files/final.wav?revision=1',
  'subs.srt': '/api/jobs/j1/files/subs.srt?revision=1', 'subs.vtt': '/api/jobs/j1/files/subs.vtt?revision=1',
};
const routes = [{ path: '/jobs/:id', element: <JobPage /> }, { path: '/history', element: <p>history page</p> }];

let handlers;
let close;
beforeEach(() => {
  vi.clearAllMocks();
  api.me.mockResolvedValue(ME);
  close = vi.fn();
  openJobEvents.mockImplementation((id, h) => {
    handlers = h;
    return close;
  });
});

describe('JobPage', () => {
  it('turns sentences done one by one from live events, then shows downloads', async () => {
    api.job.mockResolvedValue(job());
    api.sentences.mockResolvedValue([sentence(0, 'pending'), sentence(1, 'pending')]);
    renderRoutes(routes, { path: '/jobs/j1' });
    expect(await screen.findByText('0 dari 2 kalimat')).toBeInTheDocument();
    expect(openJobEvents).toHaveBeenCalledWith('j1', expect.any(Object));

    act(() => {
      handlers.onOpen();
      handlers.onEvent({ type: 'sentence_done', idx: 0, status: 'done', score: 0.97, revision: 1 });
    });
    expect(screen.getByText('1 dari 2 kalimat')).toBeInTheDocument();
    expect(screen.getByTestId('sentence-0')).toHaveAttribute('data-status', 'done');
    expect(screen.getByTestId('progress')).toHaveAttribute('data-done', '1');

    api.job.mockResolvedValue(job({ status: 'done', files: FILES, audioSeconds: 4.2 }));
    api.sentences.mockResolvedValue([sentence(0, 'done'), sentence(1, 'done')]);
    act(() => {
      handlers.onEvent({ type: 'sentence_done', idx: 1, status: 'done', score: 0.9, revision: 1 });
      handlers.onEvent({ type: 'job_done', revision: 1 });
    });
    expect(close).toHaveBeenCalled();
    expect(await screen.findByTestId('job-finished')).toBeInTheDocument();
    expect(await screen.findByTestId('download-mp3')).toHaveAttribute('href', '/api/jobs/j1/files/final.mp3?revision=1');
    expect(screen.getByTestId('download-vtt')).toHaveAttribute('download', 'lq-tts-j1-r1.vtt');
    expect(screen.getByTestId('job-status')).toHaveAttribute('data-status', 'done');
  });

  it('regenerates one edited sentence and goes live again', async () => {
    api.job.mockResolvedValue(job({ status: 'done', files: FILES }));
    api.sentences.mockResolvedValue([sentence(0, 'done'), sentence(1, 'done')]);
    api.regenerate.mockResolvedValue({ revision: 2, credits: 1 });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/jobs/j1' });
    const row = await screen.findByTestId('sentence-1');
    expect(openJobEvents).not.toHaveBeenCalled();
    await user.click(within(row).getByRole('button', { name: 'Ubah' }));
    const box = within(row).getByLabelText('Teks kalimat');
    await user.clear(box);
    await user.type(box, 'Kalimat baru yang lebih jelas.');
    expect(within(row).getByText('Biaya 1 kredit')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Buat ulang' }));
    expect(api.regenerate).toHaveBeenCalledWith('j1', 1, { text: 'Kalimat baru yang lebih jelas.' });
    expect(await screen.findByText('Dalam antrean')).toBeInTheDocument();
    expect(screen.getByTestId('sentence-1')).toHaveAttribute('data-status', 'pending');
    expect(openJobEvents).toHaveBeenCalledTimes(1);
  });

  it('explains a failed job and the refund', async () => {
    api.job.mockResolvedValue(job({ status: 'failed', errorCode: 'synthesis_failed' }));
    api.sentences.mockResolvedValue([sentence(0, 'done'), sentence(1, 'pending')]);
    renderRoutes(routes, { path: '/jobs/j1' });
    expect(await screen.findByText('Mesin gagal membuat audio untuk naskah ini. Kredit sudah dikembalikan.')).toBeInTheDocument();
    expect(openJobEvents).not.toHaveBeenCalled();
  });

  it('switches revisions for downloads', async () => {
    api.job.mockResolvedValue(job({ status: 'done', files: FILES, revision: 2, revisions: [1, 2] }));
    api.sentences.mockResolvedValue([sentence(0, 'done'), sentence(1, 'done')]);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/jobs/j1' });
    const select = await screen.findByTestId('revision-select');
    expect(select).toHaveValue('2');
    await user.selectOptions(select, '1');
    expect(screen.getByTestId('download-wav')).toHaveAttribute('href', '/api/jobs/j1/files/final.wav?revision=1');
  });

  it('deletes after an inline confirmation and returns to history', async () => {
    api.job.mockResolvedValue(job({ status: 'done', files: FILES }));
    api.sentences.mockResolvedValue([sentence(0, 'done')]);
    api.deleteJob.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/jobs/j1' });
    await user.click(await screen.findByRole('button', { name: 'Hapus voiceover' }));
    expect(screen.getByText('Hapus voiceover ini beserta semua revisinya? Tindakan ini tidak bisa dibatalkan.')).toBeInTheDocument();
    const confirm = screen.getAllByRole('button', { name: 'Hapus voiceover' }).at(-1);
    await user.click(confirm);
    expect(api.deleteJob).toHaveBeenCalledWith('j1');
    expect(await screen.findByText('history page')).toBeInTheDocument();
  });

  it('shows a not-found state for a foreign or deleted job', async () => {
    const { ApiError } = await import('../lib/api.js');
    api.job.mockRejectedValue(new ApiError(404, 'not_found', ''));
    api.sentences.mockRejectedValue(new ApiError(404, 'not_found', ''));
    renderRoutes(routes, { path: '/jobs/j404' });
    expect(await screen.findByText('Voiceover tidak ditemukan')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/pages/JobPage.test.jsx`
Expected: FAIL, `Failed to resolve import "./JobPage.jsx"`.

- [ ] **Step 3: Write `src/pages/JobPage.jsx`**

```jsx
import { ArrowLeftIcon, ArrowsClockwiseIcon, DownloadSimpleIcon, PencilSimpleIcon, StopIcon, TrashIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import PlayButton from '../components/PlayButton.jsx';
import { JobStatus, SentenceStatus } from '../components/status.jsx';
import { Button, EmptyState, Field, Notice, Select, Skeleton, buttonClass, inputClass } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { api, openJobEvents, urls } from '../lib/api.js';
import { errorText, jobFailureText } from '../lib/errors.js';
import { formatDateTime, formatDuration } from '../lib/format.js';
import { charCount, creditsFor, formatNumber } from '../lib/pricing.js';
import { TERMINAL, doneCount, progressReducer } from '../lib/progress.js';
import { useSession } from '../lib/session.jsx';

const FILE_ORDER = ['final.mp3', 'final.wav', 'subs.srt', 'subs.vtt'];
const FILE_LABELS = { 'final.mp3': 'MP3', 'final.wav': 'WAV', 'subs.srt': 'SRT', 'subs.vtt': 'VTT' };
const extOf = (name) => name.split('.').pop();

export default function JobPage() {
  const { id } = useParams();
  const { t, tn, lang } = useI18n();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [job, setJob] = useState(null);
  const [sentences, setSentences] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [progress, dispatch] = useReducer(progressReducer, null);
  const [connection, setConnection] = useState('idle');
  const [revision, setRevision] = useState(null);
  const [justFinished, setJustFinished] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const estimatedSeconds = location.state?.estimatedSeconds ?? null;

  const load = useCallback(async () => {
    try {
      const [nextJob, nextSentences] = await Promise.all([api.job(id), api.sentences(id)]);
      setJob(nextJob);
      setSentences(nextSentences);
      setRevision(nextJob.revision);
      setLoadError(null);
      dispatch({ type: 'snapshot', job: nextJob, sentences: nextSentences });
    } catch (err) {
      setLoadError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const status = progress?.status ?? null;
  const live = status !== null && !TERMINAL.has(status);

  useEffect(() => {
    if (!live) return undefined;
    let finished = false;
    setConnection('connecting');
    const close = openJobEvents(id, {
      onOpen: () => setConnection('live'),
      onError: () => {
        if (!finished) setConnection('reconnecting');
      },
      onEvent: (event) => {
        dispatch(event);
        if (event.type === 'job_done' || event.type === 'job_failed') {
          finished = true;
          close();
          setConnection('idle');
          setCanceling(false);
          if (event.type === 'job_done') setJustFinished(true);
          load();
          refresh();
        }
      },
    });
    return () => {
      finished = true;
      close();
    };
  }, [id, live, load, refresh]);

  function onRegenerated(idx, result) {
    dispatch({ type: 'regenerate_started', idx, revision: result.revision });
    setJustFinished(false);
    setActionError(null);
    refresh();
  }

  async function cancel() {
    setCanceling(true);
    setActionError(null);
    try {
      await api.cancelJob(id);
    } catch (err) {
      setActionError(err);
      setCanceling(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setActionError(null);
    try {
      await api.deleteJob(id);
      refresh();
      navigate('/history', { replace: true });
    } catch (err) {
      setActionError(err);
      setDeleting(false);
    }
  }

  if (loadError && !job) {
    if (loadError.code === 'not_found') {
      return (
        <EmptyState
          icon={WarningCircleIcon}
          title={t('job.not_found_title')}
          body={t('job.not_found_body')}
          action={<Link to="/history" className={buttonClass('secondary')}>{t('nav.history')}</Link>}
        />
      );
    }
    return <Notice tone="danger" action={<Button size="sm" onClick={load}>{t('common.retry')}</Button>}>{errorText(t, loadError)}</Notice>;
  }
  if (!job || !sentences || !progress) return <JobSkeleton />;

  const total = progress.total;
  const done = doneCount(progress);
  const files = FILE_ORDER.filter((name) => job.files?.[name]);
  const audioName = files.find((name) => name === 'final.mp3' || name === 'final.wav') ?? null;
  const shownRevision = revision ?? job.revision;
  const needsReview = TERMINAL.has(status) ? Object.values(progress.sentences).filter((s) => s.status === 'needs_review').length : 0;
  const downloadName = (name) => `lq-tts-${job.id.slice(0, 8)}-r${shownRevision}.${extOf(name)}`;

  return (
    <div className="flex flex-col gap-6">
      <Link to="/" className="inline-flex w-fit items-center gap-2 text-sm text-muted transition-colors duration-150 hover:text-ink">
        <ArrowLeftIcon size={16} aria-hidden />
        {t('job.back')}
      </Link>

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-ink [overflow-wrap:anywhere]">{job.title}</h1>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
          <span>{job.voiceName ?? t('history.voice_deleted')}</span>
          <span>{formatDateTime(job.createdAt, lang)}</span>
          <span className="font-mono tabular">{tn('job.chars', job.chars, { count: formatNumber(job.chars, lang) })}</span>
          <span className="font-mono tabular">{tn('job.credits', job.credits, { count: formatNumber(job.credits, lang) })}</span>
          {job.audioSeconds ? <span className="font-mono tabular">{formatDuration(job.audioSeconds)}</span> : null}
        </p>
      </header>

      <section aria-labelledby="progress-heading" className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-4 md:p-5">
        <h2 id="progress-heading" className="sr-only">{t('job.progress_heading')}</h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <JobStatus status={status} testId="job-status" />
          <p className="font-mono text-sm tabular text-muted" aria-live="polite">
            {t('job.progress', { done: formatNumber(done, lang), total: formatNumber(total, lang) })}
          </p>
        </div>
        <div
          data-testid="progress"
          data-done={done}
          data-total={total}
          role="progressbar"
          aria-label={t('job.progress_heading')}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          className="h-2 overflow-hidden rounded-full bg-surface-2"
        >
          <div className="h-full w-full origin-left rounded-full bg-accent transition-transform duration-300 ease-out" style={{ transform: `scaleX(${total ? done / total : 0})` }} />
        </div>
        {live ? (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
            <span>
              {connection === 'reconnecting'
                ? t('job.reconnecting')
                : estimatedSeconds && progress.revision === 1
                  ? t('job.estimate', { time: formatDuration(estimatedSeconds) })
                  : t('job.live')}
            </span>
            <Button size="sm" icon={StopIcon} loading={canceling} onClick={cancel}>{t('job.cancel')}</Button>
          </div>
        ) : null}
        {justFinished && status === 'done' ? <Notice tone="success" testId="job-finished">{t('job.done_notice')}</Notice> : null}
        {status === 'failed' || status === 'canceled' ? (
          <Notice tone={status === 'canceled' ? 'info' : 'danger'}>{jobFailureText(t, status, progress.errorCode)}</Notice>
        ) : null}
        {needsReview > 0 ? <Notice tone="warning">{tn('job.needs_review', needsReview, { count: formatNumber(needsReview, lang) })}</Notice> : null}
        {actionError ? <Notice tone="danger">{errorText(t, actionError)}</Notice> : null}
      </section>

      {files.length ? (
        <section aria-labelledby="output-heading" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="output-heading" className="text-lg font-semibold text-ink">{t('job.output')}</h2>
            {job.revisions.length > 1 ? (
              <div className="w-44">
                <label htmlFor="revision" className="sr-only">{t('job.revision')}</label>
                <Select id="revision" data-testid="revision-select" value={String(shownRevision)} onChange={(e) => setRevision(Number(e.target.value))}>
                  {[...job.revisions].reverse().map((r) => <option key={r} value={String(r)}>{t('job.revision_n', { n: r })}</option>)}
                </Select>
              </div>
            ) : null}
          </div>
          {audioName ? (
            <audio key={`${audioName}-${shownRevision}`} data-testid="final-audio" controls preload="metadata" src={urls.file(id, audioName, shownRevision)} className="w-full" />
          ) : null}
          <div className="flex flex-wrap gap-2">
            {files.map((name) => (
              <a key={name} href={urls.file(id, name, shownRevision)} download={downloadName(name)} data-testid={`download-${extOf(name)}`} className={buttonClass('secondary')}>
                <DownloadSimpleIcon size={18} aria-hidden />
                {FILE_LABELS[name]}
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="sentences-heading" className="flex flex-col gap-3">
        <h2 id="sentences-heading" className="text-lg font-semibold text-ink">{t('job.sentences')}</h2>
        <ol className="flex flex-col divide-y divide-line rounded-panel border border-line bg-surface">
          {sentences.map((s) => (
            <SentenceRow
              key={s.idx}
              jobId={id}
              sentence={s}
              live={progress.sentences[s.idx]}
              arrived={progress.lastArrived === s.idx}
              audioVersion={progress.revision}
              editable={!live}
              onRegenerated={onRegenerated}
            />
          ))}
        </ol>
      </section>

      <section className="flex flex-wrap items-center gap-3 border-t border-line pt-6">
        {confirmDelete ? (
          <>
            <p className="text-sm text-ink">{t('job.delete_confirm')}</p>
            <Button variant="danger" loading={deleting} onClick={remove}>{t('job.delete')}</Button>
            <Button variant="ghost" disabled={deleting} onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
          </>
        ) : (
          <Button variant="ghost" icon={TrashIcon} onClick={() => setConfirmDelete(true)}>{t('job.delete')}</Button>
        )}
      </section>
    </div>
  );
}

function SentenceRow({ jobId, sentence, live, arrived, audioVersion, editable, onRegenerated }) {
  const { t, tn, lang } = useI18n();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(sentence.text);
  const [style, setStyle] = useState(sentence.style ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!editing) {
      setText(sentence.text);
      setStyle(sentence.style ?? '');
    }
  }, [editing, sentence.text, sentence.style]);

  const status = live?.status ?? sentence.status;
  const score = live ? live.score : sentence.score;
  const finished = status === 'done' || status === 'needs_review';
  const n = sentence.idx + 1;
  const nextText = text.trim();
  const credits = creditsFor(charCount(nextText));
  const base = `s${sentence.idx}`;

  async function regenerate(event) {
    event.preventDefault();
    if (!nextText) return;
    setBusy(true);
    setError(null);
    try {
      const changes = {};
      if (nextText !== sentence.text) changes.text = nextText;
      const nextStyle = style.trim();
      if (nextStyle !== (sentence.style ?? '')) changes.style = nextStyle;
      const result = await api.regenerate(jobId, sentence.idx, changes);
      setEditing(false);
      onRegenerated(sentence.idx, result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li data-testid={`sentence-${sentence.idx}`} data-status={status} className={`flex gap-3 px-3 py-3 md:px-4 ${arrived ? 'animate-arrive' : ''}`}>
      <span className="w-7 shrink-0 pt-2 text-right font-mono text-sm tabular text-dim">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-4">
          <div className="min-w-0 pt-1.5">
            {sentence.style ? <p className="mb-1 text-xs text-dim">{t('job.sentence.style_label', { style: sentence.style })}</p> : null}
            <p className="max-w-[70ch] text-base leading-relaxed text-ink">{sentence.text}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <SentenceStatus status={status} />
              {finished && score != null ? <span className="font-mono tabular">{t('job.sentence.score', { score: Math.round(score * 100) })}</span> : null}
              {finished && sentence.durationS ? <span className="font-mono tabular">{formatDuration(sentence.durationS)}</span> : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <PlayButton src={finished ? urls.sentenceAudio(jobId, sentence.idx, audioVersion) : null} label={t('job.sentence.play', { n })} />
            <Button
              variant="ghost"
              size="sm"
              icon={PencilSimpleIcon}
              disabled={!editable}
              aria-expanded={editing}
              aria-controls={`${base}-editor`}
              onClick={() => setEditing((v) => !v)}
            >
              {t('job.sentence.edit')}
            </Button>
          </div>
        </div>
        {editing ? (
          <form id={`${base}-editor`} onSubmit={regenerate} className="mt-3 flex flex-col gap-4 rounded-control bg-surface-2 p-4">
            <Field id={`${base}-text`} label={t('job.sentence.text')} help={t('job.sentence.one_sentence')}>
              <textarea id={`${base}-text`} rows={2} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={`${base}-text-help`} className={`${inputClass} py-2 leading-relaxed`} />
            </Field>
            <Field id={`${base}-style`} label={t('job.sentence.style')}>
              <input id={`${base}-style`} value={style} placeholder={t('job.sentence.style_placeholder')} onChange={(e) => setStyle(e.target.value)} className={`${inputClass} h-11`} />
            </Field>
            {error ? <Notice tone="danger">{errorText(t, error)}</Notice> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" icon={ArrowsClockwiseIcon} loading={busy} disabled={!nextText || !editable}>{t('job.sentence.regenerate')}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
              <span className="text-sm text-muted">{tn('job.sentence.regenerate_price', credits, { count: formatNumber(credits, lang) })}</span>
            </div>
          </form>
        ) : null}
      </div>
    </li>
  );
}

function JobSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-9 w-3/4" />
      <Skeleton className="h-28" />
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Replace `src/router.jsx`**

```jsx
import AppShell from './components/AppShell.jsx';
import RequireSession from './components/RequireSession.jsx';
import JobPage from './pages/JobPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import TtsPage from './pages/TtsPage.jsx';
import VoicesPage from './pages/VoicesPage.jsx';

export const routes = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <RequireSession><AppShell /></RequireSession>,
    children: [
      { index: true, element: <TtsPage /> },
      { path: 'jobs/:id', element: <JobPage /> },
      { path: 'voices', element: <VoicesPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/client/src
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: job view with live progress, regenerate, revisions and downloads"
```

---

### Task 10: History and Credits

**Files:**
- Create: `web/client/src/lib/download.js`, `web/client/src/pages/HistoryPage.jsx`, `web/client/src/pages/CreditsPage.jsx`
- Modify: `web/client/src/router.jsx` (final content below)
- Test: `web/client/src/pages/HistoryPage.test.jsx`, `web/client/src/pages/CreditsPage.test.jsx`

**Interfaces:**
- Consumes: `api.jobs`, `api.job`, `api.deleteJob`, `api.credits`, `urls.file` (Task 3); `JobStatus` (Task 7); `useResource` (Task 5).
- Produces: `triggerDownload(href, filename)`; routes `/history`, `/credits`. DOM hooks: `[data-testid="history-row"][data-job-id]`, `[data-testid="usage-row"][data-job-id]`, `[data-testid="credits-balance"]`, `[data-testid="topup"]`.

- [ ] **Step 1: Write the failing tests**

`src/pages/HistoryPage.test.jsx`:
```jsx
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoutes } from '../test/render.jsx';
import HistoryPage from './HistoryPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { jobs: vi.fn(), job: vi.fn(), deleteJob: vi.fn() } };
});
const { api } = await import('../lib/api.js');

const summary = (id, over = {}) => ({
  id, title: `Naskah ${id}`, voiceId: 'v1', voiceName: 'Pandji', status: 'done', chars: 1234, credits: 13,
  audioSeconds: 75.2, revision: 1, createdAt: '2026-10-03T08:00:00Z', finishedAt: '2026-10-03T08:01:00Z', ...over,
});
const routes = [{ path: '/history', element: <HistoryPage /> }, { path: '/', element: <p>tts page</p> }];

beforeEach(() => vi.clearAllMocks());

describe('HistoryPage', () => {
  it('lists voiceovers and pages with nextBefore', async () => {
    api.jobs
      .mockResolvedValueOnce({ items: [summary('a'), summary('b', { voiceName: null, status: 'failed' })], nextBefore: '2026-10-02T00:00:00Z' })
      .mockResolvedValueOnce({ items: [summary('c')], nextBefore: null });
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/history' });
    expect(await screen.findByRole('link', { name: 'Naskah a' })).toHaveAttribute('href', '/jobs/a');
    expect(screen.getAllByText(/Suara terhapus/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Muat lagi' }));
    expect(api.jobs).toHaveBeenLastCalledWith({ limit: 20, before: '2026-10-02T00:00:00Z' });
    expect(await screen.findByRole('link', { name: 'Naskah c' })).toBeInTheDocument();
    expect(screen.getAllByTestId('history-row')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Muat lagi' })).not.toBeInTheDocument();
  });

  it('deletes a row after confirmation', async () => {
    api.jobs.mockResolvedValue({ items: [summary('a')], nextBefore: null });
    api.deleteJob.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRoutes(routes, { path: '/history' });
    const row = await screen.findByTestId('history-row');
    await user.click(within(row).getByRole('button', { name: 'Hapus Naskah a' }));
    await user.click(within(row).getByRole('button', { name: 'Hapus voiceover' }));
    expect(api.deleteJob).toHaveBeenCalledWith('a');
    expect(await screen.findByText('Belum ada voiceover')).toBeInTheDocument();
  });

  it('teaches the first action when empty', async () => {
    api.jobs.mockResolvedValue({ items: [], nextBefore: null });
    renderRoutes(routes, { path: '/history' });
    expect(await screen.findByRole('link', { name: 'Buat voiceover pertama' })).toHaveAttribute('href', '/');
  });
});
```

`src/pages/CreditsPage.test.jsx`:
```jsx
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderRoutes } from '../test/render.jsx';
import CreditsPage from './CreditsPage.jsx';

vi.mock('../lib/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, api: { credits: vi.fn() } };
});
const { api } = await import('../lib/api.js');

const routes = [{ path: '/credits', element: <CreditsPage /> }];

describe('CreditsPage', () => {
  it('shows the shared balance, the top-up link and TTS usage', async () => {
    api.credits.mockResolvedValue({
      balance: 1234,
      topupUrl: 'https://lq-studio.com/upgrade-plan',
      usage: [
        { id: 'c1', jobId: 'j1', title: 'Halo semua', kind: 'job', chars: 150, credits: 2, state: 'settled', createdAt: '2026-10-03T08:00:00Z' },
        { id: 'c2', jobId: 'j1', title: 'Halo semua', kind: 'regenerate', chars: 40, credits: 1, state: 'refunded', createdAt: '2026-10-03T08:05:00Z' },
      ],
    });
    renderRoutes(routes, { path: '/credits' });
    expect(await screen.findByTestId('credits-balance')).toHaveTextContent('1.234 kredit');
    expect(screen.getByText('Rp123.400')).toBeInTheDocument();
    expect(screen.getByTestId('topup')).toHaveAttribute('href', 'https://lq-studio.com/upgrade-plan');
    expect(screen.getAllByTestId('usage-row')).toHaveLength(2);
    expect(screen.getByText('Buat ulang kalimat')).toBeInTheDocument();
    expect(screen.getByText('Dikembalikan')).toBeInTheDocument();
  });

  it('handles an unknown balance when LQ-Studio is down', async () => {
    api.credits.mockResolvedValue({ balance: null, topupUrl: 'https://lq-studio.com/upgrade-plan', usage: [] });
    renderRoutes(routes, { path: '/credits' });
    expect(await screen.findByTestId('credits-balance')).toHaveTextContent('Belum terbaca');
    expect(screen.getByText('Belum ada pemakaian')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/pages/HistoryPage.test.jsx src/pages/CreditsPage.test.jsx`
Expected: FAIL, `Failed to resolve import "./HistoryPage.jsx"` / `"./CreditsPage.jsx"`.

- [ ] **Step 3: Write `src/lib/download.js`**

```js
/** Starts a same-origin download without navigating away. */
export function triggerDownload(href, filename) {
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}
```

- [ ] **Step 4: Write `src/pages/HistoryPage.jsx`**

```jsx
import { ClockCounterClockwiseIcon, DownloadSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { JobStatus } from '../components/status.jsx';
import { Button, EmptyState, Notice, PageHeader, Skeleton, buttonClass } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { api, urls } from '../lib/api.js';
import { triggerDownload } from '../lib/download.js';
import { errorText } from '../lib/errors.js';
import { formatDateTime, formatDuration } from '../lib/format.js';
import { formatNumber } from '../lib/pricing.js';

const PAGE_SIZE = 20;

export default function HistoryPage() {
  const { t } = useI18n();
  const [items, setItems] = useState(null);
  const [nextBefore, setNextBefore] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (before = null) => {
    const page = await api.jobs({ limit: PAGE_SIZE, before });
    setItems((prev) => (before && prev ? [...prev, ...page.items] : page.items));
    setNextBefore(page.nextBefore ?? null);
  }, []);

  const firstLoad = useCallback(() => {
    setError(null);
    load().catch(setError);
  }, [load]);

  useEffect(() => {
    firstLoad();
  }, [firstLoad]);

  async function more() {
    setLoadingMore(true);
    try {
      await load(nextBefore);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }

  const remove = (id) => setItems((prev) => prev.filter((j) => j.id !== id));

  let body;
  if (items === null && !error) {
    body = <div className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>;
  } else if (items === null) {
    body = <Notice tone="danger" action={<Button size="sm" onClick={firstLoad}>{t('common.retry')}</Button>}>{errorText(t, error)}</Notice>;
  } else if (!items.length) {
    body = (
      <EmptyState
        icon={ClockCounterClockwiseIcon}
        title={t('history.empty_title')}
        body={t('history.empty_body')}
        action={<Link to="/" className={buttonClass('primary')}>{t('history.empty_cta')}</Link>}
      />
    );
  } else {
    body = (
      <>
        <div className="overflow-hidden rounded-panel border border-line bg-surface">
          <table className="w-full table-fixed text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">{t('history.col.voiceover')}</th>
                <th scope="col" className="hidden w-36 px-4 py-3 font-medium md:table-cell">{t('history.col.status')}</th>
                <th scope="col" className="hidden w-28 px-4 py-3 text-right font-medium lg:table-cell">{t('history.col.chars')}</th>
                <th scope="col" className="hidden w-24 px-4 py-3 text-right font-medium lg:table-cell">{t('history.col.credits')}</th>
                <th scope="col" className="hidden w-24 px-4 py-3 text-right font-medium md:table-cell">{t('history.col.duration')}</th>
                <th scope="col" className="w-28 px-4 py-3 text-right font-medium lg:w-40"><span className="sr-only">{t('history.col.actions')}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((j) => <HistoryRow key={j.id} job={j} onDeleted={() => remove(j.id)} />)}
            </tbody>
          </table>
        </div>
        {error ? <Notice tone="danger">{errorText(t, error)}</Notice> : null}
        {nextBefore ? (
          <Button className="self-center" loading={loadingMore} onClick={more}>{t('common.load_more')}</Button>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('history.title')} />
      {body}
    </div>
  );
}

function HistoryRow({ job, onDeleted }) {
  const { t, lang } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteJob(job.id);
      onDeleted();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function download() {
    setDownloading(true);
    setError(null);
    try {
      const detail = await api.job(job.id);
      const name = ['final.mp3', 'final.wav'].find((n) => detail.files?.[n]);
      if (!name) throw { code: 'not_found' };
      triggerDownload(urls.file(job.id, name, detail.revision), `lq-tts-${job.id.slice(0, 8)}-r${detail.revision}.${name.split('.').pop()}`);
    } catch (err) {
      setError(err);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <tr data-testid="history-row" data-job-id={job.id} className="align-top">
      <td className="px-4 py-3">
        <Link to={`/jobs/${job.id}`} className="font-medium text-ink transition-colors duration-150 [overflow-wrap:anywhere] hover:text-accent">{job.title}</Link>
        <p className="mt-0.5 text-xs text-muted">{job.voiceName ?? t('history.voice_deleted')} · {formatDateTime(job.createdAt, lang)}</p>
        <div className="mt-1 md:hidden"><JobStatus status={job.status} /></div>
        {error ? <p className="mt-1 text-xs text-danger" role="alert">{errorText(t, error)}</p> : null}
      </td>
      <td className="hidden px-4 py-3 md:table-cell"><JobStatus status={job.status} /></td>
      <td className="hidden px-4 py-3 text-right font-mono tabular lg:table-cell">{formatNumber(job.chars, lang)}</td>
      <td className="hidden px-4 py-3 text-right font-mono tabular lg:table-cell">{formatNumber(job.credits, lang)}</td>
      <td className="hidden px-4 py-3 text-right font-mono tabular md:table-cell">{formatDuration(job.audioSeconds)}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap justify-end gap-1">
          {confirming ? (
            <>
              <Button variant="danger" size="sm" loading={busy} onClick={remove}>{t('job.delete')}</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" icon={DownloadSimpleIcon} disabled={job.status !== 'done'} loading={downloading} onClick={download} aria-label={t('history.download_named', { title: job.title })}>
                <span className="hidden lg:inline">{t('common.download')}</span>
              </Button>
              <Button variant="ghost" size="sm" icon={TrashIcon} onClick={() => setConfirming(true)} aria-label={t('history.delete_named', { title: job.title })} />
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
```

- [ ] **Step 5: Write `src/pages/CreditsPage.jsx`**

```jsx
import { ArrowSquareOutIcon, CoinsIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { Button, EmptyState, Notice, PageHeader, Skeleton, StatusChip, buttonClass } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { errorText } from '../lib/errors.js';
import { formatDateTime } from '../lib/format.js';
import { formatNumber, formatRupiah, rupiahFor } from '../lib/pricing.js';
import { useResource } from '../lib/useResource.js';

const STATE_TONE = { held: 'progress', settled: 'neutral', refunded: 'success' };

export default function CreditsPage() {
  const { t, tn, lang } = useI18n();
  const credits = useResource(() => api.credits(), []);
  const data = credits.data;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t('credits.title')} subtitle={t('credits.shared')} />
      {data === undefined && !credits.error ? <Skeleton className="h-32" /> : null}
      {data === undefined && credits.error ? (
        <Notice tone="danger" action={<Button size="sm" onClick={credits.reload}>{t('common.retry')}</Button>}>{errorText(t, credits.error)}</Notice>
      ) : null}
      {data ? (
        <>
          <section aria-labelledby="balance-heading" className="flex flex-col gap-4 rounded-panel border border-line bg-surface p-5 md:flex-row md:items-center md:justify-between md:p-6">
            <div>
              <h2 id="balance-heading" className="text-sm font-medium text-muted">{t('credits.balance')}</h2>
              <p data-testid="credits-balance" className="mt-1 text-2xl font-semibold tabular text-ink">
                {data.balance == null ? t('credits.balance_unknown') : tn('credits.balance_value', data.balance, { count: formatNumber(data.balance, lang) })}
              </p>
              {data.balance != null ? <p className="mt-0.5 font-mono text-sm tabular text-muted">{formatRupiah(rupiahFor(data.balance), lang)}</p> : null}
              <p className="mt-2 text-xs text-dim">{t('credits.rate')}</p>
            </div>
            <a data-testid="topup" href={data.topupUrl} target="_blank" rel="noreferrer" className={buttonClass('primary', 'lg')}>
              {t('common.topup')}
              <ArrowSquareOutIcon size={18} aria-hidden />
            </a>
          </section>

          <section aria-labelledby="usage-heading" className="flex flex-col gap-3">
            <h2 id="usage-heading" className="text-lg font-semibold text-ink">{t('credits.usage')}</h2>
            {data.usage.length === 0 ? (
              <EmptyState icon={CoinsIcon} title={t('credits.empty_title')} body={t('credits.empty_body')} />
            ) : (
              <div className="overflow-hidden rounded-panel border border-line bg-surface">
                <table className="w-full table-fixed text-left text-sm">
                  <thead className="border-b border-line text-xs text-muted">
                    <tr>
                      <th scope="col" className="hidden w-44 px-4 py-3 font-medium md:table-cell">{t('credits.col.date')}</th>
                      <th scope="col" className="px-4 py-3 font-medium">{t('credits.col.voiceover')}</th>
                      <th scope="col" className="hidden w-44 px-4 py-3 font-medium md:table-cell">{t('credits.col.kind')}</th>
                      <th scope="col" className="hidden w-28 px-4 py-3 text-right font-medium lg:table-cell">{t('credits.col.chars')}</th>
                      <th scope="col" className="w-20 px-4 py-3 text-right font-medium">{t('credits.col.credits')}</th>
                      <th scope="col" className="w-32 px-4 py-3 font-medium">{t('credits.col.state')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.usage.map((row) => (
                      <tr key={row.id} data-testid="usage-row" data-job-id={row.jobId ?? ''} className="align-top">
                        <td className="hidden px-4 py-3 text-muted md:table-cell">{formatDateTime(row.createdAt, lang)}</td>
                        <td className="px-4 py-3">
                          {row.jobId ? (
                            <Link to={`/jobs/${row.jobId}`} className="text-ink [overflow-wrap:anywhere] hover:text-accent">{row.title}</Link>
                          ) : (
                            <span className="text-ink">{row.title}</span>
                          )}
                          <p className="mt-0.5 text-xs text-muted md:hidden">{t(`credits.kind.${row.kind === 'regenerate' ? 'regenerate' : 'job'}`)} · {formatDateTime(row.createdAt, lang)}</p>
                        </td>
                        <td className="hidden px-4 py-3 text-muted md:table-cell">{t(`credits.kind.${row.kind === 'regenerate' ? 'regenerate' : 'job'}`)}</td>
                        <td className="hidden px-4 py-3 text-right font-mono tabular lg:table-cell">{formatNumber(row.chars, lang)}</td>
                        <td className="px-4 py-3 text-right font-mono tabular">{formatNumber(row.credits, lang)}</td>
                        <td className="px-4 py-3">
                          <StatusChip tone={STATE_TONE[row.state] ?? 'neutral'}>{t(`credits.state.${STATE_TONE[row.state] ? row.state : 'held'}`)}</StatusChip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Replace `src/router.jsx` (final)**

```jsx
import AppShell from './components/AppShell.jsx';
import RequireSession from './components/RequireSession.jsx';
import CreditsPage from './pages/CreditsPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import JobPage from './pages/JobPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import TtsPage from './pages/TtsPage.jsx';
import VoicesPage from './pages/VoicesPage.jsx';

export const routes = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <RequireSession><AppShell /></RequireSession>,
    children: [
      { index: true, element: <TtsPage /> },
      { path: 'jobs/:id', element: <JobPage /> },
      { path: 'voices', element: <VoicesPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'credits', element: <CreditsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
```

- [ ] **Step 7: Run the full client suite and build**

Run: `npx vitest run`
Expected: PASS, every file (Tasks 1–10), 0 failed.

Run: `npm run build`
Expected: `✓ built`, no warnings. Then confirm no em dash reached the bundle:

Run: `node -e "const fs=require('fs');const files=fs.readdirSync('dist/assets').filter(f=>f.endsWith('.js'));const hit=files.filter(f=>fs.readFileSync('dist/assets/'+f,'utf8').includes('\u2014'));console.log(hit.length?'EM DASH IN '+hit.join(','):'no em dash')"`
Expected: `no em dash` (if a dependency bundles one in non-UI code, inspect it and record the reason; UI strings come only from the dictionaries, which the i18n test already guards).

- [ ] **Step 8: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/client/src
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/client: history and credits pages"
```

---

### Task 11: Playwright journey on mac-studio (local target: real server + real engine + fake LQ-Studio)

**Files:**
- Create: `web/ops/env-lib.mjs`, `web/ops/env-lib.test.mjs`, `web/e2e/package.json` (via npm), `web/e2e/.gitignore`, `web/e2e/playwright.config.js`, `web/e2e/target.mjs`, `web/e2e/harness/fake-lqstudio.mjs`, `web/e2e/harness/run-server.mjs`, `web/e2e/harness/totp.mjs`, `web/e2e/harness/totp.test.mjs`, `web/e2e/harness/layout.mjs`, `web/e2e/tests/fixtures.js`, `web/e2e/tests/journey.spec.js`, `web/e2e/tests/screens.spec.js`, `web/e2e/tests/smoke.spec.js`

**Interfaces:**
- Consumes: plan 2B server (`web/server/index.js`, env names in Dependencies), `startFakeLqStudio` from `web/server/test/fakes/fake-lqstudio.js`, `web/.env.stg` (engine caller `lq-tts-stg`, `DATABASE_URL`), the running engine at `127.0.0.1:8740`, `data/fixtures/pandji/VO-Sample-Pandji.mp3`; built client `web/client/dist`; DOM hooks from Tasks 5–10.
- Produces: `parseEnvText(text)`, `readEnvFile(path)`, `serializeEnv(obj)`, `writeEnvFile(path, obj)` (mode 600, atomic), `setEnvKey(path, key, value)`, `parsePairs(raw)`, `toContainerDatabaseUrl(url)`, `toHostDatabaseUrl(url)` (`ops/env-lib.mjs`); `totp(secret, nowMs?)`, `msUntilNextStep(nowMs?)`; `E2E_TARGET` = `local` (default) | `staging-public` | `prod`; Playwright projects `journey` → `screens`, and `smoke`; screenshots under `web/e2e/artifacts/<viewport>/<screen>.png`.

- [ ] **Step 1: Write the failing node tests for env handling and TOTP**

`web/ops/env-lib.test.mjs`:
```js
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnvText, parsePairs, readEnvFile, setEnvKey, toContainerDatabaseUrl, toHostDatabaseUrl, writeEnvFile } from './env-lib.mjs';

test('parses comments, blanks, quotes and = inside values', () => {
  const env = parseEnvText('# c\n\nA=1\nB="two words"\nC=\'x=y\'\nD=a=b\n bad line\n');
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x=y', D: 'a=b' });
});

test('writes mode 600 atomically and round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envlib-'));
  const file = join(dir, 'x.env');
  writeEnvFile(file, { A: '1' });
  setEnvKey(file, 'B', 'secret-value');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readEnvFile(file), { A: '1', B: 'secret-value' });
  assert.equal(readFileSync(file, 'utf8'), 'A=1\nB=secret-value\n');
});

test('refuses newlines and bad keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envlib-'));
  assert.throws(() => writeEnvFile(join(dir, 'y.env'), { A: 'x\ny' }), /newline/);
  assert.throws(() => writeEnvFile(join(dir, 'y.env'), { 'a-b': 'x' }), /bad key/);
});

test('parses engine caller pairs like the engine does (first colon splits)', () => {
  assert.deepEqual(parsePairs('lq-tts:abc, lq-studio:d:e ,'), { 'lq-tts': 'abc', 'lq-studio': 'd:e' });
  assert.throws(() => parsePairs('broken'), /name:value/);
});

test('rewrites the database host for containers and back, keeping credentials', () => {
  const url = 'postgresql://lq_tts_web:p%40ss%2Fw0rd@127.0.0.1:5432/lq_tts';
  const inContainer = toContainerDatabaseUrl(url);
  assert.equal(inContainer, 'postgresql://lq_tts_web:p%40ss%2Fw0rd@host.internal:5432/lq_tts');
  assert.equal(toHostDatabaseUrl(inContainer), url);
  assert.equal(toContainerDatabaseUrl('postgresql://u:p@localhost:5432/lq_tts'), 'postgresql://u:p@host.internal:5432/lq_tts');
});
```

`web/e2e/harness/totp.test.mjs`:
```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32Decode, msUntilNextStep, totp } from './totp.mjs';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32("12345678901234567890"), RFC 6238 SHA-1 vectors

test('decodes base32', () => {
  assert.equal(base32Decode(RFC_SECRET).toString('ascii'), '12345678901234567890');
});

test('matches RFC 6238 SHA-1 vectors (last 6 digits)', () => {
  assert.equal(totp(RFC_SECRET, 59_000), '287082');
  assert.equal(totp(RFC_SECRET, 1_111_111_109_000), '081804');
  assert.equal(totp(RFC_SECRET, 1_234_567_890_000), '005924');
});

test('reports the wait until the next 30 s window', () => {
  assert.equal(msUntilNextStep(59_000), 1_000);
  assert.equal(msUntilNextStep(60_000), 30_000);
});
```

Run: `cd ~/Developer/LQ-TTS/web && node --test ops/env-lib.test.mjs e2e/harness/totp.test.mjs`
Expected: FAIL, `Cannot find module '.../ops/env-lib.mjs'` and `.../harness/totp.mjs`.

- [ ] **Step 2: Implement `web/ops/env-lib.mjs`**

```js
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const KEY = /^[A-Z][A-Z0-9_]*$/;

export function parseEnvText(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readEnvFile(path) {
  return existsSync(path) ? parseEnvText(readFileSync(path, 'utf8')) : {};
}

export function serializeEnv(obj) {
  return `${Object.entries(obj).map(([key, value]) => {
    if (!KEY.test(key)) throw new Error(`bad key ${key}`);
    const text = String(value);
    if (/[\r\n]/.test(text)) throw new Error(`value for ${key} contains a newline`);
    return `${key}=${text}`;
  }).join('\n')}\n`;
}

/** Atomic write, mode 600 (never world-readable, even for a moment). */
export function writeEnvFile(path, obj) {
  const body = serializeEnv(obj);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function setEnvKey(path, key, value) {
  const current = readEnvFile(path);
  current[key] = value;
  writeEnvFile(path, current);
}

/** `name:value,name:value` exactly like engine/lq_tts_engine/config.py `_pairs` (first colon splits). */
export function parsePairs(raw) {
  const out = {};
  for (const item of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const colon = item.indexOf(':');
    if (colon < 1 || colon === item.length - 1) throw new Error('expected name:value pairs');
    out[item.slice(0, colon)] = item.slice(colon + 1);
  }
  return out;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Containers reach the host's Postgres through OrbStack's host.internal. */
export function toContainerDatabaseUrl(url) {
  const u = new URL(url);
  if (LOOPBACK.has(u.hostname)) u.hostname = 'host.internal';
  return u.toString();
}

/** host.internal does not resolve on the macOS host itself. */
export function toHostDatabaseUrl(url) {
  const u = new URL(url);
  if (u.hostname === 'host.internal') u.hostname = '127.0.0.1';
  return u.toString();
}
```

- [ ] **Step 3: Install Playwright and implement `web/e2e/harness/totp.mjs`**

```bash
mkdir -p ~/Developer/LQ-TTS/web/e2e/harness ~/Developer/LQ-TTS/web/e2e/tests ~/Developer/LQ-TTS/web/e2e/staging
cd ~/Developer/LQ-TTS/web/e2e
npm init -y >/dev/null
npm pkg set name=lq-tts-web-e2e private=true type=module
npm pkg delete main description keywords author license scripts.test
npm pkg set scripts.test="playwright test"
npm install --save-exact --save-dev @playwright/test@1.63.0
npx playwright install chromium
```
Expected: `added 3 packages`; `chromium … downloaded` (or already present in `~/Library/Caches/ms-playwright`).

`web/e2e/.gitignore`:
```
node_modules/
test-results/
report/
artifacts/
.state.json
.auth.json
```

`web/e2e/harness/totp.mjs`:
```js
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

export function base32Decode(input) {
  const clean = input.replace(/=+$/u, '').replace(/\s+/gu, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error('invalid base32 secret');
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP, SHA-1, 6 digits, 30 s (what LQ-Studio's otplib authenticator uses). */
export function totp(secret, nowMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / STEP_MS)));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function msUntilNextStep(nowMs = Date.now()) {
  return STEP_MS - (nowMs % STEP_MS);
}
```

Run: `cd ~/Developer/LQ-TTS/web && node --test ops/env-lib.test.mjs e2e/harness/totp.test.mjs`
Expected: PASS, 8 tests, `# fail 0`.

- [ ] **Step 4: Write `web/e2e/target.mjs`**

```js
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../ops/env-lib.mjs';
import { totp } from './harness/totp.mjs';

export const LOCAL_PORT = 8760;
export const FAKE_LQS_PORT = 8798;
export const FAKE_LQS_TOKEN = 'e2e-fake-lqstudio-token-not-a-secret-0001';
export const SAMPLE_AUDIO = fileURLToPath(new URL('../../data/fixtures/pandji/VO-Sample-Pandji.mp3', import.meta.url));
export const STATE_FILE = fileURLToPath(new URL('./.state.json', import.meta.url));
export const AUTH_FILE = fileURLToPath(new URL('./.auth.json', import.meta.url));
export const STAGING_CREDENTIALS = join(homedir(), '.config/lq-tts/e2e-staging.env');

export const LOCAL_USERS = [
  {
    id: 'e2e-u1', name: 'Rara Wibisono', email: 'rara.e2e@example.com', username: 'e2e-rara', password: 'e2e-pass-7391',
    totp: '482913', verified: true, suspended: false, plan: 'free', paid: false, balance: 2400,
  },
];

export const TARGET = process.env.E2E_TARGET ?? 'local';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for E2E_TARGET=${TARGET}`);
  return value;
}

export function targetConfig() {
  if (TARGET === 'local') {
    return {
      baseURL: `http://127.0.0.1:${LOCAL_PORT}`,
      headers: {},
      webServer: [
        { command: 'node harness/fake-lqstudio.mjs', port: FAKE_LQS_PORT, reuseExistingServer: false, timeout: 20_000 },
        { command: 'node harness/run-server.mjs', url: `http://127.0.0.1:${LOCAL_PORT}/api/health`, reuseExistingServer: false, timeout: 90_000 },
      ],
    };
  }
  if (TARGET === 'staging-public') {
    return {
      baseURL: 'https://tts-stg.lq-studio.com',
      headers: { 'CF-Access-Client-Id': required('CF_ACCESS_CLIENT_ID'), 'CF-Access-Client-Secret': required('CF_ACCESS_CLIENT_SECRET') },
      webServer: undefined,
    };
  }
  if (TARGET === 'prod') return { baseURL: 'https://tts.lq-studio.com', headers: {}, webServer: undefined };
  throw new Error(`unknown E2E_TARGET ${TARGET}`);
}

/** Login data: a fixed fake user locally, the seeded staging account otherwise. */
export function credentials() {
  if (TARGET === 'local') {
    const u = LOCAL_USERS[0];
    return { identifier: u.username, password: u.password, code: () => u.totp };
  }
  if (!existsSync(STAGING_CREDENTIALS)) throw new Error(`missing ${STAGING_CREDENTIALS} (Task 14 seeds it)`);
  const env = readEnvFile(STAGING_CREDENTIALS);
  return { identifier: env.LQTTS_E2E_IDENTIFIER, password: env.LQTTS_E2E_PASSWORD, code: () => totp(env.LQTTS_E2E_TOTP_SECRET) };
}
```

- [ ] **Step 5: Write the two harness launchers**

`web/e2e/harness/fake-lqstudio.mjs`:
```js
import { startFakeLqStudio } from '../../server/test/fakes/fake-lqstudio.js';
import { FAKE_LQS_PORT, FAKE_LQS_TOKEN, LOCAL_USERS } from '../target.mjs';

const fake = await startFakeLqStudio({ port: FAKE_LQS_PORT, token: FAKE_LQS_TOKEN, users: LOCAL_USERS });
process.stdout.write(`fake LQ-Studio listening at ${fake.url}\n`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await fake.close();
    process.exit(0);
  });
}
```

`web/e2e/harness/run-server.mjs`:
```js
// Runs the real plan-2B server natively for Playwright: real engine (caller lq-tts-stg) and real Postgres
// (throwaway schema lq_tts_web_e2e, dropped first), fake LQ-Studio. Secrets are read from web/.env.stg and never printed.
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEnvFile, toHostDatabaseUrl } from '../../ops/env-lib.mjs';
import { FAKE_LQS_PORT, FAKE_LQS_TOKEN, LOCAL_PORT } from '../target.mjs';

const webDir = fileURLToPath(new URL('../../', import.meta.url));
const base = readEnvFile(fileURLToPath(new URL('../../.env.stg', import.meta.url)));
for (const key of ['DATABASE_URL', 'ENGINE_TOKEN', 'ENGINE_CALLBACK_SECRET']) {
  if (!base[key]) throw new Error(`web/.env.stg lacks ${key} (plan 2B setup)`);
}

const SCHEMA = 'lq_tts_web_e2e';
execFileSync('/opt/homebrew/opt/postgresql@16/bin/psql', ['-d', 'lq_tts', '-v', 'ON_ERROR_STOP=1', '-qc', `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`], { stdio: 'inherit' });

const env = {
  ...process.env,
  ...base,
  HOST: '127.0.0.1',
  PORT: String(LOCAL_PORT),
  DB_SCHEMA: SCHEMA,
  DATABASE_URL: toHostDatabaseUrl(base.DATABASE_URL),
  ENGINE_URL: 'http://127.0.0.1:8740',
  ENGINE_CALLBACK_URL: `http://127.0.0.1:${LOCAL_PORT}/api/internal/engine-callback`,
  LQSTUDIO_URL: `http://127.0.0.1:${FAKE_LQS_PORT}`,
  LQSTUDIO_TOKEN: FAKE_LQS_TOKEN,
  LQSTUDIO_PUBLIC_URL: 'https://demo.lq-studio.com',
  COOKIE_SECURE: 'false',
  CLIENT_DIST: fileURLToPath(new URL('../../client/dist', import.meta.url)),
};

const child = spawn(process.execPath, ['server/index.js'], { cwd: webDir, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
```

- [ ] **Step 6: Write `web/e2e/playwright.config.js` and the guard fixture**

`web/e2e/playwright.config.js`:
```js
import { defineConfig, devices } from '@playwright/test';
import { targetConfig } from './target.mjs';

const target = targetConfig();

export default defineConfig({
  testDir: './tests',
  timeout: 360_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: target.baseURL,
    extraHTTPHeaders: target.headers,
    viewport: { width: 1440, height: 900 },
    locale: 'id-ID',
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'journey', testMatch: /journey\.spec\.js/ },
    { name: 'screens', testMatch: /screens\.spec\.js/, dependencies: ['journey'] },
    { name: 'smoke', testMatch: /smoke\.spec\.js/ },
  ],
  webServer: target.webServer,
});
```

`web/e2e/tests/fixtures.js`:
```js
import { test as base, expect } from '@playwright/test';

// Explained, expected aborts: media elements cancel range requests when their source changes, the EventSource
// is closed when a job finishes or the page navigates, a superseded debounced estimate is aborted on purpose,
// and Chromium reports file downloads as aborted navigations.
function explainedAbort(request, errorText) {
  if (errorText !== 'net::ERR_ABORTED') return false;
  const url = request.url();
  return ['media', 'eventsource'].includes(request.resourceType())
    || /\/api\/jobs\/estimate$/.test(url)
    || /\/api\/jobs\/[^/]+\/files\//.test(url)
    || /\/api\/jobs\/[^/]+\/events$/.test(url);
}

export const test = base.extend({
  guard: [async ({ page }, use, testInfo) => {
    const problems = [];
    const expected = [];
    const watch = (p) => {
      p.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`console.${msg.type()}: ${msg.text()} @ ${msg.location().url}`);
      });
      p.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
      p.on('requestfailed', (req) => {
        const errorText = req.failure()?.errorText ?? 'unknown';
        if (!explainedAbort(req, errorText)) problems.push(`requestfailed: ${req.method()} ${req.url()} ${errorText}`);
      });
      p.on('response', (res) => {
        if (res.status() >= 400 && !expected.some((fn) => fn(res))) problems.push(`http ${res.status()}: ${res.request().method()} ${res.url()}`);
      });
    };
    watch(page);
    await use({ watch, expect: (fn) => expected.push(fn), problems });
    await testInfo.attach('console-network.json', { body: JSON.stringify(problems, null, 2), contentType: 'application/json' });
    expect(problems, 'console and network must be clean (SOP G5)').toEqual([]);
  }, { auto: true }],
});

export { expect };
```

- [ ] **Step 7: Write the layout probe `web/e2e/harness/layout.mjs`**

```js
import { expect } from '@playwright/test';

/** Real measurements (getBoundingClientRect), never computed widths (SOP G4). */
export async function measure(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el || !visible(el)) return null;
      const r = el.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height) };
    };
    const targets = [...document.querySelectorAll('button, select, textarea, input[type="text"], input[type="password"], input:not([type]), input[type="range"], nav a')]
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { what: `${el.tagName.toLowerCase()} ${(el.getAttribute('aria-label') || el.textContent || el.id || '').trim().slice(0, 40)}`, height: Math.round(r.height) };
      });
    return {
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', '')),
      sidebar: box('[data-testid="sidebar"]'),
      bottomNav: box('[data-testid="bottom-nav"]'),
      targets,
    };
  });
}

export async function assertLayout(page, viewport, { touch = false } = {}) {
  const m = await measure(page);
  expect(m.overflowX, `no horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(0);
  expect(m.fonts, 'Space Grotesk is actually rendered').toContain('Space Grotesk Variable');
  if (touch) {
    const small = m.targets.filter((t) => t.height < 44);
    expect(small, 'touch targets are at least 44 px tall').toEqual([]);
  }
  return m;
}
```

- [ ] **Step 8: Write the journey `web/e2e/tests/journey.spec.js` (spec §9)**

```js
import { statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_FILE, SAMPLE_AUDIO, STATE_FILE, TARGET, credentials } from '../target.mjs';
import { msUntilNextStep } from '../harness/totp.mjs';
import { expect, test } from './fixtures.js';

const SCRIPT = [
  'Halo, ini uji suara dari LQ TTS untuk memastikan semuanya berjalan dengan baik.',
  'Kalimat kedua memastikan progres tampil satu per satu di layar.',
  'Terima kasih sudah mendengarkan sampai selesai.',
].join(' ');
const NEW_SECOND = 'Kalimat kedua sekarang dibuat ulang dengan teks yang baru.';

async function apiCall(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'lq-tts' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  }, { method, path, body });
}

async function enterTwoFactor(page, creds, guard) {
  const code = page.getByLabel('Kode', { exact: true });
  await code.fill(creds.code());
  await page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
  if (TARGET === 'local') return;
  // LQ-Studio refuses a TOTP step it has already seen (replay protection). If a recent run used this window, wait for the next one.
  const error = page.getByTestId('login-error');
  if (await error.isVisible({ timeout: 3_000 }).catch(() => false)) {
    guard.expect((res) => res.status() === 401 && res.url().endsWith('/api/auth/2fa'));
    await page.waitForTimeout(msUntilNextStep() + 1_000);
    await code.fill(creds.code());
    await page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
  }
}

test('journey: login with 2FA, clone, generate, live progress, regenerate, download, ID and EN', async ({ page, guard }) => {
  const creds = credentials();

  // 1. Login with 2FA
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Masuk ke LQ TTS', exact: true })).toBeVisible();
  await page.getByLabel('Email atau username', { exact: true }).fill(creds.identifier);
  await page.getByLabel('Kata sandi', { exact: true }).fill(creds.password);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Verifikasi dua langkah', exact: true })).toBeVisible();
  await enterTwoFactor(page, creds, guard);
  await expect(page.getByRole('heading', { level: 1, name: 'Teks ke Suara', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');

  // Leftovers of an earlier failed run must not eat the Free plan's 3-voice limit.
  const before = await apiCall(page, 'GET', '/voices');
  for (const v of before.json.filter((x) => x.name.startsWith('E2E '))) await apiCall(page, 'DELETE', `/voices/${v.id}`);

  // 2. Clone a voice (consent is required)
  await page.getByRole('link', { name: 'Suara', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Suara', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Kloning suara', exact: true }).click();
  const voiceName = `E2E Pandji ${Date.now().toString(36)}`;
  // Too large is refused in the browser before any upload (95 MB + 1 byte, sparse file, no network request).
  const tooBig = join(tmpdir(), 'lq-tts-e2e-too-big.mp3');
  writeFileSync(tooBig, '');
  truncateSync(tooBig, 95 * 1024 * 1024 + 1);
  await page.getByLabel('Rekaman', { exact: true }).setInputFiles(tooBig);
  await expect(page.getByText('Berkas lebih dari 95 MB. Ekspor ulang rekamannya sebagai MP3 atau M4A supaya lebih kecil.', { exact: true })).toBeVisible();
  await page.getByLabel('Rekaman', { exact: true }).setInputFiles(SAMPLE_AUDIO);
  await expect(page.getByText('Berkas lebih dari 95 MB. Ekspor ulang rekamannya sebagai MP3 atau M4A supaya lebih kecil.', { exact: true })).toHaveCount(0);
  await page.getByLabel('Nama suara', { exact: true }).fill(voiceName);
  await page.getByRole('radio', { name: 'Indonesia', exact: true }).click();
  await page.getByRole('button', { name: 'Mulai kloning', exact: true }).click();
  await expect(page.getByText('Centang persetujuan dulu sebelum mengkloning suara.', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: /^Saya pemilik suara ini/ }).check();
  await page.getByRole('button', { name: 'Mulai kloning', exact: true }).click();
  const voiceRow = page.getByTestId('voice-row').filter({ hasText: voiceName });
  await expect(voiceRow).toHaveAttribute('data-status', 'ready', { timeout: 240_000 });
  const preview = voiceRow.getByRole('button', { name: `Dengarkan contoh ${voiceName}`, exact: true });
  await preview.click();
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  await preview.click();
  await expect(preview).toHaveAttribute('aria-pressed', 'false');

  // 3. Generate with the live price
  await page.getByRole('link', { name: 'Teks ke Suara', exact: true }).click();
  await page.getByLabel('Naskah', { exact: true }).fill(SCRIPT);
  await expect(page.getByLabel('Naskah', { exact: true })).toHaveValue(SCRIPT);
  await page.getByLabel('Suara', { exact: true }).selectOption({ label: voiceName });
  const credits = Math.max(1, Math.ceil([...SCRIPT].length / 100));
  await expect(page.getByTestId('price')).toHaveText(`Sekitar ${credits} kredit (Rp${(credits * 100).toLocaleString('id-ID')})`);
  const events = page.waitForResponse((r) => /\/api\/jobs\/[^/]+\/events$/.test(r.url()) && (r.headers()['content-type'] ?? '').startsWith('text/event-stream'));
  await page.getByTestId('generate').click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobId = new URL(page.url()).pathname.split('/').pop();
  await events;

  // 4. Live progress: sentences turn done one by one
  const progress = page.getByTestId('progress');
  const seen = new Set();
  await expect.poll(async () => {
    const done = Number(await progress.getAttribute('data-done'));
    const total = Number(await progress.getAttribute('data-total'));
    seen.add(`${done}/${total}`);
    return total > 0 && done === total ? 'complete' : 'pending';
  }, { timeout: 300_000, intervals: [100] }).toBe('complete');
  const partial = [...seen].some((v) => { const [d, t] = v.split('/').map(Number); return d > 0 && d < t; });
  expect(partial, `a partial state was rendered live: ${[...seen].join(', ')}`).toBe(true);
  await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  await expect(page.getByTestId('job-finished')).toBeVisible();

  // 5. Play one sentence
  const play1 = page.getByTestId('sentence-0').getByRole('button', { name: 'Putar kalimat 1', exact: true });
  await play1.click();
  await expect(play1).toHaveAttribute('aria-pressed', 'true');
  await play1.click();

  // 6. Edit and regenerate one sentence, revision 2 appears
  const s1 = page.getByTestId('sentence-1');
  await s1.getByRole('button', { name: 'Ubah', exact: true }).click();
  const box = s1.getByLabel('Teks kalimat', { exact: true });
  await box.fill(NEW_SECOND);
  await expect(box).toHaveValue(NEW_SECOND);
  await s1.getByRole('button', { name: 'Buat ulang', exact: true }).click();
  await expect(page.getByTestId('job-status')).not.toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done', { timeout: 240_000 });
  await expect(page.getByTestId('revision-select')).toHaveValue('2');
  await expect(page.getByTestId('sentence-1')).toContainText(NEW_SECOND);

  // 7. Download MP3 of the current revision
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-mp3').click()]);
  expect(download.suggestedFilename()).toMatch(/\.mp3$/);
  expect(statSync(await download.path()).size).toBeGreaterThan(10_000);

  // 8. ID ⇄ EN, persisted on the server session
  await page.getByTestId('account-button').click();
  await page.getByRole('radio', { name: 'English', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Voices', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Sentences', exact: true })).toBeVisible();

  // 9. History and Credits reflect the job and both charges
  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page.locator(`[data-testid="history-row"][data-job-id="${jobId}"]`)).toHaveCount(1);
  await page.getByRole('link', { name: 'Credits', exact: true }).click();
  await expect(page.locator(`[data-testid="usage-row"][data-job-id="${jobId}"]`)).toHaveCount(2);

  // Back to Indonesian for the screenshot pass, keep the session for it.
  const back = await apiCall(page, 'PATCH', '/me', { lang: 'id' });
  expect(back.status).toBe(200);
  writeFileSync(STATE_FILE, JSON.stringify({ jobId, voiceName }));
  await page.context().storageState({ path: AUTH_FILE });
});
```

- [ ] **Step 9: Write `web/e2e/tests/screens.spec.js` (390 / 768 / 1440, dark; light at 1440)**

```js
import { mkdirSync, readFileSync } from 'node:fs';
import { assertLayout } from '../harness/layout.mjs';
import { AUTH_FILE, STATE_FILE } from '../target.mjs';
import { expect, test } from './fixtures.js';

const VIEWPORTS = [
  { name: '390', width: 390, height: 844, touch: true },
  { name: '768', width: 768, height: 1024, touch: false },
  { name: '1440', width: 1440, height: 900, touch: false },
];

test.describe.configure({ mode: 'serial' });

async function settle(page) {
  await expect(page.locator('[data-skeleton]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

async function shot(page, viewport, name) {
  const dir = new URL(`../artifacts/${viewport.name}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: new URL(`${name}.png`, dir).pathname, fullPage: true });
}

for (const vp of VIEWPORTS) {
  test(`screens at ${vp.name}px`, async ({ browser, guard, baseURL, extraHTTPHeaders }) => {
    const { jobId, voiceName } = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    // browser.newContext() does not inherit `use` options, so baseURL and the Access headers are passed explicitly.
    const contextOptions = { baseURL, extraHTTPHeaders, viewport: { width: vp.width, height: vp.height }, colorScheme: 'dark', locale: 'id-ID', isMobile: vp.touch, hasTouch: vp.touch };

    const anon = await browser.newContext(contextOptions);
    const loginPage = await anon.newPage();
    guard.watch(loginPage);
    await loginPage.goto('/login');
    await expect(loginPage.getByRole('heading', { level: 1, name: 'Masuk ke LQ TTS', exact: true })).toBeVisible();
    await settle(loginPage);
    await assertLayout(loginPage, vp, { touch: vp.touch });
    await shot(loginPage, vp, 'login');
    await anon.close();

    const context = await browser.newContext({ ...contextOptions, storageState: AUTH_FILE });
    const page = await context.newPage();
    guard.watch(page);
    const screens = [
      ['tts', '/', 'Teks ke Suara'],
      ['job', `/jobs/${jobId}`, null],
      ['voices', '/voices', 'Suara'],
      ['history', '/history', 'Riwayat'],
      ['credits', '/credits', 'Kredit'],
    ];
    for (const [name, path, heading] of screens) {
      await page.goto(path);
      if (heading) await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
      else await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done');
      await settle(page);
      const m = await assertLayout(page, vp, { touch: vp.touch });
      if (vp.width === 1440) expect(m.sidebar?.width).toBe(232);
      if (vp.width === 768) expect(m.sidebar?.width).toBe(72);
      if (vp.width === 390) {
        expect(m.sidebar).toBeNull();
        expect(m.bottomNav?.height).toBe(64);
      }
      await shot(page, vp, name);
    }

    if (vp.width === 1440) {
      await page.emulateMedia({ colorScheme: 'light' });
      for (const [name, path] of [['tts-light', '/'], ['job-light', `/jobs/${jobId}`]]) {
        await page.goto(path);
        await settle(page);
        await shot(page, vp, name);
      }
      await page.emulateMedia({ colorScheme: 'dark' });
      // Cleanup: deleting the voice also deletes its voiceovers (engine rule), so it runs last.
      await page.goto('/voices');
      const row = page.getByTestId('voice-row').filter({ hasText: voiceName });
      await row.getByRole('button', { name: `Hapus suara ${voiceName}`, exact: true }).click();
      await row.getByRole('button', { name: 'Hapus', exact: true }).click();
      await expect(row).toHaveCount(0);
    }
    await context.close();
  });
}
```

- [ ] **Step 10: Write `web/e2e/tests/smoke.spec.js` (public smoke, used for PROD)**

```js
import { mkdirSync } from 'node:fs';
import { assertLayout } from '../harness/layout.mjs';
import { expect, test } from './fixtures.js';

test('public smoke: health, login page at 3 widths, wrong password reaches LQ-Studio', async ({ page, guard }) => {
  const health = await page.request.get('/api/health');
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ engine: 'ok', lqstudio: 'ok' });

  const dir = new URL('../artifacts/smoke/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const vp of [{ name: '390', width: 390, height: 844 }, { name: '768', width: 768, height: 1024 }, { name: '1440', width: 1440, height: 900 }]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'Masuk ke LQ TTS', exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await assertLayout(page, vp);
    await page.screenshot({ path: new URL(`login-${vp.name}.png`, dir).pathname, fullPage: true });
  }

  // Expected 401: a made-up account proves the browser → web → LQ-Studio internal API chain answers.
  guard.expect((res) => res.status() === 401 && res.url().endsWith('/api/auth/login'));
  await page.getByLabel('Email atau username', { exact: true }).fill('tts-smoke-no-such-user');
  await page.getByLabel('Kata sandi', { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page.getByTestId('login-error')).toHaveText('Email/username atau kata sandi salah.');
});
```

- [ ] **Step 11: Build the client and run the local journey (SOP G5)**

Run (mac-studio):
```bash
export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH
cd ~/Developer/LQ-TTS/web && npm ci && (cd client && npm run build)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8740/v1/health
cd e2e && npx playwright test --project=journey --project=screens --project=smoke
```
Expected: health `200`; Playwright `5 passed` (1 journey + 3 screens + 1 smoke), `0 failed`. The smoke test locally answers `401` from the fake LQ-Studio exactly like PROD would. If the engine reports `restarting`, wait for `/v1/health` 200 first (model load ≈ 70 s).

On failure: open `web/e2e/report/index.html` (trace + `console-network.json` attachment), fix the cause, rerun from the top of this step (SOP G5: until it works, not "better").

- [ ] **Step 12: Review the evidence**

Open every PNG in `web/e2e/artifacts/{390,768,1440}/` (login, tts, job, voices, history, credits, plus `tts-light`, `job-light`) and check against the Design direction and `craft-floor.md`: contrast, spacing rhythm, one accent, no clipped text, CTA labels on one line, focus ring visible when tabbing (run `npx playwright test --project=journey --headed` once and Tab through the login form). Fix in one batch, rerun Step 11 once, stop polishing (impeccable: bounded passes).

- [ ] **Step 13: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/ops/env-lib.mjs web/ops/env-lib.test.mjs web/e2e/package.json web/e2e/package-lock.json web/e2e/.gitignore web/e2e/playwright.config.js web/e2e/target.mjs web/e2e/harness web/e2e/tests
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/e2e: Playwright journey, screens and smoke with console and network guard"
```

---
### Task 12: Container image, compose and staging container on OrbStack

**Files:**
- Create: `web/Dockerfile`, `web/.dockerignore`, `web/compose.yaml`, `web/ops/env-set.mjs`, `web/ops/env-container.mjs`, `web/ops/env-check.mjs`
- Outside git (mode 600): `~/.config/lq-tts/web-stg.env` on mac-studio

**Interfaces:**
- Consumes: plan 2B server and env names; `web/.env.stg` (plan 2B); `ops/env-lib.mjs` (Task 11); plan 2A staging token in `/home/lq/lq-studio-stg/.env` on lq-server.
- Produces: image `lq-tts-web:stg` (also tagged `lq-tts-web:<git short sha>`), container `lq-tts-web-stg` on `127.0.0.1:8750` (inside: `HOST=0.0.0.0`, `PORT=8080`), container secrets file with exactly `DATABASE_URL` (host `host.internal`), `ENGINE_TOKEN`, `ENGINE_CALLBACK_SECRET`, `LQSTUDIO_TOKEN`; CLI `node ops/env-set.mjs <file> <KEY>` (value on stdin), `node ops/env-container.mjs --from <native env> --to <container env> [--engine-env <engine/.env> --engine-caller <name>]`, `node ops/env-check.mjs <file> KEY...`.

- [ ] **Step 1: Check the brain and the prerequisites**

Run (mac-studio): `python3 ~/brain/_brain/bin/brain-task.py check "lq-tts web"`
Expected: no open task owned by another agent for the same work (if one exists, stop and coordinate).

Run (mac-studio):
```bash
cd ~/Developer/LQ-TTS && git branch --show-current
cd web && npm test 2>&1 | grep -E '^ *(Test Files|Tests) '
curl -s -o /dev/null -w 'engine %{http_code}\n' http://127.0.0.1:8740/v1/health
curl -s -o /dev/null -w 'lqs-stg %{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' http://100.80.128.19:3112/api/internal/tts/auth/verify
```
Expected: `feat/web-app`; plan 2B server suite `Test Files … passed`, `Tests … passed`, no `failed`; `engine 200`; `lqs-stg 401` or `403` (guard answers without a token; `404`/`000` means plan 2A is not on staging yet: stop).

- [ ] **Step 2: Write the three env CLIs**

`web/ops/env-set.mjs`:
```js
#!/usr/bin/env node
// Usage: <value on stdin> | node ops/env-set.mjs <env-file> <KEY>
// Writes one secret into an env file (mode 600) without ever printing it.
import { readFileSync } from 'node:fs';
import { setEnvKey } from './env-lib.mjs';

const [file, key] = process.argv.slice(2);
if (!file || !key) {
  console.error('usage: <value on stdin> | node ops/env-set.mjs <env-file> <KEY>');
  process.exit(2);
}
const value = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (!value || /[\r\n]/.test(value)) {
  console.error(`refusing: value for ${key} is empty or spans several lines`);
  process.exit(1);
}
setEnvKey(file, key, value);
console.log(`${key} written to ${file} (value hidden, ${value.length} chars)`);
```

`web/ops/env-container.mjs`:
```js
#!/usr/bin/env node
// Builds a container secrets file from the native web env (plan 2B's web/.env.stg) and, for PROD, the engine caller pair.
// Keeps keys already present in the target (e.g. LQSTUDIO_TOKEN). Prints key names only.
import { parseArgs } from 'node:util';
import { parsePairs, readEnvFile, toContainerDatabaseUrl, writeEnvFile } from './env-lib.mjs';

const { values } = parseArgs({
  options: { from: { type: 'string' }, to: { type: 'string' }, 'engine-env': { type: 'string' }, 'engine-caller': { type: 'string' } },
});
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!values.from || !values.to) fail('usage: node ops/env-container.mjs --from <native env> --to <container env> [--engine-env <file> --engine-caller <name>]');

const source = readEnvFile(values.from);
const out = readEnvFile(values.to);
if (!source.DATABASE_URL) fail(`${values.from} has no DATABASE_URL`);
out.DATABASE_URL = toContainerDatabaseUrl(source.DATABASE_URL);

const caller = values['engine-caller'];
if (caller) {
  const engine = readEnvFile(values['engine-env'] ?? '../engine/.env');
  const tokens = parsePairs(engine.LQTTS_TOKENS);
  const secrets = parsePairs(engine.LQTTS_CALLBACK_SECRETS);
  if (!tokens[caller] || !secrets[caller]) fail(`engine caller ${caller} not found in LQTTS_TOKENS/LQTTS_CALLBACK_SECRETS`);
  out.ENGINE_TOKEN = tokens[caller];
  out.ENGINE_CALLBACK_SECRET = secrets[caller];
} else {
  for (const key of ['ENGINE_TOKEN', 'ENGINE_CALLBACK_SECRET']) {
    if (!source[key]) fail(`${values.from} has no ${key}`);
    out[key] = source[key];
  }
}
writeEnvFile(values.to, out);
console.log(`wrote ${Object.keys(out).sort().join(', ')} to ${values.to} (values hidden)`);
```

`web/ops/env-check.mjs`:
```js
#!/usr/bin/env node
// Usage: node ops/env-check.mjs <env-file> KEY... ; prints presence and length only.
import { statSync } from 'node:fs';
import { readEnvFile } from './env-lib.mjs';

const [file, ...keys] = process.argv.slice(2);
const mode = statSync(file).mode & 0o777;
let bad = mode === 0o600 ? 0 : 1;
console.log(`${mode === 0o600 ? 'ok     ' : 'BAD    '} mode ${mode.toString(8)}`);
const env = readEnvFile(file);
for (const key of keys) {
  const value = env[key];
  const ok = typeof value === 'string' && value.length > 0 && (key !== 'LQSTUDIO_TOKEN' || value.length >= 32);
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok     ' : 'MISSING'} ${key}${value ? ` (${value.length} chars)` : ''}`);
}
process.exit(bad ? 1 : 0);
```

- [ ] **Step 3: Write `web/Dockerfile` and `web/.dockerignore`**

`web/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1

FROM node:26-bookworm-slim AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

FROM node:26-bookworm-slim AS server-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:26-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=server-deps /app/node_modules ./node_modules
COPY package.json ./
COPY server/ ./server/
COPY --from=client /app/client/dist ./client/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/index.js"]
```

`web/.dockerignore`:
```
**/node_modules
client/dist
server/test
e2e
ops
.env
.env.*
**/*.log
```

- [ ] **Step 4: Write `web/compose.yaml`**

```yaml
name: lq-tts-web

x-common: &common
  restart: unless-stopped
  logging:
    driver: json-file
    options:
      max-size: 10m
      max-file: "3"

services:
  stg:
    <<: *common
    build:
      context: .
      dockerfile: Dockerfile
    image: lq-tts-web:stg
    container_name: lq-tts-web-stg
    env_file:
      - ${HOME}/.config/lq-tts/web-stg.env
    environment:
      DB_SCHEMA: lq_tts_web_stg
      ENGINE_URL: http://host.internal:8740
      ENGINE_CALLBACK_URL: http://127.0.0.1:8750/api/internal/engine-callback
      LQSTUDIO_URL: http://100.80.128.19:3112
      LQSTUDIO_PUBLIC_URL: https://demo.lq-studio.com
      COOKIE_SECURE: "true"
      MAX_UPLOAD_BYTES: "99614720"
    ports:
      - "127.0.0.1:8750:8080"

  prod:
    <<: *common
    image: lq-tts-web:prod
    container_name: lq-tts-web-prod
    profiles: ["prod"]
    env_file:
      - ${HOME}/.config/lq-tts/web-prod.env
    environment:
      DB_SCHEMA: lq_tts_web
      ENGINE_URL: http://host.internal:8740
      ENGINE_CALLBACK_URL: http://127.0.0.1:8751/api/internal/engine-callback
      LQSTUDIO_URL: http://100.80.128.19:3101
      LQSTUDIO_PUBLIC_URL: https://lq-studio.com
      COOKIE_SECURE: "true"
      MAX_UPLOAD_BYTES: "99614720"
    ports:
      - "127.0.0.1:8751:8080"
```

- [ ] **Step 5: Build the staging secrets file (no value is printed)**

Run (mac-studio):
```bash
mkdir -p ~/.config/lq-tts && chmod 700 ~/.config/lq-tts
cd ~/Developer/LQ-TTS/web && node ops/env-container.mjs --from .env.stg --to "$HOME/.config/lq-tts/web-stg.env"
```
Expected: `wrote DATABASE_URL, ENGINE_CALLBACK_SECRET, ENGINE_TOKEN to /Users/minato/.config/lq-tts/web-stg.env (values hidden)`.

Run (**on lq-server**, where plan 2A's staging token lives; the value only travels through the pipe):
```bash
set -o pipefail
grep -m1 '^LQ_TTS_INTERNAL_TOKEN=' /home/lq/lq-studio-stg/.env | cut -d= -f2- \
  | ssh mac-studio 'export PATH=/opt/homebrew/bin:$PATH; cd ~/Developer/LQ-TTS/web && node ops/env-set.mjs "$HOME/.config/lq-tts/web-stg.env" LQSTUDIO_TOKEN'
```
Expected: `LQSTUDIO_TOKEN written to /Users/minato/.config/lq-tts/web-stg.env (value hidden, 64 chars)`.

Run (mac-studio): `node ops/env-check.mjs "$HOME/.config/lq-tts/web-stg.env" DATABASE_URL ENGINE_TOKEN ENGINE_CALLBACK_SECRET LQSTUDIO_TOKEN`
Expected: `ok      mode 600` and four `ok` lines, exit 0.

- [ ] **Step 6: Build and start `lq-tts-web-stg`**

Run (mac-studio):
```bash
export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH
cd ~/Developer/LQ-TTS/web
docker compose config --quiet && echo compose-ok
docker compose build stg
docker tag lq-tts-web:stg "lq-tts-web:$(git rev-parse --short HEAD)"
docker compose up -d stg
sleep 40; docker inspect -f '{{.State.Health.Status}} restarts={{.RestartCount}}' lq-tts-web-stg
```
Expected: `compose-ok`; build ends with `naming to docker.io/library/lq-tts-web:stg`; `healthy restarts=0`.

- [ ] **Step 7: Prove every dependency from inside the container**

Run (mac-studio):
```bash
curl -s http://127.0.0.1:8750/api/health; echo
curl -s http://127.0.0.1:8750/ | grep -o '<title>LQ TTS</title>'
curl -s -o /dev/null -w 'spa %{http_code}\n' http://127.0.0.1:8750/voices
curl -s -o /dev/null -w 'csrf %{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8750/api/auth/logout
docker exec lq-tts-web-stg node -e "const {Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query(\"select to_regclass('lq_tts_web_stg.sessions') is not null as ok\")).then(r=>{console.log('db', r.rows[0].ok);return c.end()}).catch(e=>{console.log('db error', e.code||e.message);process.exit(1)})"
docker exec lq-tts-web-stg node -e "fetch('http://100.80.128.19:3112/api/health').then(r=>console.log('lqs relay', r.status))"
docker logs --since 5m lq-tts-web-stg 2>&1 | tail -n 20
```
Expected: `{"engine":"ok","lqstudio":"ok"}`; `<title>LQ TTS</title>`; `spa 200`; `csrf 403` (mutating request without `X-Requested-With`, per plan 2B); `db true`; `lqs relay 200`; logs show the startup/migration lines and no stack traces. (`docker logs` prints server logs only; plan 2B never logs secrets.)

- [ ] **Step 8: Commit**

```bash
cd ~/Developer/LQ-TTS
git add web/Dockerfile web/.dockerignore web/compose.yaml web/ops/env-set.mjs web/ops/env-container.mjs web/ops/env-check.mjs
git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web: Dockerfile, compose and env tooling for OrbStack containers"
```

---

### Task 13: Cloudflare tunnel `lq-tts` on mac-studio and `tts-stg.lq-studio.com` behind Access

**Files:**
- Outside git: `/Users/minato/.lq-tts-tunnel-token` (mode 600, mac-studio); pm2 app `lq-tts-tunnel`; `~/brain/_brain/pm2-expected.json` (brain repo)
- Cloudflare: tunnel `lq-tts` (remotely managed), Access app "LQ-TTS Staging (tts-stg.lq-studio.com)" + policy "Allow owner", DNS `tts-stg` CNAME

**Interfaces:**
- Consumes: `lq-tts-web-stg` on `127.0.0.1:8750` (Task 12); omp eval kernel (JavaScript) with `tool.write` to `xd://mcp__cloudflare_execute` (`cloudflare.request({method, path, query?, body?})`, `accountId` predefined).
- Produces: kernel variables `TUNNEL_ID`, `STG_APP_ID` (ids are not secrets; record them in the Task 15 brain note); public `https://tts-stg.lq-studio.com` answering 302 to `lq-studio.cloudflareaccess.com` for anyone without an Access session.

All Cloudflare calls in this task run in **one omp eval cell sequence (language `js`)** on lq-server, so returned secrets stay in kernel memory. Print ids and statuses only.

- [ ] **Step 1: Define the helper and inspect the response shape with a harmless call**

```js
const cf = async (code) => {
  const r = await tool.write({ path: 'xd://mcp__cloudflare_execute', content: JSON.stringify({ code }), i: 'Calling Cloudflare API' });
  const text = typeof r === 'string' ? r : r.text;
  return JSON.parse(text);
};
const tunnels = await cf("async () => (await cloudflare.request({ method: 'GET', path: '/accounts/' + accountId + '/cfd_tunnel', query: { is_deleted: false } })).result.map((t) => ({ id: t.id, name: t.name, status: t.status }))");
console.log(tunnels);
```
Expected: an array that includes `lq-demo` (`722917f9-…`) and the other existing tunnels, and no `lq-tts`. If `r.text` is not plain JSON, print `Object.keys(r)` and adapt `cf` before any call that returns a secret.

- [ ] **Step 2: Mirror the existing staging Access app settings**

```js
const demo = await cf("async () => { const a = (await cloudflare.request({ method: 'GET', path: '/accounts/' + accountId + '/access/apps/1497ac66-0072-4836-84aa-5834cbdaa27c' })).result; const p = (await cloudflare.request({ method: 'GET', path: '/accounts/' + accountId + '/access/apps/1497ac66-0072-4836-84aa-5834cbdaa27c/policies' })).result; return { session_duration: a.session_duration, allowed_idps: a.allowed_idps, auto_redirect_to_identity: a.auto_redirect_to_identity, policies: p.map((x) => ({ name: x.name, decision: x.decision, include: x.include })) }; }");
console.log(JSON.stringify(demo, null, 1));
```
Expected: `session_duration: "168h"`, `allowed_idps: ["1259c1fd-e5f7-4cc8-a7a9-b6555bc1d9d2"]`, `auto_redirect_to_identity: true`, one allow policy including `{ email: { email: "lqmnah26@gmail.com" } }`. If the policy list endpoint answers with an error because the demo app uses reusable policies, read `a.policies` from the app object instead and mirror that form in Step 3.

- [ ] **Step 3: Create the Access app first (deny by default), then the owner policy**

```js
const stgApp = await cf("async () => { const r = await cloudflare.request({ method: 'POST', path: '/accounts/' + accountId + '/access/apps', body: { name: 'LQ-TTS Staging (tts-stg.lq-studio.com)', type: 'self_hosted', domain: 'tts-stg.lq-studio.com', session_duration: '168h', auto_redirect_to_identity: true, app_launcher_visible: false, allowed_idps: ['1259c1fd-e5f7-4cc8-a7a9-b6555bc1d9d2'] } }); return { id: r.result.id, domain: r.result.domain }; }");
globalThis.STG_APP_ID = stgApp.id;
const owner = await cf(`async () => { const r = await cloudflare.request({ method: 'POST', path: '/accounts/' + accountId + '/access/apps/${STG_APP_ID}/policies', body: { name: 'Allow owner', decision: 'allow', precedence: 1, include: [{ email: { email: 'lqmnah26@gmail.com' } }] } }); return { id: r.result.id, decision: r.result.decision }; }`);
console.log(stgApp, owner);
```
Expected: `{ id: '<uuid>', domain: 'tts-stg.lq-studio.com' }` and `{ id: '<uuid>', decision: 'allow' }`. Nothing routes to the app yet, so nothing is exposed.

- [ ] **Step 4: Create the remotely-managed tunnel and hand its token to mac-studio without printing it**

```js
const created = await cf("async () => { const r = await cloudflare.request({ method: 'POST', path: '/accounts/' + accountId + '/cfd_tunnel', body: { name: 'lq-tts', config_src: 'cloudflare' } }); return { id: r.result.id, name: r.result.name }; }");
globalThis.TUNNEL_ID = created.id;
const token = await cf(`async () => (await cloudflare.request({ method: 'GET', path: '/accounts/' + accountId + '/cfd_tunnel/${TUNNEL_ID}/token' })).result`);
await Bun.$`ssh mac-studio ${'umask 077; cat > ~/.lq-tts-tunnel-token && wc -c < ~/.lq-tts-tunnel-token'} < ${new Response(token)}`;
console.log(created);
```
Expected: `{ id: '<uuid>', name: 'lq-tts' }` and a byte count (≈ 180–220) from `wc -c`; the token itself never appears.

- [ ] **Step 5: Run the connector under pm2 on mac-studio (http2, token file)**

Run (mac-studio):
```bash
export PATH=/opt/homebrew/bin:$PATH
chmod 600 ~/.lq-tts-tunnel-token
pm2 start /opt/homebrew/bin/cloudflared --name lq-tts-tunnel -- tunnel --no-autoupdate run --protocol http2 --token-file /Users/minato/.lq-tts-tunnel-token
sleep 10; pm2 logs lq-tts-tunnel --lines 40 --nostream | grep -E 'Initial protocol|Registered tunnel connection' | head -n 6
pm2 save
```
Expected: `Initial protocol http2` and `Registered tunnel connection connIndex=0` … `connIndex=3`; `pm2 save` prints `Successfully saved`.

- [ ] **Step 6: Route the staging hostname (ingress, then DNS)**

```js
const cfg = await cf(`async () => { const r = await cloudflare.request({ method: 'PUT', path: '/accounts/' + accountId + '/cfd_tunnel/${TUNNEL_ID}/configurations', body: { config: { ingress: [ { hostname: 'tts-stg.lq-studio.com', service: 'http://127.0.0.1:8750' }, { service: 'http_status:404' } ] } } }); return { version: r.result.version }; }`);
const dns = await cf(`async () => { const r = await cloudflare.request({ method: 'POST', path: '/zones/ef276f9dab10a565f64091c07d92ac8c/dns_records', body: { type: 'CNAME', name: 'tts-stg.lq-studio.com', content: '${TUNNEL_ID}.cfargotunnel.com', proxied: true, comment: 'LQ-TTS staging via tunnel lq-tts (mac-studio)' } }); return { id: r.result.id, name: r.result.name, proxied: r.result.proxied }; }`);
console.log(cfg, dns);
```
Expected: `{ version: 1 }` (or higher) and `{ id: '<id>', name: 'tts-stg.lq-studio.com', proxied: true }`. `pm2 logs lq-tts-tunnel --lines 10 --nostream` on mac-studio shows `Updated to new configuration`.

- [ ] **Step 7: Prove the gate from outside**

Run (lq-server and mac-studio):
```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://tts-stg.lq-studio.com/
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://tts-stg.lq-studio.com/api/health
```
Expected: both `302 https://lq-studio.cloudflareaccess.com/cdn-cgi/access/login/tts-stg.lq-studio.com?...` (DNS can need a minute; retry, never open a bypass).

- [ ] **Step 8: Keep the connector across reboots (brain pm2 registry)**

Edit `~/brain/_brain/pm2-expected.json` (canonical brain repo) so `diharapkan` contains `"lq-tts-tunnel"` in sorted position:
```json
{
 "diharapkan": [
  "deepseek-jev",
  "jev-bridge",
  "lq-ai-shim",
  "lq-ai-tunnel",
  "lq-socmed-bridge",
  "lq-tg-bot",
  "lq-tts-tunnel",
  "mnt-jev",
  "openjev-api",
  "pm2-logrotate"
 ],
 "_doc": "Daftar app pm2 yang HARUS online. Dipakai brain-pm2-save-good.sh untuk menolak menyimpan dump saat keadaan tidak sehat."
}
```
Then:
```bash
cd ~/brain && git add _brain/pm2-expected.json && git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "pm2: lq-tts-tunnel diharapkan online di mac-studio" && git pull --rebase --autostash && bash ~/brain/_brain/bin/brain-push.sh
ssh mac-studio 'cd ~/brain && git pull --rebase --autostash && bash ~/brain/_brain/bin/brain-pm2-save-good.sh'
```
Expected: brain-push verifies the remote; on mac-studio `SEHAT — N app online` and `dump .good disimpan: …`.

---

### Task 14: Staging gate (spec §9 release step 2): seeded account + Playwright through `tts-stg.lq-studio.com`

**Files:**
- Create: `web/e2e/staging/seed-lqstudio-user.mjs`
- Outside git: `~/.config/lq-tts/e2e-staging.env` (mode 600, mac-studio); temporary Access service token + policy (deleted at the end)

**Interfaces:**
- Consumes: Tasks 11–13; LQ-Studio staging container `lq-studio-stg-lqs` on lq-server (`/app/server/infra/db.js`: `getUserByIdentifier`, `hashPassword`, `upsert`; `/app/server/services/akun/twofa.js`: `generateSecret`, `encryptSecret`); kernel variables `STG_APP_ID` and helper `cf` from Task 13.
- Produces: staging-only LQ-Studio account `tts-e2e` (verified email+phone flags, TOTP on, Free plan, topped to 500 credits by a `bonus` ledger row `reason: tts_e2e_seed`); env file keys `LQTTS_E2E_IDENTIFIER`, `LQTTS_E2E_PASSWORD`, `LQTTS_E2E_TOTP_SECRET`; a green Playwright run with `E2E_TARGET=staging-public`.

- [ ] **Step 1: Write `web/e2e/staging/seed-lqstudio-user.mjs`**

```js
// Runs INSIDE the LQ-Studio STAGING container (lq-server):
//   docker exec -i -w /app lq-studio-stg-lqs node --input-type=module -   (script on stdin)
// Creates or refreshes the staging-only account `tts-e2e` for the LQ-TTS Playwright gate and writes ONLY an env file
// to stdout, which the caller pipes into a mode-600 file on mac-studio. Refuses to run anywhere but staging.
import { randomBytes, randomUUID } from 'node:crypto';

if (!/^https:\/\/demo\.lq-studio\.com\/?$/.test(process.env.PUBLIC_URL ?? '')) {
  console.error('refusing: PUBLIC_URL is not LQ-Studio staging');
  process.exit(2);
}
if (!process.env.JWT_SECRET) {
  console.error('refusing: JWT_SECRET missing');
  process.exit(2);
}

const db = await import('/app/server/infra/db.js');
const twofa = await import('/app/server/services/akun/twofa.js');

const IDENT = 'tts-e2e';
const TARGET_BALANCE = 500;
const now = new Date().toISOString();
const existing = await db.getUserByIdentifier(IDENT);
const password = randomBytes(18).toString('base64url');
const secret = twofa.generateSecret();
const balance = Number(existing?.credits ?? 0);
const grant = Math.max(0, TARGET_BALANCE - balance);

const user = {
  ...(existing ?? {}),
  id: existing?.id ?? randomUUID(),
  name: 'TTS E2E (staging)',
  username: IDENT,
  email: 'tts-e2e@lq-studio.com',
  password: db.hashPassword(password),
  role: 'user',
  tier: 'free',
  LANGUAGE: 'id',
  credits: balance + grant,
  emailVerified: true,
  emailVerifiedAt: existing?.emailVerifiedAt ?? now,
  phoneVerified: true,
  phoneVerifiedAt: existing?.phoneVerifiedAt ?? now,
  suspended: false,
  totpEnabled: true,
  totpSecret: twofa.encryptSecret(secret, process.env.JWT_SECRET),
  totpPending: null,
  totpBackupCodes: [],
  totpLastStep: 0,
  tokenVersion: Number(existing?.tokenVersion ?? 0) + 1,
  agreeTerms: true,
  agreePrivacy: true,
  createdAt: existing?.createdAt ?? now,
  lastActiveAt: now,
  freeGrantedAt: existing?.freeGrantedAt ?? now,
};

await db.upsert('users', user);
if (grant > 0) {
  // The ledger records every credit move (LQ-Studio's drift monitor sums `amount`), so the top-up is a bonus row.
  await db.upsert('credit_ledger', {
    id: randomUUID(), userId: user.id, type: 'bonus', amount: grant, balanceAfter: user.credits,
    reason: 'tts_e2e_seed', refId: null, refType: 'system', metadata: { purpose: 'LQ-TTS staging Playwright gate' }, createdAt: now,
  });
}
process.stdout.write(`LQTTS_E2E_IDENTIFIER=${IDENT}\nLQTTS_E2E_PASSWORD=${password}\nLQTTS_E2E_TOTP_SECRET=${secret}\n`);
process.exit(0);
```

- [ ] **Step 2: Commit the seed script, then seed the account (run on lq-server)**

```bash
ssh mac-studio 'cd ~/Developer/LQ-TTS && git add web/e2e/staging/seed-lqstudio-user.mjs && git -c user.name=lqmnah -c user.email=lqmnah@users.noreply.github.com commit -m "web/e2e: staging-only LQ-Studio test account seeder"'
set -o pipefail
ssh mac-studio 'cat ~/Developer/LQ-TTS/web/e2e/staging/seed-lqstudio-user.mjs' \
  | docker exec -i -w /app lq-studio-stg-lqs node --input-type=module - \
  | ssh mac-studio 'umask 077; mkdir -p ~/.config/lq-tts && chmod 700 ~/.config/lq-tts && cat > ~/.config/lq-tts/e2e-staging.env && wc -l < ~/.config/lq-tts/e2e-staging.env'
```
Expected: `3` (three lines written); the pipeline exits 0. On mac-studio: `cd ~/Developer/LQ-TTS/web && node ops/env-check.mjs ~/.config/lq-tts/e2e-staging.env LQTTS_E2E_IDENTIFIER LQTTS_E2E_PASSWORD LQTTS_E2E_TOTP_SECRET` → `ok` ×4 (mode + 3 keys).

- [ ] **Step 3: Open a temporary service-token door and run the full Playwright gate through Cloudflare**

In the same omp JS kernel as Task 13 (`cf`, `STG_APP_ID` defined; set the cell timeout to 1800 s):
```js
const temp = await cf(`async () => { const t = await cloudflare.request({ method: 'POST', path: '/accounts/' + accountId + '/access/service_tokens', body: { name: 'lq-tts-e2e-temp', duration: '24h' } }); const p = await cloudflare.request({ method: 'POST', path: '/accounts/' + accountId + '/access/apps/${STG_APP_ID}/policies', body: { name: 'Temp E2E service token', decision: 'non_identity', precedence: 2, include: [{ service_token: { token_id: t.result.id } }] } }); return { tokenId: t.result.id, policyId: p.result.id, clientId: t.result.client_id, clientSecret: t.result.client_secret }; }`);
globalThis.TEMP_TOKEN_ID = temp.tokenId;
globalThis.TEMP_POLICY_ID = temp.policyId;
const doorEnv = `CF_ACCESS_CLIENT_ID=${temp.clientId}\nCF_ACCESS_CLIENT_SECRET=${temp.clientSecret}\n`;
const remote = 'export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; set -a; . /dev/stdin; set +a; cd ~/Developer/LQ-TTS/web/e2e && E2E_TARGET=staging-public npx playwright test --project=journey --project=screens --project=smoke 2>&1';
const run = await Bun.$`ssh mac-studio ${remote} < ${new Response(doorEnv)}`.nothrow().quiet();
console.log(run.stdout.toString().split('\n').slice(-40).join('\n'));
console.log('exit', run.exitCode);
```
Expected: the last lines show `5 passed` and `exit 0`. The run covers spec §9 end to end on staging: real LQ-Studio staging login with TOTP, real engine clone and generation, SSE through the tunnel, regenerate, MP3 download, ID⇄EN, History, Credits, then screenshots at 390/768/1440 and the smoke test.

On failure: read `~/Developer/LQ-TTS/web/e2e/report/index.html` on mac-studio, fix, rebuild the staging image (Task 12 Step 6), rerun this step (the temporary door stays until Step 4).

- [ ] **Step 4: Close the temporary door (always, pass or fail)**

```js
const left = await cf(`async () => { await cloudflare.request({ method: 'DELETE', path: '/accounts/' + accountId + '/access/apps/${STG_APP_ID}/policies/${TEMP_POLICY_ID}' }); await cloudflare.request({ method: 'DELETE', path: '/accounts/' + accountId + '/access/service_tokens/${TEMP_TOKEN_ID}' }); await cloudflare.request({ method: 'POST', path: '/accounts/' + accountId + '/access/apps/${STG_APP_ID}/revoke_tokens' }); return (await cloudflare.request({ method: 'GET', path: '/accounts/' + accountId + '/access/apps/${STG_APP_ID}/policies' })).result.map((p) => p.name); }`);
console.log(left);
await Bun.$`ssh mac-studio ${'rm -rf ~/Developer/LQ-TTS/web/e2e/test-results'}`;
```
Expected: `[ 'Allow owner' ]`. (Traces under `test-results` can contain the service-token headers; they are deleted. Screenshots under `artifacts/` stay as evidence.) Then `curl -s -o /dev/null -w '%{http_code}\n' https://tts-stg.lq-studio.com/` → `302`.

- [ ] **Step 5: Prove the money moved exactly once on staging**

Run (mac-studio):
```bash
/opt/homebrew/opt/postgresql@16/bin/psql -d lq_tts -Atc "select kind, state, count(*) from lq_tts_web_stg.charges group by 1,2 order by 1,2"
/opt/homebrew/opt/postgresql@16/bin/psql -d lq_tts -Atc "select count(*) from lq_tts_web_stg.charges where state='held' and created_at < now() - interval '2 minutes'"
```
Expected: rows `job|settled|N` and `regenerate|settled|M` with N, M ≥ 1; the second query prints `0` (no charge left held, spec §8.3).

- [ ] **Step 6: Report staging to lqmnah (SOP G7) before PROD**

Paste into the hand-over: the `5 passed` output, the screenshot paths `web/e2e/artifacts/{390,768,1440}/*.png` (attach login, tts, job, voices at each width), `console-network.json` = `[]` from the report, the charges query, and the 302 proof. PROD (Task 15) starts only after this report.

---

### Task 15: PROD release (spec §9 release step 3): `lq-tts-web-prod` and `tts.lq-studio.com`

**Files:**
- Outside git: `~/.config/lq-tts/web-prod.env` (mode 600); image tags `lq-tts-web:prod`, `lq-tts-web:prod-prev`; Cloudflare ingress rule + DNS `tts`
- Brain: release record via `brain-task.py`

**Interfaces:**
- Consumes: green staging gate (Task 14); plan 2A on LQ-Studio PROD; engine caller `lq-tts` in `engine/.env`; kernel `cf`, `TUNNEL_ID`.
- Produces: `https://tts.lq-studio.com` serving the exact image that passed staging, calling LQ-Studio PROD.

- [ ] **Step 1: Gate on the prerequisites (stop on any failure)**

Run (mac-studio):
```bash
cd ~/Developer/LQ-TTS
git merge-base --is-ancestor feat/voice-engine main && echo engine-merged || echo ENGINE-NOT-MERGED
curl -s -o /dev/null -w 'lqs-prod %{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' http://100.80.128.19:3101/api/internal/tts/auth/verify
```
Expected: `engine-merged` (spec §10: the engine branch is integrated before the app ships; if `ENGINE-NOT-MERGED`, stop and ask lqmnah through Main, do not merge on your own) and `lqs-prod 401` or `403` (plan 2A live on PROD; `404`/`000` means stop).

- [ ] **Step 2: Build the PROD secrets file**

Run (mac-studio):
```bash
cd ~/Developer/LQ-TTS/web
node ops/env-container.mjs --from .env.stg --to "$HOME/.config/lq-tts/web-prod.env" --engine-env ../engine/.env --engine-caller lq-tts
```
Expected: `wrote DATABASE_URL, ENGINE_CALLBACK_SECRET, ENGINE_TOKEN to /Users/minato/.config/lq-tts/web-prod.env (values hidden)`.

Run (**on lq-server**):
```bash
set -o pipefail
grep -m1 '^LQ_TTS_INTERNAL_TOKEN=' /home/lq/lq-studio-prod/repo/.env | cut -d= -f2- \
  | ssh mac-studio 'export PATH=/opt/homebrew/bin:$PATH; cd ~/Developer/LQ-TTS/web && node ops/env-set.mjs "$HOME/.config/lq-tts/web-prod.env" LQSTUDIO_TOKEN'
```
Expected: `LQSTUDIO_TOKEN written to /Users/minato/.config/lq-tts/web-prod.env (value hidden, 64 chars)`.

Run (mac-studio): `node ops/env-check.mjs "$HOME/.config/lq-tts/web-prod.env" DATABASE_URL ENGINE_TOKEN ENGINE_CALLBACK_SECRET LQSTUDIO_TOKEN`
Expected: mode 600 and four `ok`.

- [ ] **Step 3: Promote the staging image and start PROD**

Run (mac-studio):
```bash
export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH
cd ~/Developer/LQ-TTS/web
docker image inspect lq-tts-web:prod >/dev/null 2>&1 && docker tag lq-tts-web:prod lq-tts-web:prod-prev
docker tag lq-tts-web:stg lq-tts-web:prod
docker compose --profile prod up -d prod
sleep 40; docker inspect -f '{{.State.Health.Status}} restarts={{.RestartCount}}' lq-tts-web-prod
curl -s http://127.0.0.1:8751/api/health; echo
docker exec lq-tts-web-prod node -e "const {Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query(\"select to_regclass('lq_tts_web.sessions') is not null as ok\")).then(r=>{console.log('db', r.rows[0].ok);return c.end()}).catch(e=>{console.log('db error', e.code||e.message);process.exit(1)})"
docker image inspect -f '{{.Id}}' lq-tts-web:stg lq-tts-web:prod
```
Expected: `healthy restarts=0`; `{"engine":"ok","lqstudio":"ok"}`; `db true`; the two image ids are identical (PROD runs the bits that passed staging).

- [ ] **Step 4: Route `tts.lq-studio.com` (keep the staging rule)**

In the omp JS kernel (`cf`, `TUNNEL_ID` defined):
```js
const prodCfg = await cf(`async () => { const r = await cloudflare.request({ method: 'PUT', path: '/accounts/' + accountId + '/cfd_tunnel/${TUNNEL_ID}/configurations', body: { config: { ingress: [ { hostname: 'tts-stg.lq-studio.com', service: 'http://127.0.0.1:8750' }, { hostname: 'tts.lq-studio.com', service: 'http://127.0.0.1:8751' }, { service: 'http_status:404' } ] } } }); return { version: r.result.version, hosts: r.result.config.ingress.map((i) => i.hostname ?? i.service) }; }`);
const prodDns = await cf(`async () => { const r = await cloudflare.request({ method: 'POST', path: '/zones/ef276f9dab10a565f64091c07d92ac8c/dns_records', body: { type: 'CNAME', name: 'tts.lq-studio.com', content: '${TUNNEL_ID}.cfargotunnel.com', proxied: true, comment: 'LQ-TTS PROD via tunnel lq-tts (mac-studio)' } }); return { id: r.result.id, name: r.result.name, proxied: r.result.proxied }; }`);
console.log(prodCfg, prodDns);
```
Expected: `hosts: ['tts-stg.lq-studio.com', 'tts.lq-studio.com', 'http_status:404']` and `{ name: 'tts.lq-studio.com', proxied: true }`.

- [ ] **Step 5: Prove PROD publicly (SOP G5)**

Run (lq-server and mac-studio):
```bash
curl -s https://tts.lq-studio.com/api/health; echo
curl -s -o /dev/null -w 'stg %{http_code}\n' https://tts-stg.lq-studio.com/
```
Expected: `{"engine":"ok","lqstudio":"ok"}` and `stg 302` (staging still gated).

Run (mac-studio): `cd ~/Developer/LQ-TTS/web/e2e && E2E_TARGET=prod npx playwright test --project=smoke`
Expected: `1 passed`; screenshots `artifacts/smoke/login-{390,768,1440}.png`; the expected `401` from LQ-Studio PROD for the made-up account; console and network otherwise clean. No paid journey is run on PROD (it would spend real credits on a real account); that needs lqmnah's PROD test account and approval.

- [ ] **Step 6: Persist and record**

Run (mac-studio): `pm2 save && bash ~/brain/_brain/bin/brain-pm2-save-good.sh`
Expected: `SEHAT` and `dump .good disimpan`.

Run (mac-studio; ids are not secrets):
```bash
python3 ~/brain/_brain/bin/brain-task.py add "LQ-TTS web rilis: tts-stg (Access) + tts.lq-studio.com" --mesin mac-studio --proyek lq-tts --id lq-tts-web-rilis
python3 ~/brain/_brain/bin/brain-task.py done lq-tts-web-rilis --sha "$(cd ~/Developer/LQ-TTS && git rev-parse --short HEAD)" --bukti "stg+prod healthy; Playwright staging-public 5/5 (390/768/1440, console+network bersih); prod smoke 1/1; tunnel lq-tts <TUNNEL_ID> pm2 lq-tts-tunnel http2; Access app <STG_APP_ID> owner only; charges held>2m = 0"
cd ~/brain && git pull --rebase --autostash && bash ~/brain/_brain/bin/brain-push.sh
```
Replace `<TUNNEL_ID>` and `<STG_APP_ID>` with the printed ids before running. Expected: brain-push reports the remote verified.

- [ ] **Step 7: Rollback recipe (keep in the hand-over; run only if PROD misbehaves)**

```bash
# app only: back to the previous image
docker tag lq-tts-web:prod-prev lq-tts-web:prod && docker compose --profile prod up -d prod
# take PROD off the internet, keep staging
#   kernel: PUT the tunnel configuration with only the tts-stg rule + http_status:404 (Task 13 Step 6 body)
docker compose --profile prod stop prod
```

---

## Contract gaps found while planning (proposals, not applied)

1. **Sign-up URL before login.** C2 has no pre-login config, so the client derives the LQ-Studio origin from the hostname (`tts.lq-studio.com` → `https://lq-studio.com`, everything else → `https://demo.lq-studio.com`). Proposal: add `signupUrl` to `GET /api/health` (no auth) so the server owns it like `topupUrl`.
2. **Upload size vs Cloudflare Free (resolved by controller ruling 2026-10-03).** Web uploads are capped at 95 MB in the client and on the server (`too_large`); the engine keeps 200 MB for internal callers. Applied throughout this plan (Global Constraints, `MAX_AUDIO_BYTES`, ID/EN copy suggesting MP3/M4A export, `MAX_UPLOAD_BYTES` in `compose.yaml`, Playwright too-large check). This deviates from spec §3's "≤ 200 MB" for the web app; the spec text should be amended accordingly.
3. **Sentence audio after regenerate.** `GET /api/jobs/:id/sentences/:idx/audio` has no revision, so the browser could replay a cached old take. The client appends `?v=<revision>`; plan 2B must ignore unknown query parameters (or send `Cache-Control: no-store`) on that route.
4. **File download name.** The client sets `download="lq-tts-<id8>-r<rev>.<ext>"`; if plan 2B sends `Content-Disposition` with another filename, the server's name wins (Playwright only asserts the extension).
5. **PROD journey.** The PROD gate is a smoke test only; a paid end-to-end run on PROD needs an approved PROD test account.

## Self-review

- Spec §3 coverage: Text to Speech editor/voice/settings/price/Generate (Task 8); live sentence progress, play, edit+regenerate, revisions, MP3/WAV/SRT/VTT downloads (Task 9); Voices list/status/reason/preview/delete, clone upload MP3/WAV/M4A/FLAC ≤ 95 MB (controller ruling replacing the spec's 200 MB for the web app), name, language auto/ID/EN, transcript, required consent, "used X of N" (Task 7); History date/voice/status/characters/credits/duration with open/download/delete (Task 10); Credits balance, usage, top-up link (Task 10); Account name/email, ID⇄EN, log out (Task 5); Login with 2FA, sign-up link, needs-verification link (Task 6). §8: LQ-Studio unavailable (login error + banner + Generate blocked, Tasks 5/6/8), engine restarting banner (Task 5), voice failure reasons (Task 7), session expiry redirect (Tasks 3/5), browser-side upload limits incl. the 95 MB case (Task 7 unit test, Task 11 Playwright). §9: Playwright journey with screenshots at 390/768/1440, console and network clean (Tasks 11/14), G4 skills (Global Constraints, Task 1 Step 1, Task 5 Step 1), release order staging → Playwright → PROD (Tasks 12–15).
- Placeholders: none; every code step has complete code; ids that only exist at run time (`TUNNEL_ID`, `STG_APP_ID`) are produced by earlier steps and substituted explicitly.
- Type consistency: `api.*`, `urls.*`, `openJobEvents` event shapes, `progressReducer` actions, `useSession()` members, `ui.jsx` exports, DOM test ids and env names match across Tasks 3–15 and the plan 2B interface list.
