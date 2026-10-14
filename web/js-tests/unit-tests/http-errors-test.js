//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the language of a request failure's message.
 *
 * `fetchJson` joins a caller's `errorPrefix` to what went wrong, and that
 * message is UI text: under en-XA every form it writes is translated. A failure
 * with no prefix carries only the status and the server's own words, which is
 * what a caller whose error the model reads builds its English from — so that
 * form stays as it is, and so does the pinboard transport's, which a tool reads.
 * @module unit-tests/http-errors
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized, pseudoLocalize } from '../../sdk/lib/i18n.js';
import { fetchJson, httpErrorText, HttpError } from '../../js/services/http.js';
import { applyPinboardOperations } from '../../js/services/pinboard-operations-api.js';

/**
 * Swap `window.fetch` for `stub` while `fn` runs.
 * @param {(input: any, init?: any) => Promise<Response>} stub
 * @param {() => Promise<void>} fn
 */
async function withFetch(stub, fn) {
  const real = window.fetch;
  window.fetch = /** @type {any} */ (stub);
  try {
    await fn();
  } finally {
    window.fetch = real;
  }
}

/**
 * A fetch answering every request with `status` and `body`.
 * @param {number} status
 * @param {string} body
 * @returns {(input: any, init?: any) => Promise<Response>} The stub.
 */
function answering(status, body) {
  return async () => new window.Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A fetch that never answers, until the request is aborted.
 * @returns {(input: any, init?: any) => Promise<Response>} The stub.
 */
function hanging() {
  return (/** @type {any} */ _input, /** @type {any} */ init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

/**
 * The message `fn` rejects with.
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>} The rejection.
 */
async function rejection(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the request to fail');
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => Promise<void>} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const prefix = pseudoLocalize('Load failed');
  const url = '/api/http-errors-test';

  await run('under en-XA every message fetchJson writes is translated', async () => {
    await underPseudoLocale('http-errors-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      await withFetch(answering(500, JSON.stringify({ error: '7' })), async () => {
        shown['prefix + detail'] = (await rejection(() => fetchJson(url, { errorPrefix: prefix }))).message;
      });
      await withFetch(answering(500, ''), async () => {
        shown['prefix + status'] = (await rejection(() => fetchJson(url, { errorPrefix: prefix }))).message;
      });
      await withFetch(hanging(), async () => {
        shown['prefix + timeout'] = (await rejection(() => fetchJson(url, { errorPrefix: prefix, timeoutMs: 20 }))).message;
        shown['timeout'] = (await rejection(() => fetchJson(url, { timeoutMs: 20 }))).message;
      });
      shown['httpErrorText fallback'] = httpErrorText(new HttpError('HTTP 500', 500, ''));
      shown['httpErrorText of a non-Error'] = httpErrorText('x');
      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(Object.fromEntries(raw))}`);
    });
  });

  await run('under en-XA a failure with no prefix is the status and the server\'s words', async () => {
    await underPseudoLocale('http-errors-test', async () => {
      await withFetch(answering(404, JSON.stringify({ error: 'no such thing' })), async () => {
        const err = await rejection(() => fetchJson(url));
        assert(err instanceof HttpError && err.status === 404 && err.detail === 'no such thing',
          `expected an HttpError carrying the status and detail, got ${String(err)}`);
        assert(err.message === 'HTTP 404: no such thing', `got ${JSON.stringify(err.message)}`);
      });
    });
  });

  await run('under en-XA the pinboard transport, which a tool reads, fails in English', async () => {
    await underPseudoLocale('http-errors-test', async () => {
      await withFetch(answering(409, JSON.stringify({ error: 'board is gone' })), async () => {
        const err = await rejection(() => applyPinboardOperations('main', []));
        assert(err instanceof HttpError && err.status === 409, `expected an HttpError, got ${String(err)}`);
        assert(err.message === '[Pinboard] Operation failed: board is gone', `got ${JSON.stringify(err.message)}`);
      });
      await withFetch(answering(500, ''), async () => {
        const err = await rejection(() => applyPinboardOperations('main', []));
        assert(err.message === '[Pinboard] Operation failed (HTTP 500)', `got ${JSON.stringify(err.message)}`);
      });
    });
  });

  return { passed, failed, errors };
}
