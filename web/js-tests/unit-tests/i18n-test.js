//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The `juggler/i18n` core (web/sdk/lib/i18n.js): message lookup, interpolation,
 * the ICU plural subset, catalogue fallback, the pseudo-locale and the
 * locale-aware formatters.
 *
 * The property everything else rests on is that English is always the answer
 * when nothing better exists: a missing catalogue, a missing key, or a message
 * that will not parse must each come back as the English source, never as a key,
 * an empty string or a thrown error — that is what lets UI files be wrapped one
 * at a time with nothing visible changing.
 *
 * Every case runs under a locale it sets itself and restores the previous one,
 * so the suite leaves the page in whatever state it found it.
 * @module unit-tests/i18n-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  t, registerCatalog, unregisterCatalog, markUntranslated, markForTranslation, setLocale, getLocale,
  formattingLocale, formatNumber, formatDate, formatRelativeTime,
  pseudoLocalize, isPseudoLocalized, messageKey, PSEUDO_LOCALE, htmlSlots, withHtml,
  translator, CORE_NAMESPACE,
} from '../../sdk/lib/i18n.js';
import * as facade from '../../sdk/i18n.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Resolves with the aggregated test result.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /** Namespaces registered by this suite, removed again at the end. */
  const NS = 'i18n-test';

  /**
   * Run one case under `locale`, restoring whatever was active before.
   * @param {string} label
   * @param {string} locale
   * @param {() => void} fn
   */
  const run = (label, locale, fn) => {
    const previous = setLocale(locale);
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLocale(previous);
    }
  };

  /**
   * @param {unknown} got
   * @param {unknown} want
   * @param {string} what
   */
  const eq = (got, want, what) => {
    assert(got === want, `${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };

  registerCatalog(NS, 'fr', {
    'Close': 'Fermer',
    'Hello, {name}': 'Bonjour, {name}',
    [messageKey('Open', 'verb')]: 'Ouvrir',
    [messageKey('Open', 'state')]: 'Ouvert',
    '{count, plural, one {# file} other {# files}}': '{count, plural, one {# fichier} other {# fichiers}}',
    'Broken {': 'Cassé {',
  });
  registerCatalog(NS, 'zh', { 'Close': '关闭' });
  registerCatalog(NS, 'zh-Hant', { 'Close': '關閉' });

  try {
    run('no catalogue: English source comes back', '', () => {
      eq(t('Close'), 'Close', 'unset locale');
      eq(getLocale(), 'en', 'an unset locale reads as English');
    });

    run('catalogue hit', 'fr', () => {
      eq(t('Close'), 'Fermer', 'fr Close');
    });

    run('missing key falls back to English, not the key or blank', 'fr', () => {
      eq(t('Not in any catalogue'), 'Not in any catalogue', 'missing key');
      eq(t('Count is {n}', { n: 3 }), 'Count is 3', 'missing key still interpolates');
    });

    run('interpolation', 'fr', () => {
      eq(t('Hello, {name}', { name: 'Jules' }), 'Bonjour, Jules', 'translated');
      eq(t('Bye, {name}', { name: 'Jules' }), 'Bye, Jules', 'English source');
      eq(t('Hi {name}'), 'Hi {name}', 'a missing parameter is left visible rather than blanked');
      eq(t('Port {port}', { port: 3939 }), 'Port 3939', 'a {name} number is not regrouped');
    });

    run('apostrophes in English text are literal', '', () => {
      eq(t("Can't reach {host}", { host: 'x' }), "Can't reach x", 'lone apostrophe');
      eq(t("It''s"), "It's", 'doubled apostrophe');
      eq(t("Use '{braces}' literally"), 'Use {braces} literally', 'quoted braces');
    });

    run('quoted text consumes doubled apostrophes', 'fr', () => {
      registerCatalog(NS + '-quotes', 'fr', { 'Use the example.': "Utilisez '{l''exemple}'." });
      try {
        eq(t('Use the example.'), "Utilisez {l'exemple}.", 'translated quoted apostrophe');
        eq(t("Use '{}', '{''}' and '{a''''b}'"), "Use {}, {'} and {a''b}", 'quoted syntax and apostrophes');
      } finally {
        unregisterCatalog(NS + '-quotes');
      }
    });

    run('selects preserve the nearest enclosing plural count', '', () => {
      const msg = '{n, plural, other {{gender, select, female {# tasks} other {{m, plural, other {# subtasks}} and # tasks}}}}';
      eq(t(msg, { n: 2, gender: 'female' }), '2 tasks', 'select inherits count');
      eq(t(msg, { n: 2, m: 3, gender: 'other' }), '3 subtasks and 2 tasks', 'inner plural shadows count');
      eq(t('{kind, select, other {# tasks}}', { kind: 'x' }), '# tasks', 'no enclosing plural');
    });

    run('pseudo-localisation preserves nested counts and quoted syntax', '', () => {
      const msg = "{n, plural, other {{kind, select, other {# tasks and '#' '{}'}}}}";
      const out = t(pseudoLocalize(msg), { n: 2, kind: 'x' });
      assert(out.includes('2') && out.includes('#') && out.includes('{}'), `count and literal syntax: ${out}`);
      assert(!/[A-Za-z]/.test(out), `pseudo text has no raw letters: ${out}`);
      const quoted = t(pseudoLocalize("Use '{l''exemple}' and '{}'."));
      assert(quoted.includes("{ļ'éẋéɱþļé}") && quoted.includes('{}'), `quoted text round-trips: ${quoted}`);
      assert(!/[A-Za-z]/.test(quoted), `quoted pseudo text has no raw letters: ${quoted}`);
    });

    run('context keeps homographs apart', 'fr', () => {
      eq(t('Open', undefined, { context: 'verb' }), 'Ouvrir', 'verb');
      eq(t('Open', undefined, { context: 'state' }), 'Ouvert', 'state');
      eq(t('Open'), 'Open', 'no context matches neither');
    });

    run('English plurals, including =0 and #', '', () => {
      const msg = '{count, plural, =0 {No files} one {# file} other {# files}}';
      eq(t(msg, { count: 0 }), 'No files', '=0');
      eq(t(msg, { count: 1 }), '1 file', 'one');
      eq(t(msg, { count: 2 }), '2 files', 'other');
    });

    run('plural branches interpolate and nest', '', () => {
      const msg = '{n, plural, one {{who} has # item} other {{who} has # items}}';
      eq(t(msg, { n: 1, who: 'Ann' }), 'Ann has 1 item', 'nested arg, one');
      eq(t(msg, { n: 5, who: 'Ann' }), 'Ann has 5 items', 'nested arg, other');
    });

    run('a translated plural uses the translation locale', 'fr', () => {
      const msg = '{count, plural, one {# file} other {# files}}';
      // French puts 0 in "one"; English puts it in "other".
      eq(t(msg, { count: 0 }), '0 fichier', 'fr 0 → one');
      eq(t(msg, { count: 2 }), '2 fichiers', 'fr 2 → other');
    });

    run('an untranslated plural uses English rules under another locale', 'fr', () => {
      const msg = '{count, plural, one {# thing} other {# things}}';
      eq(t(msg, { count: 0 }), '0 things', 'English rules for the English source');
    });

    run('a malformed translation never throws and never hides the text', 'fr', () => {
      eq(t('Broken {'), 'Broken {', 'falls back to the English source');
      eq(t('Also {broken'), 'Also {broken', 'malformed source comes back verbatim');
    });

    run('fallback chain walks to the language', 'zh-Hant-TW', () => {
      eq(t('Close'), '關閉', 'zh-Hant-TW → zh-Hant');
    });
    run('fallback chain reaches the bare language', 'zh-Hans-CN', () => {
      eq(t('Close'), '关闭', 'zh-Hans-CN → zh');
    });

    run('unregistering a catalogue reverts to English', 'fr', () => {
      registerCatalog('i18n-test-temp', 'de', { 'Close': 'Schließen' });
      setLocale('de');
      eq(t('Close'), 'Schließen', 'registered');
      unregisterCatalog('i18n-test-temp');
      eq(t('Close'), 'Close', 'unregistered');
    });

    run('markUntranslated is the identity', 'fr', () => {
      eq(markUntranslated('Close'), 'Close', 'not translated even when a catalogue has it');
    });

    run('markForTranslation is the identity; t() translates it where rendered', 'fr', () => {
      const label = markForTranslation('Close');
      eq(label, 'Close', 'unchanged at the mark');
      eq(t(label), 'Fermer', 'translated at render');
    });

    run('pseudo-localisation accents letters and keeps placeholders', '', () => {
      const out = pseudoLocalize('Hello, {name}');
      assert(out.startsWith('[') && out.endsWith(']'), `bracketed: ${out}`);
      assert(out.includes('{name}'), `placeholder kept: ${out}`);
      assert(!/[A-Za-z]/.test(out.replace('{name}', '')), `no plain ASCII letters left: ${out}`);
      assert(out.includes('·'), `padded: ${out}`);
      assert(isPseudoLocalized(out), 'recognised as pseudo');
      assert(!isPseudoLocalized('Hello'), 'plain English is not');
    });

    run('pseudo-localisation keeps a plural message working', '', () => {
      const msg = '{count, plural, one {# file} other {# files}}';
      registerCatalog(NS + '-pseudo', PSEUDO_LOCALE, { [msg]: pseudoLocalize(msg) });
      setLocale(PSEUDO_LOCALE);
      const one = t(msg, { count: 1 });
      const many = t(msg, { count: 3 });
      unregisterCatalog(NS + '-pseudo');
      assert(one.includes('1') && !/[A-Za-z]/.test(one), `one: ${one}`);
      assert(many.includes('3') && !/[A-Za-z]/.test(many), `other: ${many}`);
      assert(one !== many, 'branches still differ');
    });

    run('pseudo-localisation preserves literal apostrophes and braces', '', () => {
      // The literal braces are text, so their contents are accented like any
      // other text; what matters is that the quoting survives the round trip.
      const out = t(pseudoLocalize("Can't use '{x}'"));
      assert(/^\[Ç.*'.*\{.*\}.*\]$/.test(out) && !/[A-Za-z]/.test(out), `round-trips literals: ${out}`);
    });

    run('formatting follows the runtime default while no locale is chosen', '', () => {
      eq(formattingLocale(), undefined, 'unset');
      eq(formatNumber(1234.5), (1234.5).toLocaleString(), 'number, as toLocaleString would');
    });

    run('formatting follows a chosen locale', 'de-DE', () => {
      eq(formattingLocale(), 'de-DE', 'formatting locale');
      eq(formatNumber(1234.5), '1.234,5', 'German grouping and decimals');
      eq(formatRelativeTime(-1, 'day', { numeric: 'auto' }), 'gestern', 'relative time');
      const d = new Date(2026, 1, 3, 14, 32, 5);
      eq(formatDate(d, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }), '14:32:05', 'time');
    });

    run('the pseudo-locale formats as English', PSEUDO_LOCALE, () => {
      eq(formattingLocale(), 'en', 'en-XA formats as en');
      eq(formatNumber(1234), '1,234', 'English grouping');
    });

    run('markup goes into a message through slots, with the text escaped', '', () => {
      const markup = { link: '<a href="x">guide</a>' };
      const html = withHtml(t('Read {link} & ask {who}.', htmlSlots(markup, { who: '<b>' })), markup);
      eq(html, 'Read <a href="x">guide</a> &amp; ask &lt;b&gt;.', 'markup spliced, text and plain params escaped');
    });

    run('a translation may move a slot, and its text is escaped too', 'fr', () => {
      registerCatalog(NS, 'fr', { 'Read {link} first.': 'D\'abord <lire> {link}.' });
      const markup = { link: '<a>x</a>' };
      eq(withHtml(t('Read {link} first.', htmlSlots(markup)), markup), 'D&#39;abord &lt;lire&gt; <a>x</a>.', 'translated');
    });

    run('slots survive the pseudo-locale and plurals still count', '', () => {
      const source = '{count, plural, one {# file in {where}} other {# files in {where}}}';
      registerCatalog(NS, PSEUDO_LOCALE, { [source]: pseudoLocalize(source) });
      const previous = setLocale(PSEUDO_LOCALE);
      try {
        const markup = { where: '<code>src</code>' };
        const html = withHtml(t(source, htmlSlots(markup, { count: 2 })), markup);
        assert(html.includes('<code>src</code>') && html.includes('2'), `slot and count kept: ${html}`);
        assert(!/[A-Za-z]/.test(html.replace('<code>src</code>', '')), `the rest is accented: ${html}`);
      } finally {
        setLocale(previous);
      }
    });

    run('extensions get the markup helpers through juggler/i18n', '', () => {
      eq(facade.htmlSlots, htmlSlots, 'htmlSlots');
      eq(facade.withHtml, withHtml, 'withHtml');
    });

    run('a select value named like an Object.prototype member takes the other branch', '', () => {
      const msg = '{kind, select, file {a file} other {something}}';
      for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        eq(t(msg, { kind }), 'something', kind);
      }
      eq(t(msg, { kind: 'file' }), 'a file', 'a real branch still matches');
    });

    run('a translation with a __proto__ selector parses as an ordinary branch', 'fr', () => {
      const source = '{kind, select, file {a file} other {something}}';
      registerCatalog(NS, 'fr', { [source]: '{kind, select, __proto__ {proto} file {un fichier} other {autre}}' });
      eq(t(source, { kind: '__proto__' }), 'proto', 'the __proto__ branch');
      eq(t(source, { kind: 'file' }), 'un fichier', 'a sibling branch');
      eq(t(source, { kind: 'x' }), 'autre', 'other');
    });

    for (const bad of ['en-US-abc', 'en-12', 'en-US-US', 'en_US', 'not a tag']) {
      run(`a tag Intl rejects (${bad}) reads as no locale, and nothing throws`, bad, () => {
        eq(getLocale(), 'en', 'locale');
        eq(formattingLocale(), undefined, 'formatting locale');
        eq(formatNumber(1234.5), (1234.5).toLocaleString(), 'number');
        eq(t('{n, plural, one {# file} other {# files}}', { n: 2 }), '2 files', 'plural #');
        formatDate(new Date(0));
        formatRelativeTime(-1, 'day');
      });
    }

    run('setLocale canonicalises the case of a tag', 'zh-hant-tw', () => {
      eq(getLocale(), 'zh-Hant-TW', 'canonical case');
      eq(t('Close'), '關閉', 'and finds the zh-Hant catalogue');
    });

    run('server-canonical locale tags are kept as they are', '', () => {
      // The server resolves aliases (CanonicalLocaleTag, whose tests cover
      // these spellings: sh → sr-Latn, IW-il → he-IL, …) before a tag or a
      // catalogue key reaches the page. Which aliases Intl resolves depends on
      // the engine's CLDR data, so only its results are asserted here: each
      // must survive setLocale and registerCatalog unchanged.
      const canonical = [
        'he-IL', 'yi', 'id-ID', 'sr-Latn', 'ro', 'fil', 'zh', 'en-MM',
        'en-Latn', 'zz-ZZ-abcde', 'hy-AM', 'sr-RS', 'en-CW',
      ];
      for (const tag of canonical) {
        setLocale(tag);
        eq(getLocale(), tag, tag);
      }
      registerCatalog(NS + '-canonical', 'sr-Latn', { 'Canonical greeting': 'Zdravo' });
      try {
        setLocale('sr-Latn');
        eq(t('Canonical greeting'), 'Zdravo', 'catalogue keyed by a canonical tag');
      } finally {
        unregisterCatalog(NS + '-canonical');
      }
    });

    run('formatDate of an invalid date is empty, not a thrown RangeError', 'de-DE', () => {
      eq(formatDate(new Date(NaN), { timeStyle: 'medium' }), '', 'invalid Date');
      eq(formatDate(NaN), '', 'NaN timestamp');
    });

    // Catalogue scope. An extension's catalogue translates that extension's
    // text; it must never re-word the core UI's (an approval prompt, say) or
    // another extension's. These run with a core catalogue of their own, which
    // the headless test page otherwise has none of.
    {
      const EXT_A = 'i18n-test-ext-a';
      const EXT_B = 'i18n-test-ext-b';
      const withScopes = (/** @type {string} */ label, /** @type {string} */ locale, /** @type {() => void} */ fn) => {
        registerCatalog(CORE_NAMESPACE, 'fr', { 'Allow': 'Autoriser', 'Done': 'Terminé' });
        registerCatalog(EXT_A, 'fr', { 'Allow': 'Ouvrir la porte', 'Door': 'Porte', 'Done': 'Fini (A)' });
        registerCatalog(EXT_A, 'fr-CA', { 'Allow': 'Débarrer' });
        registerCatalog(EXT_B, 'fr', { 'Door': 'Portail', 'Gate': 'Barrière' });
        try {
          run(label, locale, fn);
        } finally {
          unregisterCatalog(CORE_NAMESPACE);
          unregisterCatalog(EXT_A);
          unregisterCatalog(EXT_B);
        }
      };

      withScopes('an extension catalogue never re-words core text', 'fr', () => {
        eq(t('Allow'), 'Autoriser', 'core wins over an extension registered later');
      });
      withScopes('nor does a more specific extension locale', 'fr-CA', () => {
        eq(t('Allow'), 'Autoriser', 'core fr beats extension fr-CA');
      });
      withScopes('unscoped text core lacks still finds an extension translation', 'fr', () => {
        eq(t('Gate'), 'Barrière', 'extension fallback');
      });
      withScopes('a namespaced message uses its own catalogue first', 'fr', () => {
        eq(t('Allow', undefined, { namespace: EXT_A }), 'Ouvrir la porte', 'own translation of a word core also has');
        eq(t('Door', undefined, { namespace: EXT_A }), 'Porte', 'not B\'s');
        eq(t('Door', undefined, { namespace: EXT_B }), 'Portail', 'not A\'s');
      });
      withScopes('and its own most specific locale first', 'fr-CA', () => {
        eq(t('Allow', undefined, { namespace: EXT_A }), 'Débarrer', 'fr-CA before fr');
        eq(t('Door', undefined, { namespace: EXT_A }), 'Porte', 'then its own fr');
      });
      withScopes('a namespaced message falls back to core, never to another extension', 'fr', () => {
        eq(t('Done', undefined, { namespace: EXT_B }), 'Terminé', 'core');
        eq(t('Gate', undefined, { namespace: EXT_A }), 'Gate', 'B\'s catalogue is not consulted');
      });
      withScopes('translator() binds the namespace', 'fr', () => {
        const tA = translator(EXT_A);
        eq(tA('Door'), 'Porte', 'own');
        eq(tA('{n, plural, one {# door} other {# doors}}', { n: 2 }), '2 doors', 'params pass through');
        eq(tA('Door', undefined, { context: 'x' }), 'Door', 'context still applies');
      });
      run('the facade exports translator', '', () => {
        eq(facade.translator, translator, 'translator');
      });
    }

    run('setLocale returns the previous raw value for restoring', 'fr', () => {
      const before = setLocale('de');
      eq(before, 'fr', 'previous');
      setLocale(before);
      eq(getLocale(), 'fr', 'restored');
    });
  } finally {
    unregisterCatalog(NS);
  }

  return { passed, failed, errors };
}
