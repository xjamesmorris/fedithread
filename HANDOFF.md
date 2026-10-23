# fedithread handoff

Live at https://xjamesmorris.github.io/fedithread/,
source at https://github.com/xjamesmorris/fedithread, deployed by GitHub Pages
from the `main` branch root.

## lennart-mode implementation

The repository includes tagged-author mini-blogs. Deployment uses the existing
`main`-branch GitHub Pages setup; the app itself has no automatic publishing
or GitHub integration.

Paste `https://mastodon.social/@pid_eins/tagged/systemd262` to build an
oldest-first index, individual articles, or Read all. Membership is literal:
all matching author threads, including announcements; repeated tagged
continuations resolve to one article. The author narrative is the existing
earliest self-reply chain plus paths/continuations needed to retain tagged
branches. Conversations with other authors are not silently added to the
narrative. Discussion is optional and off by default.

HTML ZIP and Markdown ZIP produce linked document trees, including a combined
document, local images/emoji, and a completion/provenance manifest. HTML has no
scripts and opens from disk; Markdown uses a root README and relative links.
Audio/video stay external; sensitive images stay labeled links. Missing media
or content requires an explicit partial-save confirmation, and the resulting
pages/manifest are labeled. Image budgets are 10 MiB each/50 MiB total; the
STORE-only ZIP writer caps output at 64 MiB. No dependencies or build step were
added.

The collector first exhausts the tagged account endpoint, then scans the
author's timeline once to recover untagged continuations. It does not launch
the old full collector for every article. Opaque string cursors, shared
in-memory caches and a strict 80-request batch budget make Continue resumable.
API calls are currently serialized (within the maximum-four requirement);
HTTP 429 stops work without an automatic retry loop. Parent and discussion
gaps are surfaced rather than swallowed.

The reference read produced 37 roots in nine API requests: all 35 roots in
Lennart's blog index, plus two cross-tagged announcements. The representative
first/eighteenth/last articles had 4/3/7 narrative statuses. These are snapshot
observations, not production constants or a promise about future live counts.
The tag really does include the older announcement; do not "fix" it by
silently filtering to the numbered articles.

New routes retain `?url=`; series `&post=<root-id>` selects an article and
`&view=all` selects Read all. `js/share.js` canonicalizes these without including
home-instance or discussion settings. Same-collection navigation reuses
completed work; a new input clears it. Abort/stale-result guards apply to
collection, clipboard completion, image downloads and ZIP creation.

The build panel is a small inline SVG/CSS book animation, with real phase/count
text, Pause/Continue and a reduced-motion version. It is also used for image
collection and ZIP generation; the ZIP CRC loop yields so cancellation and
animation remain responsive.

### Review and verification

Run `npm test` from the repository root, then `npm run serve` and open
`http://localhost:8000/`. Check the reference tagged URL, oldest-first
index/article/Read all navigation, the default-off discussion option, clean
Share links, both ZIP formats, and partial-export confirmation. Also check an
ordinary status URL to verify the original toolbar, forks, Reply and individual
HTML/Markdown saves remain available.

Offline automated tests cover multi-page discovery, untagged continuations,
deduplication and tagged branches, exact request-budget/resume behavior,
API errors/429/cancellation, archive navigation and asset rewriting, byte-limit
boundaries, unsafe image types, and ZIP CRC/path/size behavior.
The browser replay checks exercise the real DOM/sanitizer/main module,
history navigation, lazy discussion, clipboard races, cancellation, partial
confirmation and retry, legacy thread saves, and light/dark/reduced-motion
presentation. Generated ZIPs are also read by Python's independent ZIP reader.

No helper server is intended to remain running after verification. The next
review surface is the mini-blog UI plus extracted HTML/Markdown trees, not a
GitHub integration or deployment workflow.

## What it does

Paste a link to any post in a fediverse thread. The app resolves the host and
id from the link, collects the thread anonymously through that host's
Mastodon-compatible API, and renders it as one page. The root author's
self-reply chain is the expanded main line. Replies from other people are
collapsed forks under their parent post, expanded in place. The pasted post is
outlined and scrolled into view. `?url=` makes any view shareable.

