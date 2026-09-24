# exporter

A Chrome extension that turns the page you are looking at — or a single element
on it — into a PDF, entirely on your own device.

No account, no upload, no server, no telemetry. The extension makes zero network
requests, and that is enforced by a build-time check rather than by good
intentions.

> Built from the specification in `../company/exporter/`:
> [`01-requirements.md`](../company/exporter/01-requirements.md),
> [`02-project-structure.md`](../company/exporter/02-project-structure.md),
> [`03-build-prompts.md`](../company/exporter/03-build-prompts.md),
> [`04-roadmap.md`](../company/exporter/04-roadmap.md).

## What it does

- **Export the whole page.** Not a screenshot of the viewport — the full
  scrollable document, correctly paginated, with selectable text.
- **Export one element, or several.** Hover to highlight, click to pick. Each
  picked element becomes its own page, in document order — so you can pull three
  charts off a dashboard into a three-page PDF. `↑`/`↓` widen or narrow the
  highlight, `Space` picks the highlighted element, `Enter` exports, `Esc`
  cancels.
- **Labelled by where things land**, not by what they are: the picker names each
  element *First*, *Second*, *Third* — the page it will become — rather than
  showing you the site's tag and class names.
- **Trigger from** the toolbar icon or the right-click menu.
- **Options:** paper size (A4 / Letter / Legal / Tabloid / fit-to-content),
  include background colours and images, honour the site's own print stylesheet.
- **Names the file** after the page title and today's date, and opens Chrome's
  normal save dialog so you can change it.
- **Says why** when something cannot be exported, in a full sentence.

## Try it

**Node 22.13 or newer is required** — that is the lowest version the whole
toolchain installs on (Vite 8 wants >=22.12, ESLint 10 wants ^22.13). There is an
`.nvmrc`, so:

```bash
nvm use
```

Then:

```bash
npm ci && npm run build
```

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**,
and choose the `dist/` folder.

`npm ci` needs `package-lock.json`, which is committed — the toolchain is
installed from the lockfile, never resolved fresh.

On an unsupported Node, `npm ci` refuses outright (`engine-strict` in `.npmrc`)
and every script stops at a preflight check that names the version it needs,
rather than dying inside rolldown with `does not provide an export named
'styleText'` — which says nothing about the real cause.

## How it works

```
toolbar / context menu
        │
        ▼
background/service-worker.ts ── owns all state, one export at a time
        │
        ├─► content/page-readiness.ts    waits for fonts, images, lazy content
        ├─► content/element-picker.ts    hover-highlight + click-to-select
        │
        ├─► export/pdf-via-cdp.ts        primary: chrome.debugger + Page.printToPDF
        └─► export/pdf-via-canvas.ts     fallback: vendored html2canvas + jsPDF
        │
        ▼
export/filename.ts ──► chrome.downloads.download(saveAs: true)
```

### Two rendering paths

The **primary path** drives Chrome's own print engine through
`Page.printToPDF`. That is what makes the output a genuine paginated document —
selectable text, real page breaks, vector graphics — rather than a picture of a
page. It needs the `debugger` permission, so the debugger is attached for exactly
one `printToPDF` call and detached in a `finally` block that also runs on error
and on timeout.

The **fallback path** rasterizes the DOM with html2canvas and paginates the
bitmap with jsPDF. It runs automatically when the debugger cannot attach — most
often because DevTools already owns the tab. The popup says so when it happens,
because the text in that kind of PDF is not selectable.

Both sit behind the same small interface, on purpose: if the `debugger`
permission ever has to be dropped, the fallback becomes the only path and nothing
else changes.

### Exporting elements

`Page.printToPDF` has no clip region — only `Page.captureScreenshot` does, and
clipping a screenshot would throw away the selectable text that makes the CDP
path worth having. So instead of clipping the output, exporter narrows the
input: one injected stylesheet hides everything that is not a picked element, one
of their descendants, or one of their ancestors, and flattens the ancestor chains
so the content starts at the top-left of the sheet.

Multiple picks become multiple pages through that same stylesheet: every picked
element but the last gets `break-after: page`, so one `printToPDF` call yields
one page per element. Printing each element separately would mean merging PDFs
afterwards, which neither Chrome nor jsPDF can do.

Getting *exactly* one page per element is the hard part, and it is why the
ancestor reset is as long as it is. Anything that reserves vertical space around
the selection — a `min-height` on a full-bleed section wrapper, an `aspect-ratio`
box, a decorative `::after` — survives as an empty box that the forced break then
strands on a page of its own. Anything that changes how breaks propagate —
a multi-column ancestor, an inline-level or out-of-flow element — swallows the
break instead, and two elements share one page. Both failure modes are covered by
`tests/e2e`, which asserts *n* picked elements produce exactly *n* pages across
four hazard profiles.

One ordering detail matters: the isolation stylesheet is applied **before** each
element's own computed style is read. Flattening the ancestors can change what a
target's `display` computes to — CSS blockifies flex items, so a card inside a
flex container reports `block` until that container becomes a plain block, then
reverts to its authored `inline-block` and silently ignores the page break.

The canvas fallback needs none of that — it renders each picked element directly
and starts a new page for each, so isolation is applied only on the CDP path and
undone before the fallback runs.

Nothing is removed from the DOM, no inline styles are written, and the stylesheet
and its marker attributes are removed afterwards — including when the export
fails. An e2e test asserts the page carries no residue.

Two rules keep the output sane: picking an element that contains, or sits
inside, an existing pick replaces the ones it overlaps, so the same content
cannot land in the PDF twice; and clicking a pick again removes it.

