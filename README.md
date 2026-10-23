# fedithread

A small static web app that reads a Mastodon (fediverse) thread as one page,
or an author's tagged threads as a mini-blog.

Paste a link to **any post in a thread**. fedithread finds the root, collects the
whole thread anonymously via the public Mastodon API, and renders it top to bottom.
The original poster's own replies form the **main line**. Replies from other
people are collapsed **forks** that expand in place. The post you pasted is
highlighted and scrolled into view.

No build step, no dependencies, no server. It runs straight from this repo on
GitHub Pages.

## Use it

Open the page and paste a URL, or link directly:

```
https://<you>.github.io/fedithread/?url=https://mastodon.social/@user/1234567890
```

Accepted link forms include Mastodon (`/@user/ID`, `/@user@remote/ID`,
`/users/name/statuses/ID`), GoToSocial (`/@user/statuses/ID`), Pleroma and
Akkoma (`/notice/ID`), Pixelfed (`/p/user/ID`), or just `host ID`.

## lennart-mode: a tagged mini-blog

Paste an author's tagged-posts URL, for example:

`https://mastodon.social/@pid_eins/tagged/systemd262`

fedithread collects the matching threads and presents an **index**, individual
articles with previous/next navigation, and **Read all** with a contents list.
Everything is oldest first. Each article combines the author's main self-reply
chain, including untagged continuations. Matching posts in the same thread are
deduplicated; tagged author branches are retained. Replies to other people do
not become part of the author's narrative.

This works for any author on an instance supporting the anonymous account APIs,
not only Lennart. It includes **all** matching threads, including announcements;
it does not try to infer which posts are editorially important. The original
`#systemd262` example includes two announcements as well as 35 numbered articles.

**Include discussion** is off by default. Enable it to load replies, kept
collapsed below the article. Each article also links to the existing full
thread reader. Share copies the collection and selected view, without your
reply instance or discussion preference. Collection links use `?url=`, with
`&post=<root-id>` for an article or `&view=all` for the combined view.

**Navigation pane** keeps a scrollable post list on the left and the selected
article on the right. Enabling it from the index opens the oldest article;
switching posts preserves the list's scroll position and reuses collected data.
On narrow screens the list stacks above the article. This layout is an
in-browser option; it does not change the layout of downloaded document trees.

**Join continuations** removes the artificial breaks between the author's
continuation posts. Paired boundary ellipses are joined with a single space:
`the cat...` followed by `...sat on the mat` becomes `the cat sat on the mat`.
Unicode ellipses work too. Formatting and real paragraph breaks are preserved;
warnings, media, polls, and separate reply branches remain distinct boundaries.
Original timestamps and links move into a collapsible **Source posts** section.
This option also applies to HTML and Markdown ZIPs. Ordinary ellipses inside
prose, code, or links are not rewritten.

Both options are off by default and reset on a new Read. Share and browser
history retain them through `&layout=sidebar` and `&join=1`.

A small animated book shows real collection/export progress; it becomes static
when your system requests reduced motion. **Pause** keeps collected data in this
tab, and **Continue** resumes it. API work is limited to 80 requests per batch.
Rate limits and errors stop work visibly rather than silently cutting off the
collection. Reloading or submitting a new Read starts a fresh collection.

### Save the mini-blog

**HTML ZIP** downloads a document tree with `index.html`, `all.html`, article
pages under `posts/`, local styles/images under `assets/`, and `manifest.json`.
Extract it and open `index.html`: no JavaScript, web server, or fedithread is
needed to read the saved pages.

**Markdown ZIP** has `README.md` as its index, `all.md`, individual Markdown
articles, and the same local images and manifest. Relative navigation and image
links let you copy the extracted tree into a GitHub repository. Uploading or
publishing is left to you; the app does not access GitHub.

Referenced images and custom emoji are bundled once and reused across articles.
Alt text, attribution, content warnings, source links, and any selected discussion
are preserved. Sensitive images remain labeled links; audio/video remain
external links and need a connection. HTML discussion is collapsed; Markdown
discussion is a separate section.

Images are limited to 10 MiB each and 50 MiB in total. PNG, JPEG, GIF, WebP and
AVIF are supported; active SVG/HTML assets are not bundled. CORS failures,
missing images, inaccessible posts, and unfinished collection are reported.
**Retry** can recover a failed image download; otherwise saving requires explicit
confirmation of a **partial archive**, labeled in its pages and manifest.
Missing images become labeled source links, not hidden network dependencies.