## Decisions already made

- **Main line** = the root author's self-reply chain (earliest self-reply at
  each step) plus the path from the pasted post up to the root. Everything else
  is a fork. Agreed with the owner before implementation.
- **Vanilla ES modules, no build, no dependencies.** Must keep working straight
  from a GitHub Pages checkout. Tests use `node --test` only.
- **Anonymous only, no proxies.** API reads stay on the instance named in the
  link. Images may come from media/CDN URLs supplied by that instance; downloads
  omit credentials/referrers. Do not add a CORS proxy or uploading service.
- **Client-side sanitising** of status HTML through an allowlist even though the
  server already sanitises. Keep `js/sanitize.js` strict.

## Code map

| File | Role |
| --- | --- |
| `index.html` | Shell: form, status line, toolbar (expand/collapse, Share, Save as HTML/Markdown), share-link row, thread container |
| `css/style.css` | Layout and theme. Light and dark via `prefers-color-scheme` |
| `js/parse.js` | `parseStatusUrl(text)` -> `{host, id}` or null. Pure, tested |
| `js/api.js` | `getJson` with 15 s timeout and friendly error messages, `fetchStatus`, `fetchContext`, `fetchAccountStatuses`, `pLimit` |
| `js/thread.js` | `collectThread` (network), `buildTree`, `classifyNodes`, `countDescendants` (pure, tested) |
| `js/series.js` | `createSeries`, `collectSeries`, pure `groupArticles`/`seriesSnapshot`, resumable discovery and optional discussion |
| `js/sanitize.js` | Allowlist sanitiser, custom emoji substitution |
| `js/render.js` | Status cards, media, polls, content warnings, lazy fork groups, Reply and Open links |
| `js/series-render.js` | Index, article and Read all views using shared body/fork rendering |
| `js/settings.js` | Home instance in `localStorage`, `normalizeHost`, `replyUrl` (pure, tested) |
| `js/export.js` | `buildExport` (tree -> document model), `toHtml`, `toMarkdown`, `suggestedFileName`, plus a tiny HTML tokenizer and HTML-to-Markdown converter (pure, tested) |
| `js/share.js` | `statusRef` and `shareUrl`: the Share link, built from `{host, id, acct}` and checked against the parser (pure, tested) |
| `js/archive.js` | Image download limits, caching, failures and HTML/Markdown ZIP file maps |
| `js/zip.js` | STORE-only UTF-8 ZIP writer with CRCs, cancellation, size/path guards |
| `js/main.js` | Wiring, `?url=` deep links, history, progress text, Share button and clipboard, `fedithread:rendered` event |
| `test/*.test.js` | Parser cases, tree and main-line cases, collector against a mocked capped server, export documents, share-link round trips |

API access is centralized in `api.js`; thread/series collectors orchestrate it.
`archive.js` separately fetches referenced media. Pure collection/document/ZIP
logic is exported so it can be tested without a browser or live network.

## The one thing you must understand about the API

Anonymous `GET /api/v1/statuses/:id/context` returns at most 40 ancestors and a
60-descendant depth-first prefix, depth 20. Asking again for the same post
returns the same prefix. There is no pagination. So:

- A busy root's later direct replies are unreachable without a login. Mastodon's
  own logged-out web view has the same gap.
- The original poster's continuation can be buried past that prefix when early
  replies have their own subtrees. `collectThread` recovers it by paging the
  root author's own statuses forward with `min_id` from the root and keeping
  those whose parent is already known. It stops after 3 pages with no hits or 8
  pages total.
- A fill pass then requests context for every post that reports more replies
  than we have seen, up to a request budget of 80.
- Whatever is still missing is counted and shown in the status line as
  "about N more replies not reachable anonymously".

