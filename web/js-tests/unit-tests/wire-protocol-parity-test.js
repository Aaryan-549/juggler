//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Wire-vocabulary parity: the JS tables that route server and worker messages
 * agree with the Go code that sends them.
 *
 * Both halves read ONE manifest (web/js-tests/fixtures/wire-protocol.json).
 * The Go half (TestWireParity* in cmd/juggler/worker and cmd/juggler/server)
 * holds the Go source to it; this half holds the JS tables to it:
 * `INBOUND_HANDLERS` against the worker's outbound types marked `jsHandler`,
 * `WebSocketService.TYPED_MESSAGE_ROUTES` against the server frames handled by
 * `routes`, `SESSION_MESSAGE_HANDLERS` against those handled by
 * `session-handlers`, `isRestingStatus` against each status's `holdsClaim`, which
 * the Go half checks against `statusHoldsClaim`, and
 * `Conversation.handleValidationNotice` against each validation code's
 * `bounced`, which the Go half checks against where the worker raises it.
 * @module unit-tests/wire-protocol-parity-test
 */

import { assert } from '../utilities/test-helpers.js';
import { INBOUND_HANDLERS } from '../../js/services/worker-manager-inbound.js';
import { WebSocketService } from '../../js/services/websocket.js';
import { SESSION_MESSAGE_HANDLERS } from '../../js/protocol/session-message-handlers.js';
import { isRestingStatus } from '../../js/model/processing-status.js';
import Conversation from '../../js/model/conversation.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * @typedef {object} WireManifest
 * @property {{
 *   outbound: Array<{type: string, jsHandler: boolean}>,
 *   processingStatuses: Array<{status: string, holdsClaim: boolean}>,
 *   validationCodes: {codes: Array<{code: string, bounced: boolean}>},
 * }} worker The worker's messages and statuses.
 * @property {{outbound: Array<{type: string, handledBy: string}>}} server The server's frames.
 */

/**
 * The difference between two sets, both ways, for a failure message.
 * @param {string} what - What the sets are
 * @param {Iterable<string>} inJs - What the JS table holds
 * @param {Iterable<string>} declared - What the manifest declares
 * @returns {void}
 */
function assertSameSet(what, inJs, declared) {
  const js = new Set(inJs);
  const manifest = new Set(declared);
  const extra = [...js].filter((v) => !manifest.has(v)).sort();
  const stale = [...manifest].filter((v) => !js.has(v)).sort();
  assert(extra.length === 0 && stale.length === 0,
    `${what}: in JS but not the manifest: [${extra.join(', ')}]; in the manifest but not JS: [${stale.join(', ')}]`);
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /** @type {WireManifest|null} */
  let manifest = null;
  try {
    const res = await fetch(new URL('../fixtures/wire-protocol.json', import.meta.url));
    assert(res.ok, `failed to fetch the wire manifest: HTTP ${res.status}`);
    manifest = await res.json();
  } catch (/** @type {any} */ e) {
    return { passed, failed: 1, errors: [`wire-protocol-parity: ${e?.message ?? e}`] };
  }
  const m = /** @type {WireManifest} */ (manifest);

  /**
   * @param {string} name - Case name
   * @param {() => void} fn - Case body
   */
  const run = (name, fn) => {
    try {
      fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e?.message ?? e}`);
    }
  };

  run('INBOUND_HANDLERS covers exactly the worker messages marked jsHandler', () => {
    assert(INBOUND_HANDLERS.size > 10, `INBOUND_HANDLERS has only ${INBOUND_HANDLERS.size} entries`);
    assertSameSet('worker → viewer message types',
      INBOUND_HANDLERS.keys(),
      m.worker.outbound.filter((o) => o.jsHandler).map((o) => o.type));
  });

  run('TYPED_MESSAGE_ROUTES covers exactly the server frames handled by routes', () => {
    const routes = Object.keys(WebSocketService.TYPED_MESSAGE_ROUTES);
    assert(routes.length > 10, `TYPED_MESSAGE_ROUTES has only ${routes.length} entries`);
    assertSameSet('server → viewer routed frame types',
      routes,
      m.server.outbound.filter((o) => o.handledBy === 'routes').map((o) => o.type));
  });

  run('SESSION_MESSAGE_HANDLERS covers exactly the server frames handled by session-handlers', () => {
    const handlers = Object.keys(SESSION_MESSAGE_HANDLERS);
    assert(handlers.length > 3, `SESSION_MESSAGE_HANDLERS has only ${handlers.length} entries`);
    assertSameSet('server → viewer session-scoped frame types',
      handlers,
      m.server.outbound.filter((o) => o.handledBy === 'session-handlers').map((o) => o.type));
  });

  run('isRestingStatus agrees with holdsClaim (Go: statusHoldsClaim)', () => {
    assert(m.worker.processingStatuses.length > 5, 'the manifest lists too few processing statuses');
    for (const { status, holdsClaim } of m.worker.processingStatuses) {
      assert(isRestingStatus(status) === !holdsClaim,
        `isRestingStatus('${status}') is ${isRestingStatus(status)}, but the manifest says holdsClaim ${holdsClaim}`);
    }
    assert(!isRestingStatus('a-status-nobody-declared'),
      'an undeclared status must hold the claim, as statusHoldsClaim treats it');
  });

  run('a validation-error hands the message back exactly when its code bounced the send', () => {
    assert(m.worker.validationCodes.codes.length > 2, 'the manifest lists too few validation codes');
    for (const { code, bounced } of m.worker.validationCodes.codes) {
      let restores = 0;
      const conv = Object.assign(Object.create(Conversation.prototype), {
        showWarning: () => {},
        restorePendingMessage: () => { restores++; },
        trySelfHealMissingModel: () => false,
      });
      conv.handleValidationNotice({ code, message: 'refused', threadItemId: 'thread-1' });
      assert(restores === (bounced ? 1 : 0),
        `validation code '${code}' (bounced ${bounced}) asked for the message back ${restores} time(s)`);
    }
  });

  return { passed, failed, errors };
}