## Working on it

| Command | What it does |
|---|---|
| `npm run build` | Builds `dist/`, loadable via **Load unpacked** |
| `npm run build:test` | Builds `dist-test/`, used only by the e2e suite |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | e2e against a real Chromium (see below) |
| `npm run lint` | ESLint, including the no-network / no-eval rules |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify:no-remote` | Fails if `dist/` contains any network or dynamic-code path |
| `npm run audit` | Advisories in the code that actually ships |
| `npm run audit:all` | Advisories anywhere, including build tooling |
| `npm run vendor` | Re-copies pinned libraries into `vendor/` |
| `npm run icons` | Regenerates the icons |
| `npm run package` | Zips `dist/` for the Chrome Web Store |
| `npm run screenshots` | Captures store screenshots and promo tiles into `store-assets/` (needs `build:test`) |
| `npm run check:node` | The Node version preflight the other scripts run first |

### Running the e2e suite

```bash
npm run build:test
npx playwright install chromium
npm run test:e2e
```

It drives a real Chromium with the extension loaded, exports both a full page and
a picked element, and checks the PDF Chrome actually wrote.

It runs against `dist-test/` rather than `dist/` for one reason: `activeTab` is
granted by clicking the toolbar icon, and Playwright cannot click one. The test
build adds a host permission in its place and renames itself so it cannot be
mistaken for the real thing. `npm run package` only ever zips `dist/`.

The e2e suite is deliberately not part of `npm test` or CI — it needs a browser
download and a headed-capable Chromium. Run it before a release.

### Build layout

MV3 needs two module formats, so `scripts/build.mjs` runs Vite more than once:

- **ES modules** for the service worker and the popup/options pages;
- **self-contained IIFEs** for the three scripts injected with
  `chrome.scripting.executeScript`, which Chrome loads as classic scripts and
  which therefore cannot have imports;
- a static copy pass for `manifest.json`, `_locales/` and the icons.

`02-project-structure.md` recommends `@crxjs/vite-plugin` and allows any
comparable bundler. Plain Vite is used here because those two formats are easier
to state as explicit passes than to configure a plugin to infer.

### Vendored libraries

`vendor/` is committed and holds the only third-party code that ships:
`jspdf` and `html2canvas`, copied from pinned exact versions by
`npm run vendor`. Nothing is fetched from a CDN, at build time or at runtime, and
CI fails if `vendor/` drifts from the lockfile.

## Security

The full pass lives in [`docs/security-notes.md`](docs/security-notes.md).
The short version:

- **No remote code, no network calls.** Enforced against the *built* output by
  `npm run verify:no-remote`, and against source by ESLint. First-party code is
  held to zero hits; every remaining reference inside the vendored bundle is
  enumerated with the reason it cannot execute.
- **No `content_scripts` in the manifest.** Nothing is injected on page load —
  only in response to a user action, into the tab they acted on.
- **Message senders are checked.** Every `onMessage` listener verifies
  `sender.id === chrome.runtime.id`. There is no `externally_connectable` and no
  `postMessage` handler, so a page cannot address the extension at all.
- **`chrome.debugger` is scoped to one call.** Attached, used for
  `Page.printToPDF`, detached — in a `finally`, including on error and timeout.
  No other DevTools domain is ever used.
- **Filenames are treated as hostile input.** A page's `<title>` reaches
  `chrome.downloads`, so `export/filename.ts` strips path separators, control and
  bidi characters, traversal segments and reserved device names, and the tests
  assert the result is always a single path segment.
- **Minimum permissions.** `activeTab` instead of host permissions;
  `storage.local` instead of `storage.sync`.

### A note on `storage`

`02-project-structure.md` §3 lists five permissions and says not to add
`storage` unless a real feature needs one. Phase 4 then asks for options
persisted via `chrome.storage.local`, which is that feature — so `storage` is in
the manifest, and its justification is written up alongside the others in
[`store-assets/listing-copy.md`](store-assets/listing-copy.md). If the options
page is ever dropped, this permission goes with it.

## Publishing

1. `npm ci && npm run lint && npm run typecheck && npm test`
2. `npm run build && npm run verify:no-remote && npm run audit`
3. `npm run build:test && npm run test:e2e`
4. `npm run package` → `artifacts/exporter-<version>.zip`
5. Work through the checklist in `03-build-prompts.md` phase 6, and the
   permission justifications and listing text in
   [`store-assets/listing-copy.md`](store-assets/listing-copy.md).
6. The privacy policy is published at
   <https://castiarena.github.io/exporter/privacy-policy.html>, from the public
   [`castiarena/exporter`](https://github.com/castiarena/exporter) repository,
   which also hosts the support issue tracker. [`docs/privacy-policy.md`](docs/privacy-policy.md)
   is the canonical copy: when it changes, copy it into that repository too.

Tagging `v*` builds and attaches the zip to a GitHub release. Uploading it to the
Chrome Web Store stays manual — it is a one-way door.

### Still to do before a first submission

- Check the name "exporter" for Web Store availability and trademark collisions

## What is not here

v1 is PDF only, on purpose — one output format is also what the Web Store's
single-purpose policy rewards. JPG, PNG with transparency, batch export and the
rest are scoped in [`04-roadmap.md`](../company/exporter/04-roadmap.md). The
pipeline is already format-agnostic where it needs to be: `filename.ts`, the
messaging contract and the status UI do not know that `pdf` is the only value
`ExportFormat` currently has.

## Licence

MIT — see [LICENSE](LICENSE).