ZIPs are uncompressed to keep the app dependency-free. The total archive is
limited to 64 MiB; larger archives fail explicitly instead of dropping files.
Successfully downloaded images are cached only in the current collection's
memory, so saving the other format need not download them again.

## Reply from your own account

Type your instance (for example `mastodon.social` or `@you@hachyderm.io`) into
the "Reply via your instance" box. It is stored only in your browser. Each
post's **Reply** link then opens your instance's remote-interaction page for that
post, where you log in and reply with your normal client. Nothing else changes:
reading stays anonymous.

## Save a thread

Once a thread is loaded, the toolbar offers **Save as HTML** and **Save as
Markdown**. Both write a clean, self-contained document shaped like a blog
entry: title, byline, the main line as the article, then a Replies section with
the forks (untick "with forks" to leave those out). The HTML file has a few
lines of embedded CSS and no scripts. The Markdown file starts with YAML front
matter (title, author, date, source), so it drops straight into a static site
or wiki. Images and custom emoji are linked from the instance, not embedded.
A small **Powered by fedithread** link at the bottom points back to this source
repository.

## Share a thread

**Share** in the toolbar copies a link that reopens the thread you are looking
at, with the same post highlighted. The link is this page plus `?url=` and the
post's address, built from the instance you read the thread through, the
author's handle and the post id. Your reply instance, which forks you opened
and anything else about you are not in it. If the browser refuses the
clipboard, the link is shown in a box so you can copy it yourself. Starting
another read clears the previous Share link.

## Host it

1. Fork or push this repo to GitHub.
2. Settings → Pages → Build and deployment → Source: **Deploy from a branch**,
   branch `main`, folder `/ (root)`.
3. Visit `https://<you>.github.io/<repo>/`.

## Develop

ES modules do not load over `file://`, so serve the directory:

```
python3 -m http.server 8000
# then open http://localhost:8000/
```

Run the offline tests (parsing, collection/resume, thread classification,
exports, relative links, image limits, ZIP generation, sharing):

```
npm test
```

## Layout

| File | Purpose |
| --- | --- |
| `js/parse.js` | turn a pasted link into `{host, id}` |
| `js/api.js` | fetch with timeout and friendly error messages |
| `js/thread.js` | collect the thread (working around anonymous API caps), build the tree, pick the main line |
| `js/series.js` | collect tagged author threads with one shared timeline scan, resumable budgets, and optional discussion |
| `js/sanitize.js` | allowlist HTML sanitizer and custom emoji |
| `js/render.js` | cards, main line, collapsible forks |
| `js/series-render.js` | mini-blog index, article and Read all views |
| `js/settings.js` | home instance setting and the remote-interaction reply URL |
| `js/share.js` | the Share link: this page with `?url=` pointing at the post |
| `js/export.js` | thread as a standalone HTML page or Markdown document |
| `js/archive.js` | bundle referenced images and assemble HTML/Markdown document trees |
| `js/zip.js` | bounded, dependency-free ZIP generation |
| `js/main.js` | wiring, `?url=` deep links, history |

## Limitations

- Public posts only. Anonymous access cannot see followers-only or private replies.
- Instances that disable anonymous API access (`DISALLOW_UNAUTHENTICATED_API_ACCESS`)
  return an error. Try the same post as seen from another instance.
- Servers without a Mastodon-compatible API (for example Misskey) are not supported.
- Anonymous context requests are capped by the server (40 ancestors, 60 descendants,
  depth 20), and asking again returns the same slice. fedithread recovers the
  original poster's continuation by paging their own posts, and fills subtrees by
  fetching context on deeper posts, up to a request budget. Replies to a busy post
  beyond its first 60 descendants cannot be reached anonymously; the status line
  says roughly how many are missing.
- Only the replies known to the instance in the link are shown. Remote replies the
  instance has never seen will be missing.
- Tagged collections require anonymous account lookup and author/tag filtering.
  Some otherwise thread-compatible servers do not support these. The app does
  not use a proxy, global hashtag search, or authentication as a workaround.
- API requests stay on the instance in the input URL. Displaying or bundling
  images can contact media/CDN URLs supplied by that instance, without
  credentials. Exports are generated locally; nothing is uploaded.
- Replies whose parent could not be fetched (deleted, private, or not visible
  anonymously) are shown at the end under a placeholder card for the missing post.

## Future

Possible next steps: richer fork previews.
