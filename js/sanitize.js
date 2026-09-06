// Allowlist HTML sanitizer for status content. The server already sanitizes,
// but we never trust remote HTML directly in our document.

const ALLOWED_TAGS = new Set(['P', 'BR', 'A', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SUP', 'SUB']);
const ALLOWED_CLASSES = new Set(['mention', 'hashtag', 'h-card', 'invisible', 'ellipsis', 'u-url']);
const SAFE_HREF = /^(https?:|mailto:|gemini:|gopher:|xmpp:|magnet:)/i;

function cleanNode(node, out) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.appendChild(document.createTextNode(child.nodeValue));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (!ALLOWED_TAGS.has(child.tagName)) {
      // Keep the text of disallowed elements (e.g. stray <div>), drop the tag.
      cleanNode(child, out);
      continue;
    }
    const el = document.createElement(child.tagName.toLowerCase());
    if (child.tagName === 'A') {
      const href = child.getAttribute('href') || '';
      if (SAFE_HREF.test(href.trim())) el.setAttribute('href', href.trim());
      el.setAttribute('rel', 'nofollow noopener noreferrer');
      el.setAttribute('target', '_blank');
    }
    const classes = (child.getAttribute('class') || '').split(/\s+/).filter((c) => ALLOWED_CLASSES.has(c));
    if (classes.length) el.setAttribute('class', classes.join(' '));
    cleanNode(child, el);
    out.appendChild(el);
  }
}

export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const frag = document.createDocumentFragment();
  cleanNode(doc.body, frag);
  return frag;
}

const SHORTCODE_RE = /:([a-zA-Z0-9_]+):/g;

// Replace :shortcode: in text nodes with <img> for known custom emoji.
export function applyCustomEmoji(root, emojis) {
  if (!emojis || emojis.length === 0) return root;
  const map = new Map(emojis.map((e) => [e.shortcode, e]));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const tn of textNodes) {
    const text = tn.nodeValue;
    if (!text.includes(':')) continue;
    let last = 0;
    let m;
    const parts = [];
    SHORTCODE_RE.lastIndex = 0;
    while ((m = SHORTCODE_RE.exec(text))) {
      const emoji = map.get(m[1]);
      if (!emoji) continue;
      if (m.index > last) parts.push(document.createTextNode(text.slice(last, m.index)));
      const img = document.createElement('img');
      img.className = 'emoji';
      img.src = emoji.static_url || emoji.url;
      img.alt = `:${m[1]}:`;
      img.title = `:${m[1]}:`;
      img.draggable = false;
      parts.push(img);
      last = m.index + m[0].length;
    }
    if (parts.length === 0) continue;
    if (last < text.length) parts.push(document.createTextNode(text.slice(last)));
    tn.replaceWith(...parts);
  }
  return root;
}

export function textWithEmoji(text, emojis) {
  const span = document.createElement('span');
  span.textContent = text || '';
  return applyCustomEmoji(span, emojis);
}
