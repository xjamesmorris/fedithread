# fedithread handoff

Status as of 2026-09-06. Live at https://xjamesmorris.github.io/fedithread/,
source at https://github.com/xjamesmorris/fedithread, deployed by GitHub Pages
from the `main` branch root.

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
- **Anonymous only, no proxies.** The page talks only to the instance named in
  the link. Do not add a CORS proxy; the footer promises this to users.
- **Client-side sanitising** of status HTML through an allowlist even though the
  server already sanitises. Keep `js/sanitize.js` strict.

## Code map

| File | Role |
| --- | --- |
| `index.html` | Shell: form, status line, toolbar (expand/collapse, Save as HTML/Markdown), thread container |
| `css/style.css` | Layout and theme. Light and dark via `prefers-color-scheme` |
| `js/parse.js` | `parseStatusUrl(text)` -> `{host, id}` or null. Pure, tested |
| `js/api.js` | `getJson` with 15 s timeout and friendly error messages, `fetchStatus`, `fetchContext`, `fetchAccountStatuses`, `pLimit` |
| `js/thread.js` | `collectThread` (network), `buildTree`, `classifyNodes`, `countDescendants` (pure, tested) |
| `js/sanitize.js` | Allowlist sanitiser, custom emoji substitution |
| `js/render.js` | Status cards, media, polls, content warnings, lazy fork groups, Reply and Open links |
| `js/settings.js` | Home instance in `localStorage`, `normalizeHost`, `replyUrl` (pure, tested) |
| `js/export.js` | `buildExport` (tree -> document model), `toHtml`, `toMarkdown`, `suggestedFileName`, plus a tiny HTML tokenizer and HTML-to-Markdown converter (pure, tested) |
| `js/main.js` | Wiring, `?url=` deep links, history, progress text, `fedithread:rendered` event |
| `test/*.test.js` | Parser cases, tree and main-line cases, collector against a mocked capped server, export documents |

Everything network-related lives in `collectThread`. Everything pure is
exported separately so it can be tested without a browser or network.

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
npm test                          # 66 tests, no network
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
- The only setting is the home instance. It lives under the `localStorage`
  key `fedithread.home`.
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
"not reachable anonymously" count depends on which server answered.

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
