//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Juggler Extension SDK — `juggler/i18n`: translating UI text.
 *
 * ```js
 * import { translator } from 'juggler/i18n';
 * const t = translator('@me/my-extension');   // your extension id
 * label.textContent = t('Close');
 * status.textContent = t('{count, plural, one {# file changed} other {# files changed}}', { count });
 * ```
 *
 * English source text is the key and the fallback: with no catalogue for the
 * active language, `t()` returns the English, so wrapping a string changes
 * nothing until a translation exists. Call `t()` where text is rendered, never
 * at module scope — a module-level `t()` is fixed in whatever language was
 * active when the module loaded; English in a module-level table is wrapped in
 * `markForTranslation()` instead and passed to `t()` where it is shown. Text
 * the model reads (tool descriptions, prompts) stays English; mark it with
 * `markUntranslated()`.
 *
 * A sentence with a link or emphasis inside it keeps the markup out of the
 * message: the markup goes in a `{placeholder}`, and its own text is a message
 * of its own.
 *
 * ```js
 * const markup = { docs: `<a href="${url}">${escapeHtml(t('the docs'))}</a>` };
 * el.innerHTML = withHtml(t('See {docs} for setup.', htmlSlots(markup)), markup);
 * ```
 *
 * An extension ships its translations as files: the manifest's
 * `provides.i18n` names a directory of `<locale>.json` catalogues, each mapping
 * English source strings to translations, and the host registers the one for
 * the user's language under the extension's id before any of its code runs.
 * `translator(id)` returns a `t()` scoped to that id: the extension's own
 * catalogue first, then core's, never another extension's. A bare `t()` looks
 * in core's catalogue first, so an extension's catalogue can never re-word the
 * core UI. `registerCatalog(namespace, locale, messages)` is for translations
 * assembled at runtime. The formatters follow the user's language for numbers,
 * dates, relative times and lists (`formatList`).
 *
 * Message syntax, plural rules and the fallback chain are described in
 * `web/sdk/lib/i18n.js`. Everything here is DOM-free, so `juggler/i18n`
 * behaves identically in a viewer and in the engine worker.
 */

export {
  t,
  translator,
  serverText,
  markForTranslation,
  markUntranslated,
  htmlSlots,
  withHtml,
  registerCatalog,
  messageKey,
  getLocale,
  formatNumber,
  formatDate,
  formatRelativeTime,
  formatList,
} from './lib/i18n.js';
