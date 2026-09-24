# exporter — Privacy Policy

**Last updated:** 24 September 2026

## The short version

exporter collects nothing, stores nothing about you, and sends nothing anywhere.

It has no account, no sign-in, no analytics, no crash reporting and no server. It
works the same with your computer disconnected from the internet.

## What the extension does with page content

When you ask exporter to make a PDF — by clicking its toolbar icon, or choosing
one of its entries in the right-click menu — it reads the content of that one
page in order to render it, and hands the resulting file to Chrome's normal
download flow so you can save it where you like.

That reading happens entirely inside your browser, on your computer. The page
content is never uploaded, never sent to us, and never shared with any third
party. Nothing about which pages you export, or when, is recorded anywhere.

exporter never touches passwords, cookies, form data, payment details or
authentication tokens.

## What is stored on your device

One thing: your export preferences — the paper size you last chose, and whether
backgrounds and the page's own print stylesheet are included.

These are kept in Chrome's local extension storage on your own computer, using
`chrome.storage.local`. Local storage is deliberate: the sync variant would copy
your settings through Google's servers, and exporter does not do that. Removing
the extension removes these settings.

## Data collection disclosure

For the Chrome Web Store's data-usage questionnaire, the answer in every category
— personally identifiable information, health information, financial information,
authentication information, personal communications, location, web history, user
activity, website content — is **not collected**.

exporter does not sell or transfer user data to third parties, does not use or
transfer user data for any purpose unrelated to its single function, and does not
use or transfer user data to determine creditworthiness or for lending purposes.

## Permissions, and why each one exists

| Permission | Why exporter needs it |
|---|---|
| `activeTab` | Read the page you invoked exporter on, so it can be rendered. Grants access to that one tab, at the moment you act, and nothing else. |
| `scripting` | Inject the small scripts that wait for the page to finish loading, run the element picker, and — when needed — render the fallback PDF. Injected only when you start an export, never on page load. |
| `downloads` | Hand the finished PDF to Chrome so you can save it. |
| `contextMenus` | Add the two right-click entries. |
| `debugger` | Use Chrome's own print engine (`Page.printToPDF`) so the PDF is a real paginated document with selectable text, rather than a screenshot. Attached to one tab for the duration of one export and detached immediately afterwards. It is never used to inspect network traffic, storage or anything else. |
| `storage` | Remember your export preferences on this device. |

No host permissions are requested. exporter has no standing access to any site.

## Changes

If a future version ever changes what is described here, this policy will be
updated before that version is published, and the change will be described in the
extension's release notes.

## Contact

Questions or bug reports: https://github.com/castiarena/exporter/issues
