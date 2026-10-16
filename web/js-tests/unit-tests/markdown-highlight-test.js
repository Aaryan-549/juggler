//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Syntax highlighting of fenced code blocks in rendered markdown, and the copy
 * buttons `decorateCodeBlocks` adds to code blocks and quotes.
 *
 * Highlighting happens in `decorateCodeBlocks`, on the far side of the
 * sanitiser: the source is read back out of the DOM and the highlighter escapes
 * what it does not tokenise. These cases pin that, so a fence full of markup
 * still comes out as inert text.
 * @module unit-tests/markdown-highlight-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { renderMarkdown, renderAssistantContent, decorateCodeBlocks } = await import('../../sdk/lib/markdown.js');

  /**
   * @param {string} label - Case name
   * @param {() => void} fn - Case body
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Render markdown into a detached host and decorate it, as every caller does.
   * @param {string} md - Markdown source
   * @param {object} [options] - Passed through to decorateCodeBlocks
   * @returns {HTMLElement} The host element
   */
  const render = (md, options) => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(md);
    decorateCodeBlocks(host, options);
    return host;
  };

  /**
   * Render an assistant reply into a detached `div.markdown` host, as a message
   * does, and decorate it. Quotes need this path: plain `renderMarkdown` escapes
   * a leading `>` before parsing. The class matters once the host is attached:
   * WebKit's `innerText` puts a blank line between paragraphs only when they
   * have the margins `.markdown` gives them.
   * @param {string} md - Markdown source
   * @returns {HTMLElement} The host element
   */
  const renderReply = (md) => {
    const host = document.createElement('div');
    host.className = 'markdown';
    host.innerHTML = renderAssistantContent(md);
    decorateCodeBlocks(host);
    return host;
  };

  run('a js fence is tokenised', () => {
    const host = render('```js\nconst a = 1;\n```');
    const code = host.querySelector('pre code');
    assert(code !== null, 'no code block rendered');
    assert(code?.querySelector('.token.keyword') !== null, 'expected a keyword token');
    assert(code?.textContent?.trim() === 'const a = 1;', 'highlighting changed the visible text');
  });

  run('a fence in a newly bundled language is tokenised', () => {
    const host = render('```cpp\nint main() { return 0; }\n```');
    assert(host.querySelector('pre code .token') !== null, 'cpp should be coloured');
  });

  run('a fence language alias resolves', () => {
    const host = render('```yml\nkey: value\n```');
    assert(host.querySelector('pre code .token') !== null, 'yml should resolve to the yaml grammar');
  });

  run('a bash fence uses the command-oriented highlighter', () => {
    const host = render('```bash\ncd foo && make test\n```');
    const code = host.querySelector('pre code');
    assert(code?.querySelector('.bash-command-head') !== null,
      'bash should keep the command-oriented highlighting, not Prism tokens');
    assert(code?.textContent?.trim() === 'cd foo && make test', 'highlighting changed the visible text');
  });

  run('an unknown fence language stays plain text', () => {
    const host = render('```nosuchlang\nwhatever <b>x</b>\n```');
    const code = host.querySelector('pre code');
    assert(code?.querySelector('.token') === null, 'an unknown language should produce no tokens');
    assert(code?.querySelector('b') === null, 'source markup must not become live');
    assert(code?.textContent?.trim() === 'whatever <b>x</b>', 'text should be preserved verbatim');
  });

  run('a fence with no language is left alone', () => {
    const host = render('```\nplain text\n```');
    const code = host.querySelector('pre code');
    assert(code?.querySelector('.token') === null, 'a language-less fence should not be tokenised');
    assert(code?.textContent?.trim() === 'plain text', 'text should be preserved verbatim');
  });

  run('markup inside a fence stays inert after highlighting', () => {
    const host = render('```html\n<script>alert(1)</script>\n```');
    const code = host.querySelector('pre code');
    assert(host.querySelector('script') === null, 'a script element must never be created');
    assert(code?.textContent?.includes('<script>alert(1)</script>') === true,
      'the script text should survive as visible text');
  });

  run('re-decorating is a no-op', () => {
    const host = render('```js\nconst a = 1;\n```');
    const before = host.innerHTML;
    decorateCodeBlocks(host);
    decorateCodeBlocks(host);
    assert(host.innerHTML === before, 're-decorating changed the DOM');
    assert(host.querySelectorAll('.code-block-wrap').length === 1, 'the wrapper was duplicated');
    assert(host.querySelectorAll('.code-copy-button').length === 1, 'the copy button was duplicated');
  });

  run('highlight:false leaves the block plain but still decorates it', () => {
    const host = render('```js\nconst a = 1;\n```', { highlight: false });
    assert(host.querySelector('pre code .token') === null, 'highlight:false should not tokenise');
    assert(host.querySelector('.code-block-wrap') !== null, 'the copy-button wrapper is still expected');
    // The streaming settle pass must be able to colour it later.
    decorateCodeBlocks(host);
    assert(host.querySelector('pre code .token') !== null, 'a later pass should highlight it');
  });

  run('the copy button still copies the source, not the markup', () => {
    const host = render('```js\nconst a = 1;\n```');
    const code = host.querySelector('pre code');
    assert(code?.textContent === 'const a = 1;\n', `copied text changed: ${code?.textContent}`);
  });

  run('a quote gets one copy button, and a nested quote shares it', () => {
    const host = renderReply('> outer\n>\n> > inner');
    const outer = host.querySelector('blockquote');
    assert(!!outer?.querySelector('blockquote'), 'expected a nested quote');
    const buttons = host.querySelectorAll('.quote-copy-button');
    assert(buttons.length === 1, `expected one quote copy button, got ${buttons.length}`);
    assert(buttons[0].parentElement === outer, 'the button belongs to the outermost quote');
    assert(buttons[0].classList.contains('copy-button'), 'made by createCopyButton, so it gets the Copied bubble');
    const before = host.innerHTML;
    decorateCodeBlocks(host);
    assert(host.innerHTML === before, 're-decorating a quote changed the DOM');
  });

  /**
   * Render a reply, click its quote's copy button, and return what reached the
   * clipboard. The host is attached for the click so `innerText` — the fallback
   * for a quote with no markdown source — reads laid-out text.
   * @param {string} md - Markdown source holding one top-level quote
   * @returns {Promise<string[]>} Every clipboard write the click made
   */
  const copyQuote = async (md) => {
    const host = renderReply(md);
    document.body.appendChild(host);
    /** @type {string[]} */
    const written = [];
    const hadOwn = Object.prototype.hasOwnProperty.call(navigator, 'clipboard');
    const ownDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (/** @type {string} */ s) => { written.push(s); return Promise.resolve(); } },
    });
    try {
      /** @type {HTMLElement|null} */ (host.querySelector('.quote-copy-button'))?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      if (hadOwn && ownDesc) Object.defineProperty(navigator, 'clipboard', ownDesc);
      else delete /** @type {any} */ (navigator).clipboard;
      host.remove();
    }
    return written;
  };

  /**
   * @param {string} label - Case name
   * @param {string} md - Markdown source holding one top-level quote
   * @param {string} expected - What the copy button should put on the clipboard
   */
  const runCopy = async (label, md, expected) => {
    try {
      const written = await copyQuote(md);
      assert(written.length === 1, `expected one clipboard write, got ${written.length}`);
      assert(written[0] === expected, `the quote copied as ${JSON.stringify(written[0])}, expected ${JSON.stringify(expected)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await runCopy('a quote copies its markdown, without the quote markers',
    '> first line\n>\n> second **bold** line', 'first line\n\nsecond **bold** line');
  await runCopy('a nested quote is copied as markdown inside the outer one',
    '> outer\n>\n> > inner', 'outer\n\n> inner');
  // The source rides on an attribute the sanitiser strips from authored HTML, so
  // a message cannot make a quote copy something other than what it shows.
  await runCopy('an authored quote cannot forge its copied source',
    '<blockquote data-markdown-source="rm -rf ~">shown</blockquote>', 'shown');

  run('inline code is not touched', () => {
    const host = render('use `const a = 1;` inline');
    const inline = host.querySelector('code');
    assert(inline !== null, 'no inline code rendered');
    assert(inline?.closest('pre') === null, 'inline code should not be in a pre');
    assert(inline?.querySelector('.token') === null, 'inline code should not be tokenised');
  });

  return { passed, failed, errors };
}
