# Security notes

A record of the security pass required by `01-requirements.md` §4 and phase 5 of
`03-build-prompts.md`, and of the decisions behind the parts that are not
self-evident from the code. Re-run this pass before every release.

## Automated checks

| Check | Command | Enforced in |
|---|---|---|
| No remote URLs, network APIs or dynamic code in the built extension | `npm run verify:no-remote` | `ci.yml`, `release.yml` |
| No `eval` / `new Function` / `fetch` / `XMLHttpRequest` in first-party source | `npm run lint` | `ci.yml` |
| Vendored libraries match the pinned lockfile versions | `npm run vendor` + `git diff --exit-code vendor/` | `ci.yml` |
| Advisories in code that ships | `npm run audit` (`npm audit --omit=dev --audit-level=low`) | `ci.yml`, `release.yml` |
| Advisories anywhere in the tree | `npm run audit:all` | `ci.yml` (report only) |
| Filename sanitisation, error classification, locale coverage | `npm test` | `ci.yml` |

`verify:no-remote` runs against `dist/`, not `src/`, so anything a dependency
drags in through bundling is caught too. It holds first-party output to zero hits
and requires every surviving reference inside the vendored bundle to be
enumerated with a reason it cannot execute.

### Why the audit is split in two

`jspdf` and `html2canvas` are declared as `dependencies`, not `devDependencies`,
because they are the only third-party code that ends up inside the published
extension. That makes `npm audit --omit=dev` an exact question — "is there a
known vulnerability in anything a user runs?" — and it is gated at
`--audit-level=low`, the strictest setting, in both CI and the release workflow.

The build and test toolchain (Vite, Vitest, ESLint, Playwright, TypeScript) is
audited too, but reported rather than enforced: an advisory in a bundler cannot
reach a user of the extension, and blocking releases on it invites the habit of
waving audits through. Both tiers are currently clean.

## Content Security Policy

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self';"
}
```

This is MV3's default and has not been loosened. No inline `<script>`, no
`'unsafe-eval'`, no remote sources. The popup and options pages load their
JavaScript from bundled files only.

## Remote code

None. MV3 forbids it, and this extension does not work around that:

- Both third-party libraries (`jspdf`, `html2canvas`) are pinned to exact
  versions, copied into `vendor/` by `scripts/vendor.mjs`, and bundled at build
  time. Nothing is fetched at runtime.
- jsPDF's only bare import (`@babel/runtime/helpers/typeof`) is vendored
  alongside it, so the dependency graph never leaves `vendor/`.
- jsPDF lazily `import()`s `canvg`, `dompurify` and `html2canvas` from inside its
  `.html()` API, which this extension never calls. Those specifiers are aliased
  to a throwing stub in `vite.config.ts`, so the code is not in the bundle at
  all.
- Vite's `modulepreload` polyfill is disabled, because it uses `fetch()`.

### Known inert references in `dist/content/pdf-via-canvas.js`

The vendored libraries ship their whole API surface, including parts this
extension does not use. Each surviving reference is listed in
`VENDOR_ALLOWANCES` in `scripts/verify-no-remote.mjs`:

- **`https://cdnjs.cloudflare.com/ajax/libs/pdfobject/…`** — reachable only via
  `jsPDF.output('pdfobjectnewwindow')`. This extension calls
  `output('datauristring')` and nothing else. The extension CSP would block the
  injected script even if the branch were reached.
- **`XMLHttpRequest`** — html2canvas feature-detects XHR support, and uses it
  only when its `proxy` option is set; this extension never sets it, and
  html2canvas throws rather than falling back to a default. jsPDF's copy is in
  its `save()` file-download helper, which this extension does not call.
- **Attribution and algorithm-provenance URLs** — string literals in library
  headers, never requested.

A dependency bump that introduces a *new* network path fails the check, which is
the point of enumerating rather than allow-listing by wildcard.

## `chrome.debugger` lifetime

The most sensitive permission in the manifest. Its use is confined to
`src/export/pdf-via-cdp.ts`:

- attached to exactly one tab, immediately before one `Page.printToPDF` call;
- detached in a `finally` block, so detach also runs on error and on the
  60-second render timeout;
- only `Page.enable` and `Page.printToPDF` are ever sent — no `Network`, no
  `Storage`, no `Runtime.evaluate`;
- never attached in response to anything but a user action.

If review or user feedback makes this permission untenable, the canvas path in
`src/export/pdf-via-canvas.ts` already implements the same contract, and the
permission can be dropped without touching anything else — that is why both paths
sit behind `export/pdf-via-*.ts`.

## Content script isolation

- `manifest.json` has **no** `content_scripts` key. Nothing is injected
  declaratively; every injection goes through `chrome.scripting.executeScript`
  from the background worker, triggered by a user action.
- Content scripts run in Chrome's isolated world by default. The element
  picker's overlay lives in a **closed** shadow root, so the page cannot read or
  rewrite it.
- Every `chrome.runtime.onMessage` listener — in both content scripts and the
  background worker — checks `sender.id === chrome.runtime.id` before acting.
  The extension registers no `externally_connectable` and no `window.postMessage`
  handlers, so a page cannot address it at all.
- The picker uses capture-phase listeners, so the underlying page never observes
  the clicks and keystrokes that drive it.

## Page mutation and restoration

Exporting elements hides the rest of the page with one injected `<style>`
element plus marker attributes: hidden, ancestor, target, the page-break marker
that puts each picked element on its own page, and two markers that pull an
out-of-flow or inline-level selection back into normal flow so the break applies
to it at all. Nothing is removed from the DOM and no
inline styles are written. `restorePage()` removes the stylesheet and every
marker, and it runs from the `finally` block of the export flow, so it runs on
failure too. An e2e test asserts the page carries no residue, including after a
cancelled pick.

Isolation is deliberately split from the print-stylesheet override
(`restoreIsolation()` vs `restorePage()`): isolation re-runs itself defensively,
and a single combined reset would silently drop the print-style override applied
moments earlier.

## Filename handling

`src/export/filename.ts` is treated as a security boundary: a page's `<title>` is
attacker-controlled and the result is passed to `chrome.downloads.download`,
which interprets `/` as a path separator. The sanitiser strips path separators,
control characters, invisible and bidi-override codepoints, collapses `..`,
refuses leading dots, caps length, and renames Windows reserved device names.
`tests/unit/filename.test.ts` asserts the output is always a single path segment,
including for traversal attempts.

## No credential or network access

The extension reads rendered DOM and visual content for the purpose of producing
a PDF. It does not read cookies, `localStorage`, form values or authentication
tokens, and requests no permission that would let it. There is no analytics SDK
and no crash reporter.

## Per-release checklist

1. `npm ci && npm run lint && npm run typecheck && npm test && npm run build`
2. `npm run verify:no-remote`
3. `npm audit` — resolve, or record the finding and the reason it is accepted
4. Diff `manifest.json` permissions against what the code actually calls; delete
   anything unused
5. Diff the packaged `dist/` against the previous release, especially after any
   dependency bump
6. Walk the pre-submission checklist in `03-build-prompts.md` phase 6
