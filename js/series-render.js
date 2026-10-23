import { h, renderBody, renderThread } from './render.js';
import { safeHttpUrl, archiveId } from './export.js';
import { seriesShareUrl, shareUrl } from './share.js';
import { getHomeInstance, replyUrl } from './settings.js';

const date = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function renderSeries(snapshot, { pageUrl, route }) {
  const { target, articles } = snapshot;
  const link = (text, selection = {}) => h('a', {
    href: seriesShareUrl(pageUrl, target, selection), dataset: { seriesNav: 'true' },
  }, text);
  const container = h('div', { class: 'series' },
    h('header', { class: 'series-header' },
      h('p', { class: 'eyebrow' }, 'lennart-mode'),
      h('h1', {}, snapshot.title),
      h('p', { class: 'muted' }, `${articles.length} article${articles.length === 1 ? '' : 's'} · oldest first`,
        articles.length ? ` · ${date(articles[0].root.created_at)} – ${date(articles.at(-1).root.created_at)}` : ''),
      h('p', {}, h('a', { href: snapshot.source, target: '_blank', rel: 'noopener noreferrer' }, 'Original tagged collection'))));
  if (snapshot.warnings.length) container.append(h('aside', { class: 'series-notice', role: 'note' },
    h('strong', {}, 'This collection is incomplete.'),
    h('ul', {}, snapshot.warnings.map((w) => h('li', {}, w)))));
  if (!articles.length) {
    container.append(h('p', {}, snapshot.complete ? 'No public posts match this author and tag.' : 'No articles are available yet. Continue or retry the collection.'));
    return container;
  }
  const renderArticle = (article, index) => {
    const root = article.root;
    const story = h('article', { class: 'story', id: `entry-${archiveId(article.id)}` },
      h('header', {},
        h('h2', {}, article.title),
        h('p', { class: 'byline' }, h('a', { href: safeHttpUrl(root.account.url) || snapshot.source, target: '_blank', rel: 'noopener noreferrer' }, root.account.display_name || target.acct), ` · ${date(root.created_at)}`)));
    const nav = h('nav', { class: 'series-nav', 'aria-label': 'Article navigation' }, link('Index'), link('Read all', { view: 'all' }));
    if (index > 0) nav.append(link('Previous', { post: articles[index - 1].id }));
    if (index + 1 < articles.length) nav.append(link('Next', { post: articles[index + 1].id }));
    story.append(nav);
    for (const note of article.notes) story.append(h('p', { class: 'series-notice' }, note));
    const pending = [article.tree.byId.get(article.id)];
    while (pending.length) {
      const status = pending.pop();
      if (!status) continue;
      const original = safeHttpUrl(status.url || status.uri);
      story.append(h('section', { class: 'story-fragment', id: `entry-${archiveId(article.id)}-s-${archiveId(status.id)}` },
        renderBody(status),
        h('p', { class: 'meta' },
          h('a', { href: original || snapshot.source, target: '_blank', rel: 'noopener noreferrer' }, `Original post · ${date(status.created_at)}`),
          status.edited_at ? ' · edited' : '',
          ' · ', h('a', {
            class: 'reply', href: replyUrl(getHomeInstance(), status) || '#',
            dataset: { uri: status.uri || status.url || '' }, target: '_blank', rel: 'noopener noreferrer',
          }, 'Reply'))));
      pending.push(...(article.tree.children.get(status.id) || []).filter((s) => article.main.has(s.id)).reverse());
    }
    const reader = shareUrl(pageUrl, { host: target.host, id: article.id, acct: root.account.acct });
    story.append(h('p', {}, h('a', { href: reader || safeHttpUrl(root.url), target: '_blank', rel: 'noopener noreferrer' }, 'Open the full thread reader')));
    if (snapshot.includeDiscussion) {
      const { element, forks } = renderThread(article.tree, article.main, {
        host: target.host, rootId: article.id, startId: article.id, discussionOnly: true,
        idPrefix: `discussion-${archiveId(article.id)}-s-`,
      });
      const details = h('details', { class: 'series-discussion' },
        h('summary', {}, article.discussionComplete ? 'Discussion' : 'Discussion (not finished loading)'),
        forks.length ? element : h('p', { class: 'muted' }, article.discussionComplete ? 'No reachable discussion replies.' : 'Discussion has not finished loading.'));
      story.append(details);
    }
    return story;
  };
  if (route.post) {
    const index = articles.findIndex((a) => a.id === route.post);
    if (index >= 0) container.append(renderArticle(articles[index], index));
    else container.append(h('p', { class: 'series-notice' }, 'That article is not available in this collection. ', link('Back to index')));
  } else if (route.view === 'all') {
    container.append(h('nav', { class: 'series-nav' }, link('Index')));
    container.append(h('ol', { class: 'series-index' }, articles.map((a) => h('li', {}, h('a', { href: `#entry-${archiveId(a.id)}` }, a.title)))));
    for (const [index, article] of articles.entries()) container.append(renderArticle(article, index));
  } else {
    container.append(h('nav', { class: 'series-nav' }, link('Read all', { view: 'all' })));
    container.append(h('ol', { class: 'series-index' }, articles.map((a) => h('li', {},
      link(a.title, { post: a.id }),
      h('p', { class: 'muted' }, `${date(a.root.created_at)} · ${a.main.size} source post${a.main.size === 1 ? '' : 's'}`)))));
  }
  return container;
}
