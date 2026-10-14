//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { webFetch, uploadAssetBase64 } from 'juggler/ops';
import { formatFileSize } from 'juggler/item-utils';
import { translator } from 'juggler/i18n';

const t = translator('@juggler/core');

/**
 * @typedef {object} WebFetchParams
 * @property {string} url - The URL to fetch content from
 * @property {string} [goal] - Short user-facing label for extract mode
 * @property {string} [prompt] - What to extract from the page (optional; when set, the call delegates to a sub-agent)
 * @property {string} [session] - Existing WebFetch extraction session to continue
 */

/**
 * @typedef {object} WebFetchResult
 * @property {string} url - The URL that was fetched
 * @property {string} content - The extracted content (HTML converted to markdown)
 * @property {string} prompt - The prompt that was used
 * @property {boolean} cached - Whether the result was from cache
 * @property {boolean} [truncated] - Whether content was truncated
 * @property {boolean} [redirect] - Whether a redirect was detected
 * @property {string} [redirect_url] - The redirect URL if redirect is true
 * @property {string} [error] - Error message if redirect or failure
 * @property {boolean} [isImage] - The URL is an image: its bytes came back, not page text
 * @property {string} [mime] - An image's type
 * @property {number} [size] - An image's size in bytes
 * @property {string} [imageBase64] - An image's bytes, stored as `attachment` and then dropped
 * @property {import('../../../js/services/ops-api.js').AssetRef} [attachment] - The stored image
 */

/**
 * WebFetchContextItem - Fetch and process web content
 *
 * Fetches content from a URL and converts HTML to markdown for analysis.
 * Includes a 15-minute cache to avoid repeated fetches.
 * @class
 * @augments ContextItem
 */
class WebFetchContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'web', icon: 'icon-search' };
  }

  static MANIFEST = {
    id: 'web-fetch',
    name: 'Web Fetch',
    version: '2.0.0',
    description: 'Fetch and process web content',
    author: 'Juggler Team',
    requiresApproval: false,
    // With a `prompt`, buildSubthreadSpec fetches the page here and delegates to
    // a sub-agent with the page text already inlined in its seed — the child
    // answers from that text (never re-fetching) and only its answer returns, so
    // the page never enters the caller's context. Without a `prompt`,
    // buildSubthreadSpec returns null and the ordinary execute() runs, returning
    // the raw content.
    //
    // Deliberately NOT readOnlySubthread, despite a child whose whole brief is
    // to answer from text it was handed: the spec pins no strategy, so the child
    // inherits the caller's — up to and including one that writes without
    // asking. The claim is about what the child MAY do, not what its prompt asks
    // of it, and this one cannot be made truthfully.
    delegatesToSubthread: true
  };

  /**
   * Get tool definitions for WebFetch action
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    /** @type {import('juggler/strategy-type').JSONObjectSchema} */
    const inputSchema = {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'The URL to fetch content from'
        },
        goal: {
          type: 'string',
          description: 'Very short, single-line, user-facing label for EXTRACT mode (for example, "Find release date"). Ignored in RAW mode.'
        },
        prompt: {
          type: 'string',
          description: 'Leave UNSET to read the content (RAW). Set ONLY to ask one question about a large, noisy page you do not want in your context — the answer is a lossy summary, so never set it for a file you mean to read, quote, or work with (.md, .txt, JSON, source).'
        },
        session: {
          type: 'string',
          description: 'Optional WebFetch session name returned by an earlier EXTRACT call. Set it to continue that same page-reading session; ignored in RAW mode.'
        }
      },
      required: ['url']
    };

    const description = 'Fetch a URL. Two modes, chosen by whether you pass `prompt`:\n' +
      '• RAW (omit `prompt`) — the content itself, verbatim (HTML converted to markdown; .md/.txt/JSON/source as-is). Use whenever you want to read the content.\n' +
      '• EXTRACT (pass `prompt`) — a sub-agent reads the page and returns ONLY a lossy answer to your prompt; the page never enters this conversation. Only for large/noisy pages where you want one specific fact.\n' +
      'Default to RAW. 15-minute cache.';

    return [
      {
        name: 'WebFetch',
        category: 'read',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * Validate and normalize parameters for execution
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = /** @type {WebFetchParams} */ (toolInput);

    if (!params.url) {
      return { valid: false, error: 'Missing required parameter: url' };
    }
    if (typeof params.url !== 'string') {
      return { valid: false, error: 'Parameter "url" must be a string' };
    }
    if (params.goal !== undefined && params.goal !== null && typeof params.goal !== 'string') {
      return { valid: false, error: 'Parameter "goal" must be a string' };
    }
    if (params.session !== undefined && params.session !== null && typeof params.session !== 'string') {
      return { valid: false, error: 'Parameter "session" must be a string' };
    }
    // prompt is optional: with it, the call delegates to a sub-agent
    // (buildSubthreadSpec); without it, execute() returns raw content.
    if (params.prompt !== undefined && params.prompt !== null && typeof params.prompt !== 'string') {
      return { valid: false, error: 'Parameter "prompt" must be a string' };
    }

    // Basic URL validation
    try {
      new URL(params.url);
    } catch {
      return { valid: false, error: 'Parameter "url" must be a valid URL' };
    }

    return { valid: true, params: toolInput };
  }

  /**
   * Fetch the raw page once, here on the engine side. Its own method so tests
   * can stub the network.
   * @param {string} url - The URL to fetch
   * @returns {Promise<WebFetchResult>} Raw fetch result
   */
  async fetchRaw(url) {
    return /** @type {WebFetchResult} */ (await webFetch({ url }, this.signal));
  }

  /**
   * Delegate to a sub-agent only when there's something to extract. Critically,
   * we fetch the page HERE and inline its full text into the child's seed prompt,
   * so the child answers from content it was handed and never calls WebFetch
   * itself — inlining, not re-fetching, is what stops the recursive delegation
   * cascade. Without a prompt (nothing to extract), or if the fetch fails / has
   * no usable content, return null so the ordinary execute() runs and yields the
   * raw content (or surfaces the fetch error) to the caller.
   * @override
   * @param {Record<string, unknown>} toolInput - Validated tool input
   * @returns {Promise<import('juggler/context-item').SubthreadSpec | null>} Spec or null
   */
  async buildSubthreadSpec(toolInput) {
    const url = String(toolInput.url || '');
    const goal = toolInput.goal ? String(toolInput.goal).trim() : '';
    const prompt = toolInput.prompt ? String(toolInput.prompt) : '';
    if (!prompt) return null;

    let page;
    try {
      page = await this.fetchRaw(url);
    } catch {
      // Fetch failed on the engine side: don't delegate — let execute() run and
      // surface the fetch error to the caller the ordinary way.
      return null;
    }

    // A redirect isn't content to reason over, and an empty body means there's
    // nothing to inline — either way, fall back to execute() rather than seeding
    // a child with nothing.
    if (!page || page.redirect || !page.content) return null;

    return {
      goal: goal || 'Read web page',
      prompt:
        'You have been given the full text of a web page below. Using ONLY that text, ' +
        'answer the request. Do NOT fetch anything — the page content is already here.\n\n' +
        `# Request\n${prompt}\n\n` +
        `# Page: ${url}\n${page.content}`,
      resultSpec: 'the answer in markdown, quoting the page where relevant, or "not found in page" if the content does not answer the request',
      sessionName: toolInput.session ? String(toolInput.session).trim() : undefined
    };
  }

  /**
   * Execute the web fetch
   * @param {Record<string, unknown>} params - Prepared params from prepare
   * @returns {Promise<WebFetchResult>} Fetch result
   */
  async execute(params) {
    const fetchParams = /** @type {WebFetchParams} */ (params);
    const result = await this.fetchPage({ url: fetchParams.url, prompt: fetchParams.prompt });
    // An image is stored as the read tool stores one, and attached to the
    // result so the model is sent the image itself; its bytes never reach the
    // document.
    if (result?.isImage && typeof result.imageBase64 === 'string') {
      const base64 = result.imageBase64;
      delete result.imageBase64;
      result.attachment = await this.storeImage(base64, result.mime || 'application/octet-stream');
    }
    return result;
  }

  /**
   * Fetch a URL. Its own method so tests can stub the network.
   * @param {{url: string, prompt?: string}} params - What to fetch
   * @returns {Promise<WebFetchResult>} The fetch result
   */
  async fetchPage(params) {
    return /** @type {WebFetchResult} */ (await webFetch(params, this.signal));
  }

  /**
   * Store a fetched image in the conversation's assets. Its own method so
   * tests can stub the upload.
   * @param {string} base64 - The image's bytes
   * @param {string} mime - Its type
   * @returns {Promise<import('../../../js/services/ops-api.js').AssetRef>} The stored image
   */
  async storeImage(base64, mime) {
    const conversationId = this.conversation?.id;
    if (!conversationId) throw new Error('Couldn\'t attach the image: there is no conversation to keep it in.');
    return uploadAssetBase64(conversationId, base64, mime, this.signal);
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    const prepared = outcome.prepared;
    const prepParams = /** @type {{url?: string}} */ (prepared?.params || {});
    const url = prepParams.url || 'unknown';

    if (!outcome.success) {
      return this.failureSummary(outcome.error || `Failed to fetch ${url}`);
    }

    const result = /** @type {WebFetchResult} */ (outcome.result);

    // Handle redirect case
    if (result.redirect) {
      return this.successSummary(
        `Redirect detected: ${result.redirect_url}\n${result.error || ''}`,
        { icon: '→' }
      );
    }

    // An image: the pixels ride the result as an attachment, as a read
    // image's do, so the text only says what it is.
    if (result.attachment) {
      const ref = result.attachment;
      const dims = ref.width && ref.height ? `${ref.width}\u00d7${ref.height}` : 'image';
      const size = ref.bytes ? `, ${formatFileSize(ref.bytes)}` : '';
      return this.successSummary(
        `Fetched image ${result.url || url} (${dims}${size}). The image is attached below.`,
        { attachments: [ref] }
      );
    }

    // Build summary for LLM
    let summary = result.content || '';
    if (result.truncated) {
      summary += '\n\n(Content was truncated due to size limits)';
    }
    if (result.cached) {
      summary += '\n\n(From cache)';
    }

    return this.successSummary(this.truncateForLLM(summary));
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    const url = String(toolInput?.url || 'unknown');
    // Truncate URL for display
    const displayUrl = url.length > 60 ? url.substring(0, 60) + '...' : url;

    return this.buildStatusUI(actionStatus, {
      typeName: t('Web Fetch'),
      pending: t('Fetching {url}...', { url: displayUrl }),
      success: () => {
        const result = /** @type {WebFetchResult} */ (actionStatus?.result);
        if (result.redirect) return t('Redirect to: {url}', { url: result.redirect_url });
        if (result.cached && result.truncated) return t('{url} (cached) (truncated)', { url: displayUrl });
        if (result.cached) return t('{url} (cached)', { url: displayUrl });
        if (result.truncated) return t('{url} (truncated)', { url: displayUrl });
        return displayUrl;
      },
      failurePrefix: t('Failed')
    });
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(_toolName) {
    return 'Content';
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection to true when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers } = ctx;
    const url = input.url !== null && input.url !== undefined ? String(input.url) : '';
    helpers.addSubsection(wrapper, 'URL', url, 'properties-panel-code');
    if (input.prompt) {
      const p = input.prompt !== null && input.prompt !== undefined ? String(input.prompt) : '';
      helpers.addSubsection(wrapper, 'Prompt', p, 'properties-panel-code');
    }
  }
}

export default WebFetchContextItem;