Dead end already tried: the ActivityPub replies collection
(`/users/:name/statuses/:id/replies`) lists everything, but the server sends no
CORS headers on it, so the browser cannot read it. Anonymous search cannot
resolve remote URLs either, which is why we never call `/api/v2/search`.

Other findings from live testing:

- Some instances set `DISALLOW_UNAUTHENTICATED_API_ACCESS` and return 401 for
  everything. tech.lgbt is one. The error message tells the user to paste the
  same post as seen from another instance, which works because the id in
  `https://host/@user@remote/ID` is local to `host`.
- Misskey-family servers have no Mastodon API and surface as a 404.
- `replies_count` often exceeds what any client can see, because it counts
  private and deleted replies. Do not treat a residual gap as a bug.

## How to verify

```
npm test                          # offline tests, no network
python3 -m http.server 8000       # ES modules do not load over file://
```

Then open `http://localhost:8000/?url=<post link>`. Useful live cases on
mastodon.social:

- A busy single post with 200+ replies, exercising the missing-replies count:
  `https://mastodon.social/@Gargron/115937278949559805`
- A six-post self-reply thread with forks between main-line posts:
  `https://mastodon.social/@malteengeler@legal.social/117069642737661732`
- A mid-thread reply from someone other than the author, to see the path
  expanded and the post highlighted: pick any reply inside the above.
- Error paths: an id like `1` on any host for 404, a tech.lgbt link for 401, a
  made-up host for the unreachable message.

Visual checks: see "Visual checks without a browser driver" below.

## Known gaps and rough edges

- Forks render lazily on first expand, but "Expand all forks" walks the DOM
  repeatedly until no closed groups remain. Fine for hundreds of posts, untested
  for thousands.
- Orphans (replies whose parent we never saw) render at the end under a
  "Replies to posts that could not be fetched" heading, one dashed
  placeholder card per missing parent (`orphanGroups` in `thread.js`), with
  the replies as a normal fork group below it. The placeholder names the
  missing post's author when `in_reply_to_account_id` matches an account we
  have seen. A root whose own parent is missing gets an "Earlier post not
  available" placeholder above it. Exports list orphans after the forks as
  "replying to a post by X that could not be fetched". Where an orphan really
  belongs in the thread is unknown, so the end is the only honest place.
- The only persisted setting is the home instance, under `localStorage`
  key `fedithread.home`. Discussion and collection progress stay in memory;
  starting a new source resets discussion to off.
- Fork groups summarise the first three authors and "N more". No per-fork
  descendant preview.
- The only style knobs are the CSS variables at the top of `css/style.css`.

## Reply hand-off (done)

Each card footer has a Reply link built by `replyUrl` in `js/settings.js`:

```
https://<home instance>/authorize_interaction?uri=<status.uri>
```

The home instance comes from the "Reply via your instance" box under the form,
normalised by `normalizeHost` (accepts a bare host, a URL, or `@user@host`).
When no home is set, clicking Reply highlights that box instead of navigating.
Links are rebuilt on every render and whenever the setting changes. Verified
that mastodon.social accepts that URL for a remote status: logged out it
redirects to `/auth/sign_in` and continues to the post after login. Other
Mastodon-API servers may not implement `authorize_interaction`; Pleroma and
Akkoma use different remote-interaction routes, which is a possible follow-up.
Reading stays anonymous; OAuth remains out of scope.

## Save as HTML / Markdown (done 2026-09-06)

Commits `1823614` (feature, together with the reply hand-off) and `f244f8d`
(footer fix), both on `main` and deployed.

