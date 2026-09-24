# GitHub Copilot Instructions for exporter

## Project Summary

Chrome extension that exports web pages to PDF on-device. Makes zero network requests (enforced at build time).

## Critical Security Constraints

**NEVER suggest code that:**
- Uses `eval()`, `new Function()`, or dynamic code execution
- Uses `fetch()`, `XMLHttpRequest`, `WebSocket`, `EventSource`
- Makes any network requests
- Uses `console.log` (use `console.warn`, `console.error`, `console.debug` instead)

These are ESLint errors and will fail CI.

## Key Patterns

### Messaging (src/shared/messaging.ts)

```typescript
// All messages are typed
import type { CommandMessage, TabMessage } from './messaging';
import { sendToBackground, sendToTab, ok, err } from './messaging';

// Responses are always Response<T>
const result = await sendToBackground({ type: 'GET_STATE' });
if (!result.ok) return err(result.error);
```

### Message Handler Security

```typescript
// ALWAYS verify sender in onMessage handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  // ... handle message
});
```

### Content Scripts

Content scripts in `src/content/` are bundled as IIFE (no imports). Write self-contained code.

### Error Codes

```typescript
// Add new codes to EXPORT_ERROR_CODES in src/shared/types.ts
// Then add message to _locales/en/messages.json
export const EXPORT_ERROR_CODES = [
  'RESTRICTED_PAGE',
  // ... add new code here
] as const;
```

### Filename Sanitization

```typescript
// src/export/filename.ts handles attacker-controlled input
import { buildFilename, sanitizeSegment } from './filename';
// Always use these for user-provided filenames
```

## Type Conventions

- Use `import type { X }` for type-only imports
- No `any` — use `unknown` and narrow
- Prefix unused params with `_`

## Testing

- Unit tests: `tests/unit/*.test.ts` with Vitest
- E2E tests: `tests/e2e/*.spec.ts` with Playwright
- All error codes must have locale coverage (tested)

## Build

- `npm run build` — creates dist/
- Content scripts compile to IIFE, everything else to ES modules
- `npm run verify:no-remote` checks dist/ for network paths
