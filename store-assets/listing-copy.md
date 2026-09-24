# Chrome Web Store listing copy

Paste-ready text for the developer console. Placeholders in `<ANGLE_BRACKETS>`
must be filled in before the first submission.

---

## Name

```
exporter
```

> **Check before submitting.** "exporter" is a working name and is generic enough
> that the Web Store may already list something similar. Search the store, and
> check for trademark collisions, before the first submission
> (01-requirements.md §5, "No deceptive installation practices").

## Short description (132 characters max)

```
Turn any page, or just the parts you pick, into a clean PDF. Runs entirely on your device — no account, no upload, no tracking.
```

*(124 characters.)*

## Detailed description

Paste the full contents of [`description.txt`](description.txt) (about 7,000 of the
16,000 characters allowed). It is plain text on purpose: the store shows line
breaks but does not render Markdown. Every feature it mentions has been checked
against the code. If a feature changes, update that file in the same change.

## Category

Productivity → Workflow & Planning

## Single purpose statement

```
exporter has one purpose: converting the web page the user is viewing, or the
elements the user selects on it, into a PDF file saved on their own device.
```

## Permission justifications

The console asks for one per permission, 1,000 characters at most each. Each of these traces to a specific
feature; nothing is requested "just in case".

### `activeTab`

```
exporter needs to read the content of the page the user is exporting in order to
render it as a PDF. activeTab grants that access only for the tab the user has
just acted on, and only at the moment they act — which is exactly the scope this
extension needs. It is requested instead of host permissions specifically so the
extension has no standing access to any site.
```

### `scripting`

```
Three small scripts are injected into the page being exported, only after the
user starts an export:

1. a readiness pass that waits for web fonts and images to load and scrolls the
   document once so lazy-loaded content exists before rendering, otherwise long
   pages export with blank gaps;
2. the element picker, which draws the hover-highlight overlay and the selection
   markers for the "export selection" feature;
3. the fallback renderer, used only when Chrome's print engine is unavailable.

The extension registers no content_scripts in its manifest, so nothing is ever
injected on page load.
```

### `downloads`

```
Used once per export, to hand the finished PDF to Chrome's download flow so the
user can save it. The extension does not read, search or modify the user's
download history.
```

### `contextMenus`

```
Adds the two right-click entries, "Export page to PDF…" and "Export selected
elements to PDF…", which are the extension's primary trigger points alongside the toolbar
icon.
```

### `debugger`

```
exporter uses the debugger permission for one thing: Chrome's print-to-PDF engine,
which extensions can reach only through the DevTools protocol command
Page.printToPDF. That is what makes the output a real paginated PDF with
selectable, searchable text and vector graphics, the same as Chrome's own
"Save as PDF".

Scope: after the user starts an export, the debugger attaches to that one tab,
sends Page.enable and a single Page.printToPDF, and detaches immediately, in a
finally block that also runs on error or timeout. It is never attached in the
background or to any other tab, and no other DevTools domain is used: no network
inspection, no cookies or storage, no script evaluation.

If attaching fails (for example, DevTools is already open on that tab), exporter
renders the page itself instead and tells the user.
```

### `storage`

```
Stores the user's own export preferences — paper size, whether to include
background colours and images, whether to honour the site's print stylesheet — so
they do not have to be re-chosen on every export.

chrome.storage.local is used rather than chrome.storage.sync, deliberately: sync
would copy the settings through Google's servers, and this extension is built
around nothing leaving the user's device. No page content and no usage
information is stored.
```

## Privacy practices tab

- **Remote code:** "No, I am not using remote code". Everything the extension
  runs ships in the package; `npm run verify:no-remote` enforces it.

- **Privacy policy URL:** `https://castiarena.github.io/exporter/privacy-policy.html` (publish
  `docs/privacy-policy.md` at a stable URL first)
- **Data usage:** nothing collected, in every category
- **Not sold to third parties:** yes
- **Not used for unrelated purposes:** yes
- **Not used for creditworthiness or lending:** yes

## Support

- **Support email / issue tracker:** `https://github.com/castiarena/exporter/issues`
- **Homepage:** `https://castiarena.github.io/exporter/`

## Assets checklist

- [x] `store-assets/screenshots/` — four 1280×800 PNGs, regenerated with
      `npm run build:test && npm run screenshots`.
- [x] `store-assets/promo-tile.png` — 440×280, generated by the same script.
- [x] `store-assets/marquee.png` — 1400×560 marquee promo tile, same script.
      All images are 24-bit PNG with no alpha; the script fails if one is not.
- [ ] Icons at 16/32/48/128 — generated by `npm run icons`, committed in
      `src/icons/`.