Toolbar buttons "Save as HTML" and "Markdown" plus a "with forks" checkbox.
`main.js` keeps the last rendered `{ tree, main, result, host }` and hands it
to `buildExport` in `js/export.js`, then downloads the result through a Blob
URL. Layout of both documents: title (first line of the root post, or its CW,
80 chars max, known custom emoji shortcodes stripped), byline, main-line
posts as the article with a timestamp permalink under each, then a "Replies"
section with the forks flattened in depth-first order. Each reply carries
`depth` and `replyTo`; the HTML nests by indenting with a `--depth` variable
and links `#s-<id>`, Markdown stays flat and links the parent's permalink.
Sensitive media becomes a link instead of an inline image. Content warnings
render as a bold "CW:" line above the body. Markdown starts with YAML front
matter (title, author, date, source). The HTML has embedded CSS with a dark
scheme and no scripts. Images and emoji are linked from the instance, never
embedded. The footer names the instance the root post lives on (from its
permalink), "via" the queried instance when that differs, because the
"not reachable anonymously" count depends on which server answered. A small
"Powered by fedithread" link at the very bottom points to the source repository.

`export.js` is pure so it can be tested in node. It cannot use the DOM
sanitiser, so `statusContentHtml` in `sanitize.js` serialises the sanitised
fragment to a string and `export.js` re-parses that with its own ~40-line
tokenizer. The tokenizer only has to handle what the browser serialiser emits
for our allowlist (double-quoted attributes, `br` and `img` voids, the usual
entities). It is not a general HTML parser; do not feed it raw server HTML.

Markdown escaping is deliberately moderate: `* [ ] < \` and backticks always,
`_` only at word boundaries, `~~` when doubled, and `# > - + 1.` only at line
start. `<` must always be escaped or a post could inject HTML into the
document. Post headings are shifted down two levels so the document keeps h1
and h2 for itself. Meta lines use `<sub>` because there is no Markdown for
small text; renderers that strip HTML still show the content.

### Verified on live threads

Both reference threads from "How to verify" were exported from real data:

- Gargron birthday post: 59 posts in 5 requests, 1 main post, 58 replies, 2
  of them nested; about 150 replies unreachable, reported in the footer. A
  display name with an asterisk was escaped correctly, CJK and emoji passed
  through, a Misskey-style permalink was kept.
- malteengeler book thread: 14 posts in 6 requests, 6 main posts read as one
  article with forks between them, 8 replies nested to depth 2, an image with
  long alt text, hard line breaks, ellipsised links, umlauts folded in the
  file name but kept in the title.

The in-browser path (real sanitiser, Blob, anchor click) was exercised by
replaying recorded API responses in the harness and capturing the download;
the output matched the node run. The only thing not observed is the file
save dialog itself, since there is no WebDriver on the build machine.

### Export gaps

- Forks are flat in Markdown; a deeply nested discussion loses its shape
  there and only the "replying to" links recover it.
- No option for main line only in HTML with forks collapsed; "with forks"
  is all or nothing.
- Titles are cut at 80 characters mid-phrase with an ellipsis.
- The `Blob` download is a plain anchor click; Safari on iOS may open the
  file instead of saving it. Untested.

## Share link (done 2026-09-07)

The toolbar's Share button copies a link that reopens the thread with the
same post highlighted, and shows it in the `#share-row` box under the
toolbar. The requirement was a link with no user-specific information or
state, so `shareUrl` in `js/share.js` builds the `?url=` value from the
parsed `{host, id}` the app actually queried plus `result.start.account.acct`:

```
<page origin + path>?url=https://<host>/@<acct>/<id>
```

What it deliberately does not use:

- The raw pasted text. That can carry a tracking query, a `/deck/` or
  `/i/web/` path that says which client the sharer uses, or userinfo.
- `status.url`. For a remote post read through another instance that names
  a different host and a different id (`mastodon.social/@x@legal.social/117069642737661732`
  has `url` `legal.social/@x/117069642548297046`), and the origin host may
  refuse anonymous access. The queried host must stay in the link; it is the
  only place the id means anything. That host is often the sharer's own
  instance, which is why the button title says "the instance you read it
  through" rather than promising nothing about you.
- The home instance (`localStorage`), fork and CW state, the "with forks"
  box, the page's own query and hash. None of them reach the link.

