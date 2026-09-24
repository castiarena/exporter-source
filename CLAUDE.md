# CLAUDE.md

> Context file for AI assistants working on this project.

## Project Overview

**exporter** is a Chrome extension that converts web pages (or selected elements) to PDF entirely on-device. It makes zero network requests — enforced at build time, not by convention.

### Key Principles

1. **No network, no telemetry** — The extension never phones home. `npm run verify:no-remote` enforces this against built output.
2. **Security as a constraint** — Filename sanitization, message sender verification, minimal permissions, scoped debugger access.
3. **User action only** — No `content_scripts` in manifest; injection happens only via `chrome.scripting.executeScript` after user action.
4. **Two rendering paths** — CDP (selectable text, vector graphics) with canvas fallback (when DevTools owns the tab).

## Directory Structure

```
src/
├── background/         # Service worker — owns all state, orchestrates exports
│   └── service-worker.ts
├── content/            # Injected scripts (must be IIFE, no imports)
│   ├── element-picker.ts   # Hover-highlight, click-to-select UI
│   └── page-readiness.ts   # Wait for fonts, images, lazy content
├── export/             # PDF generation
│   ├── pdf-via-cdp.ts      # Primary: chrome.debugger + Page.printToPDF
│   ├── pdf-via-canvas.ts   # Fallback: html2canvas + jsPDF
│   └── filename.ts         # Security boundary for filename sanitization
├── shared/             # Types and utilities shared across contexts
│   ├── types.ts            # Core type vocabulary (ExportState, etc.)
│   ├── messaging.ts        # Typed chrome.runtime message contract
│   ├── errors.ts           # Error classification
│   ├── constants.ts        # Shared constants
│   ├── i18n.ts             # Localization helpers
│   └── ordinals.ts         # "First", "Second", etc. labeling
├── popup/              # Extension popup UI
├── options/            # Options page
└── icons/              # Generated icons

vendor/                 # Pinned third-party code (committed, no CDN)
├── html2canvas/
├── jspdf/
├── babel-runtime/      # Single helper jsPDF needs
└── stubs/              # Throwing stubs for unused jsPDF imports

scripts/                # Build tooling (Node, runs in full environment)
├── build.mjs           # Multi-pass Vite build
├── verify-no-remote.mjs # Security check against dist/
├── vendor.mjs          # Copies pinned deps to vendor/
├── package.mjs         # Zips dist/ for Chrome Web Store
└── require-node.mjs    # Node version preflight

tests/
├── unit/               # Vitest unit tests
└── e2e/                # Playwright e2e tests (against real Chromium)
```

## Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Build `dist/` (loadable via Load unpacked) |
| `npm run build:test` | Build `dist-test/` with `<all_urls>` for e2e |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:e2e` | Run e2e tests (requires `npm run build:test` first) |
| `npm run lint` | ESLint with security rules |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify:no-remote` | Fail if `dist/` has network/eval paths |
| `npm run audit` | Security advisories for shipped code only |
| `npm run vendor` | Re-copy pinned libs to `vendor/` |

## Code Conventions

### TypeScript

- **Strict mode**: `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals`, etc.
- **Type imports**: Use `import type { X }` for type-only imports (enforced by ESLint).
- **No `any`**: `@typescript-eslint/no-explicit-any` is an error.
- **Unused vars**: Prefix with `_` if intentionally unused.

### Security Rules (ESLint Errors)

These are **hard errors**, not warnings:

```typescript
// FORBIDDEN in first-party code:
eval(...)           // no-eval
new Function(...)   // no-new-func
fetch(...)          // no-restricted-globals
XMLHttpRequest      // no-restricted-globals
WebSocket           // no-restricted-globals
EventSource         // no-restricted-globals
```

Scripts in `scripts/` and `tests/` are exempt (they run in Node, not the extension).

### Messaging Contract

All chrome.runtime messages go through `src/shared/messaging.ts`:

```typescript
// Types: CommandMessage, ContentMessage, TabMessage, BroadcastMessage
// Helpers: sendToBackground(), sendToTab(), broadcast()
// Every response is Response<T> = { ok: true, value: T } | { ok: false, error: string }
```

