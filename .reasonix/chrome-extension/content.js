/**
 * Reasonix Chrome Bridge — Content Script
 *
 * Injected into every page. Listens for commands from the background
 * script and executes them in the page context.
 */

// ─── Listen for commands from background script ───────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = COMMAND_HANDLERS[msg.command];
  if (handler) {
    handler(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true; // Keep channel open for async response
  }
  // Not for us
  return false;
});

const COMMAND_HANDLERS = {
  async click(msg) {
    const selector = msg.selector;
    if (!selector) return { error: 'selector required' };
    const el = document.querySelector(selector);
    if (!el) return { error: `Element not found: ${selector}` };
    el.click();
    return { clicked: true, selector };
  },

  async type(msg) {
    const selector = msg.selector;
    const text = msg.text;
    if (!selector || text === undefined) return { error: 'selector and text required' };
    const el = document.querySelector(selector);
    if (!el) return { error: `Element not found: ${selector}` };
    el.focus();
    if (el.value !== undefined) el.value = '';
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { typed: true, selector, length: text.length };
  },

  async extract(msg) {
    const selector = msg.selector;
    const attr = msg.attribute || 'innerText';
    if (selector) {
      const elements = document.querySelectorAll(selector);
      const values = Array.from(elements).map(el => {
        if (attr === 'innerText') return el.innerText;
        if (attr === 'textContent') return el.textContent;
        if (attr === 'href') return el.href || el.getAttribute('href');
        if (attr === 'src') return el.src || el.getAttribute('src');
        return el.getAttribute(attr) || el[attr];
      });
      return { count: values.length, values };
    }
    // Extract all interactive elements
    const interactive = [];
    document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"]')
      .forEach(el => {
        const tag = el.tagName.toLowerCase();
        const text = el.innerText?.trim?.() || el.textContent?.trim?.() || el.getAttribute('aria-label') || '';
        if (text.length > 1 || tag === 'input' || tag === 'textarea') {
          interactive.push({
            tag,
            text: text.slice(0, 100),
            href: el.href || undefined,
            type: el.type || undefined,
            placeholder: el.placeholder || undefined,
            selector: buildSelector(el),
          });
        }
      });
    return { count: interactive.length, elements: interactive.slice(0, 200) };
  },

  async evaluate(msg) {
    const code = msg.code;
    if (!code) return { error: 'code required' };
    const result = eval(code);
    return { result: typeof result === 'string' ? result.slice(0, 5000) : JSON.stringify(result).slice(0, 5000) };
  },

  async scroll(msg) {
    const direction = msg.direction || 'down';
    const amount = msg.amount || window.innerHeight * 0.8;
    if (direction === 'down') window.scrollBy(0, amount);
    else if (direction === 'up') window.scrollBy(0, -amount);
    else if (direction === 'to_top') window.scrollTo(0, 0);
    else if (direction === 'to_bottom') window.scrollTo(0, document.body.scrollHeight);
    return { scrolled: direction, x: window.scrollX, y: window.scrollY };
  },

  async screenshot() {
    // Content script can't screenshot directly; forward to background
    return { error: 'use screenshot_full command (handled by background)' };
  },

  async get_page_info() {
    return {
      title: document.title,
      url: window.location.href,
      text_length: document.body.innerText?.length || 0,
      links: document.querySelectorAll('a[href]').length,
      forms: document.querySelectorAll('form').length,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY },
    };
  },
};

function buildSelector(el) {
  if (el.id) return `#${el.id}`;
  if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).filter(c => !c.startsWith('_')).slice(0, 2);
  if (classes.length > 0) return `${tag}.${classes.join('.')}`;
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
    const idx = siblings.indexOf(el);
    if (siblings.length > 1) return `${tag}:nth-child(${idx + 1})`;
  }
  return tag;
}