`statusRef` checks each candidate with `parseStatusUrl` and falls back to the
bare `host/id` form when the handle is missing or unusable, so a link the app
emits is always one it can read. `https://host/id` without a handle does not
parse (the fallback needs two path segments), which is why the bare form is
scheme-less. If neither form re-parses (a non-numeric id under six
characters, seen on no real server) the hint says the link could not be
built. The value is percent-encoded with `:`, `/` and `@` restored so the
link reads as a link; `URLSearchParams` decodes both spellings the same way.

The click handler calls `navigator.clipboard.writeText` synchronously
(Safari needs the user activation) and updates the hint from the promise:
"Copied" on success, or focus and select the box with "Select and copy
this link" when the clipboard is denied or absent (LAN IP over plain http).
Focus stays on the button on success so screen readers hear the hint, not
the whole URL. `load()` now hides the toolbar and share row and clears
`current` before parsing, so pasting junk no longer leaves the previous
thread's Share and Save buttons live.

The takeover review found and fixed one lifecycle race in that reset:
`resetLoadedState()` now aborts the active request before a new value is
parsed. Invalid input can therefore no longer clear the page and then be
overwritten when an older request finishes. Navigating back to the empty page
does the same abort and clears the thread, Share value, toolbar state and page
title. Progress and clipboard promises are also tied to the active attempt, so
late completions cannot restore cleared messages or overwrite newer state.

Verified in the replay harness (malteengeler thread pasted as a `/deck/`
link with `?utm_source` and a fragment, home instance set to hachyderm.io):
the copied text was
`http://127.0.0.1:8001/harness-malte.html?url=https://mastodon.social/@malteengeler@legal.social/117069642737661732`,
and the denied and missing clipboard paths showed the fallback hint with
the box focused and selected. Dark scheme and a 420 px viewport checked.
The takeover used a deterministic headless-Firefox harness against the real
`main.js`; it also verified successful and denied clipboard paths, invalid
input and empty-history navigation during delayed fetches, full UI reset, and
reopening the generated link with the same status highlighted.

Known gap: the address bar still shows the raw paste percent-encoded
(tracking query included) because `load()` pushes `text.trim()`; the Share
button is the clean form. Making the pushed URL canonical would need the
handle, which is unknown until the fetch completes, or the bare form, which
would replace the user's text in the input on popstate.

## Visual checks without a browser driver

Headless Firefox `--screenshot` captures too early for live data: a shot of
the deployed site with a `?url=` shows the "Fetching…" state, even though
`main.js` awaits the first load at top level. What works, and what was used
today:

1. Record real responses from node: wrap `globalThis.fetch` around
   `collectThread`, save `{url: {status, body}}` as
   `window.FIXTURE = …` with `<` escaped as `\u003c`.
2. Serve the scratchpad on a spare port with an `app` symlink to the
   checkout. A harness page links `app/css/style.css`, imports
   `app/js/main.js`, splices the real `#toolbar` markup out of `index.html`
   with a regex, and replaces `window.fetch` with a lookup into the fixture
   that returns plain objects whose `json()` resolves in a microtask.
3. To capture a download, wrap `window.Blob` so the constructor records the
   parts synchronously, and stub `URL.createObjectURL` and
   `HTMLAnchorElement.prototype.click`. Then on `fedithread:rendered` click
   the Save buttons and write the captured text into the page. Anything that
   awaits `blob.text()` loses the race with the load event.
4. Exported HTML files need none of this; serve and screenshot them directly.
   Dark mode is `user_pref("ui.systemUsesDarkTheme", 1);` in the profile.

The harness files live in the session scratchpad, not the repo; each is
under 60 lines.

## Gotchas hit during the build

- The toolbar has `display: flex` in CSS, which overrides the `hidden`
  attribute. `#toolbar[hidden] { display: none }` fixes it; keep that pattern
  for any new element that both has a display rule and gets toggled with
  `hidden`.
- `parseStatusUrl` allows hosts without a dot only for `localhost`, and
  `statusApiUrl` uses plain http for it, so a local dev instance works.
- Status ids are strings. Mastodon's are numeric snowflakes, GoToSocial's are
  ULIDs. Sort by length then lexically, never by `Number()`, outside tests.