Every `onMessage` listener **must** verify `sender.id === chrome.runtime.id`.

### Content Scripts

Content scripts are **IIFE bundles** (not ES modules) because `chrome.scripting.executeScript` loads them as classic scripts. They cannot have imports — everything must be bundled into one file.

### Error Handling

- Every error code in `EXPORT_ERROR_CODES` (types.ts) must have a user-facing string in `_locales/en/messages.json`.
- Use `errors.ts` for error classification.
- The test suite verifies all error codes have locale coverage.

### Filename Sanitization

`src/export/filename.ts` is a **security boundary**. Page titles are attacker-controlled. The sanitizer:
- Strips path separators, control chars, bidi overrides
- Defuses traversal (`../`)
- Caps length, renames Windows reserved names
- Never produces leading dots or empty output

## Build System

The build runs **three passes** (scripts/build.mjs):

1. **ES modules** — Service worker + popup/options pages
2. **IIFE bundles** — Content scripts (element-picker, page-readiness, pdf-via-canvas)
3. **Static copy** — manifest.json, `_locales/`, icons

`--test` flag produces `dist-test/` with `host_permissions: ["<all_urls>"]` for Playwright (can't click toolbar icons).

### Vendored Libraries

`vendor/` is committed. Libraries are pinned to exact versions:
- `html2canvas@1.4.1`
- `jspdf@4.2.1`

`npm run vendor` copies them from node_modules. CI fails if `vendor/` drifts.

jsPDF's unused lazy imports (`canvg`, `dompurify`, `html2canvas`) are aliased to throwing stubs in vite.config.ts.

## Testing

### Unit Tests (Vitest)

```bash
npm test
```

Key test files:
- `filename.test.ts` — Sanitization, path traversal attacks
- `messages.test.ts` — Locale coverage for all error codes
- `errors.test.ts` — Error classification
- `ordinals.test.ts` — Ordinal labeling

### E2E Tests (Playwright)

```bash
npm run build:test
npx playwright install chromium
npm run test:e2e
```

Tests against real Chromium with extension loaded. Asserts:
- Full page export produces valid PDF
- Element export produces correct page count
- No DOM residue after export/cancel

## Security Checklist

Before any release, verify:

1. `npm run lint` — No security rule violations
2. `npm run verify:no-remote` — No network paths in dist/
3. `npm audit` — No advisories in shipped code
4. Manifest permissions match actual usage
5. Message handlers verify sender.id
6. chrome.debugger attach/detach in finally blocks
7. Filename tests cover traversal attempts

See `docs/security-notes.md` for the full security pass.

## Common Tasks

### Adding a New Error Code

1. Add to `EXPORT_ERROR_CODES` in `src/shared/types.ts`
2. Add user-facing message to `_locales/en/messages.json`
3. Test will fail if locale entry is missing

### Adding a New Message Type

1. Add to appropriate type in `src/shared/messaging.ts` (CommandMessage, TabMessage, etc.)
2. Add response type to `ResponseMap`
3. Add handler in relevant listener (service-worker.ts or content script)
4. Verify sender.id in handler

### Modifying Content Scripts

Remember: content scripts are IIFE bundles. You cannot use imports. Everything must be self-contained or bundled by Vite.

### Updating Vendored Libraries

1. Update version in package.json
2. Run `npm install`
3. Run `npm run vendor`
4. Run `npm run build && npm run verify:no-remote`
5. If new network references appear, add to `VENDOR_ALLOWANCES` with justification

## Node Version

**Node 22.13+** required (`.nvmrc` provided). The toolchain (Vite 8, ESLint 10) won't work on older versions. Every npm script runs a preflight check.

## What NOT to Do

- **Don't add network calls** — The extension is offline-only by design
- **Don't use `eval` or `new Function`** — CSP and ESLint forbid it
- **Don't add `content_scripts` to manifest** — Injection is user-action-only
- **Don't commit dist/** — It's gitignored; built on demand
- **Don't use `console.log`** — Use `console.warn`, `console.error`, or `console.debug`
- **Don't add dependencies without security review** — Anything that ships needs audit
