# fedithread

A small static web app that reads a Mastodon (fediverse) thread as one page.

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

Run the unit tests (URL parsing, tree building, main-line selection):

```
npm test
```

## Layout

| File | Purpose |
| --- | --- |
| `js/parse.js` | turn a pasted link into `{host, id}` |
| `js/api.js` | fetch with timeout and friendly error messages |
| `js/thread.js` | collect the thread (working around anonymous API caps), build the tree, pick the main line |
| `js/sanitize.js` | allowlist HTML sanitizer and custom emoji |
| `js/render.js` | cards, main line, collapsible forks |
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

## Future

The plan is to grow this into a light threaded reader where "reply" hands off
to your own client via your home instance's remote-interaction page.
