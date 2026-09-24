# AGENTS.md

> Universal context file for AI coding assistants (Codeium, Tabnine, Amazon Q, etc.)

## What This Project Is

**exporter** — A Chrome extension that exports web pages to PDF entirely on-device.

- No accounts, no uploads, no servers, no telemetry
- Zero network requests (enforced at build time)
- Two rendering paths: CDP (vector/selectable text) or canvas fallback

## Hard Constraints

### Security (ESLint Errors)

```
FORBIDDEN in src/ (except scripts/ and tests/):
- eval()
- new Function()
- fetch()
- XMLHttpRequest
- WebSocket
- EventSource
- console.log (use console.warn/error/debug)
```

### Architecture

- No `content_scripts` in manifest — all injection via `chrome.scripting.executeScript`
- Content scripts (src/content/*) are IIFE bundles — no imports
- All messaging through `src/shared/messaging.ts` with typed contracts
- Message handlers must verify `sender.id === chrome.runtime.id`
- `src/export/filename.ts` is a security boundary (sanitizes page titles)

## Directory Map

```
src/
├── background/service-worker.ts  # Orchestrates exports
├── content/element-picker.ts     # IIFE: hover/click selection
├── content/page-readiness.ts     # IIFE: wait for page load
├── export/pdf-via-cdp.ts         # Primary: chrome.debugger
├── export/pdf-via-canvas.ts      # Fallback: html2canvas+jsPDF
├── export/filename.ts            # Security: sanitize filenames
├── shared/types.ts               # Core types
├── shared/messaging.ts           # Typed message contract
├── popup/                        # Extension popup
└── options/                      # Options page

vendor/                           # Committed deps (no CDN)
scripts/                          # Build tools (Node env)
tests/unit/                       # Vitest
tests/e2e/                        # Playwright
```

## Code Patterns

### TypeScript

```typescript
// Strict mode, type imports
import type { ExportState, ExportOptions } from './types';

// No any, use unknown + narrowing
function process(input: unknown): string {
  if (typeof input !== 'string') throw new Error('...');
  return input;
}

// Unused params prefixed with _
function handler(_unused: number, used: string) { ... }
```

### Messaging

```typescript
// Typed messages
import { sendToBackground, ok, err } from './messaging';
import type { Response } from './messaging';

const result = await sendToBackground({ type: 'GET_STATE' });
if (!result.ok) return; // result.error available

// Return typed responses
return ok(value);  // { ok: true, value }
return err('msg'); // { ok: false, error: 'msg' }
```

### Error Handling

```typescript
// All error codes in EXPORT_ERROR_CODES (src/shared/types.ts)
// Each must have entry in _locales/en/messages.json
// Tests verify coverage
```

## Commands

| Command | What |
|---------|------|
| `npm run build` | Build dist/ |
| `npm test` | Unit tests |
| `npm run lint` | ESLint (security rules) |
| `npm run typecheck` | tsc --noEmit |
| `npm run verify:no-remote` | Check dist/ for network paths |

## When Suggesting Code

1. **No network calls** — This is the core constraint
2. **Content scripts** — Must be self-contained (no imports)
3. **New error codes** — Update both types.ts and messages.json
4. **New messages** — Use messaging.ts types, verify sender.id
5. **Filenames** — Use sanitizeSegment() for user input

## Node Version

Requires Node 22.13+ (check `.nvmrc`)
