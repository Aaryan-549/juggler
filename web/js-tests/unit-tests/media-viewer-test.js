//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for the media file viewer, which plays video and audio and shows the
 * images the model-facing image viewer will not take.
 *
 * Resolution is the first thing that matters: a video must not land on the
 * binary viewer's "no viewer" facts, and an image a provider will accept must
 * still reach the image viewer, which is the one that attaches its pixels.
 * Then the transport: a file the content route refuses (anything outside the
 * project) plays from a blob of its bytes rather than as a broken player.
 * Nothing here plays real media — a lane neither paints nor decodes reliably —
 * so what is asserted is the element and where it is pointed.
 * @module unit-tests/media-viewer-test
 */

import fileViewerRegistry from '../../js/registries/file-viewer-registry.js';
import { createFileSource, toDescriptor } from '../../sdk/file-source.js';
import MediaFileViewer from '../../extensions/juggler-core/viewers/media-file-viewer.js';
import ImageFileViewer from '../../extensions/juggler-core/viewers/image-file-viewer.js';
import TextFileViewer from '../../extensions/juggler-core/viewers/text-file-viewer.js';
import BinaryFileViewer from '../../extensions/juggler-core/viewers/binary-file-viewer.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

/** A same-origin URL the server answers with 200: this module's own. */
const SERVED_URL = new URL(import.meta.url).pathname;

/** A content-route URL the server refuses: the path is outside the project. */
const REFUSED_URL = '/api/session/files/content?path=%2Fnowhere%2Fmissing.mp3';

/**
 * @param {boolean} cond - Assertion condition
 * @param {string} msg - Failure message
 * @param {string[]} errors - Collected failures
 * @returns {number} 1 when the assertion passed, 0 when it failed
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * Install the real core viewers into the singleton registry and return a
 * restore function.
 * @param {Array<[string, any]>} entries - [id, class] pairs in precedence order
 * @returns {() => void} Restores the registry's previous contents
 */
function installViewers(entries) {
  const reg = /** @type {any} */ (fileViewerRegistry);
  const saved = new Map(reg.items);
  reg.items.clear();
  for (const [id, cls] of entries) reg.items.set(id, cls);
  return () => {
    reg.items.clear();
    for (const [id, cls] of saved) reg.items.set(id, cls);
  };
}

/**
 * @param {string} path - File path
 * @param {string} mime - Reported mime
 * @param {number} size - Bytes on disk
 * @returns {any} The viewer class the registry picks
 */
function resolveFor(path, mime, size) {
  return fileViewerRegistry.resolve(toDescriptor(createFileSource({ path, mime, size, isBinary: true })));
}

/**
 * Render a source through the viewer into a detached host.
 * @param {import('../../sdk/file-source.js').FileSource} source - What to render
 * @returns {Promise<{host: HTMLElement, teardown: (() => void)|void}>} The rendered parts
 */
async function render(source) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const teardown = await new MediaFileViewer().render(source, host, { signal: new AbortController().signal });
  return { host, teardown };
}

/**
 * @param {{host: HTMLElement, teardown: (() => void)|void}} rendered - What render() returned
 */
function dispose(rendered) {
  if (typeof rendered.teardown === 'function') rendered.teardown();
  rendered.host.remove();
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @param {number} n - 1 when passed */
  const tally = (n) => { if (n) passed++; else failed++; };

  // The shipped extension registers it: an .mp4 is the media viewer's.
  await fileViewerRegistry.ensureInitialized();
  const shipped = resolveFor('clips/demo.mp4', 'video/mp4', 4 << 20);
  tally(check(shipped?.MANIFEST?.id === 'media',
    `an .mp4 should resolve to the media viewer, got ${shipped?.MANIFEST?.id}`, errors));

  const restore = installViewers([
    ['text', TextFileViewer], ['image', ImageFileViewer], ['media', MediaFileViewer], ['binary', BinaryFileViewer],
  ]);
  try {
    /** @type {Array<[string, string, number, any, string]>} */
    const cases = [
      ['demo.mov', 'video/quicktime', 40 << 20, MediaFileViewer, 'a QuickTime movie'],
      ['take.mp3', 'audio/mpeg', 3 << 20, MediaFileViewer, 'an mp3'],
      ['take.wav', '', 3 << 20, MediaFileViewer, 'a .wav with no reported mime (matched on extension)'],
      ['icon.bmp', 'image/bmp', 2000, MediaFileViewer, 'an image format no provider accepts'],
      ['shot.png', 'image/png', 2000, ImageFileViewer, 'a small png, which must still reach the model'],
      ['huge.png', 'image/png', 8 << 20, MediaFileViewer, 'a png over the attachable size'],
      ['archive.zip', 'application/zip', 2000, BinaryFileViewer, 'a format nothing plays'],
    ];
    for (const [path, mime, size, want, what] of cases) {
      const got = resolveFor(path, mime, size);
      tally(check(got === want,
        `${what} should resolve to ${want.MANIFEST.id}, got ${got?.MANIFEST?.id}`, errors));
    }
  } finally {
    restore();
  }

  // A served video plays from its streaming URL — that is what makes seeking a
  // Range request rather than a download of the whole file.
  let videoBytesCalls = 0;
  const video = await render(createFileSource({
    path: 'clips/demo.mp4', absPath: '/proj/clips/demo.mp4', mime: 'video/mp4', size: 1000, isBinary: true,
    url: () => SERVED_URL,
    bytes: async () => { videoBytesCalls++; return new Uint8Array(0); },
  }));
  try {
    const el = /** @type {HTMLVideoElement|null} */ (video.host.querySelector('video'));
    tally(check(!!el, 'a video should render a <video> element', errors));
    tally(check(!!el?.controls, 'the player should have controls', errors));
    tally(check(el?.getAttribute('src') === SERVED_URL,
      `a served video should stream from its URL, got ${el?.getAttribute('src')}`, errors));
    tally(check(videoBytesCalls === 0, 'a served video must not download its bytes', errors));

    // A format the platform cannot decode says so instead of an empty player.
    el?.dispatchEvent(new Event('error'));
    tally(check(!!video.host.querySelector('.media-view-note'),
      'a player that fails to load should be replaced by a note saying so', errors));
  } finally {
    dispose(video);
  }

  // A refused URL falls back to a blob of the bytes, and teardown lets it go.
  let audioBytesCalls = 0;
  const audio = await render(createFileSource({
    path: '/nowhere/missing.mp3', absPath: '/nowhere/missing.mp3', mime: 'audio/mpeg', size: 4, isBinary: true,
    url: () => REFUSED_URL,
    bytes: async () => { audioBytesCalls++; return new Uint8Array([0xff, 0xfb, 0x90, 0x00]); },
  }));
  const audioEl = /** @type {HTMLAudioElement|null} */ (audio.host.querySelector('audio'));
  tally(check(!!audioEl, 'an mp3 should render an <audio> element', errors));
  tally(check(audioBytesCalls === 1, `a refused URL should fall back to bytes once, got ${audioBytesCalls}`, errors));
  tally(check((audioEl?.getAttribute('src') || '').startsWith('blob:'),
    `a refused URL should play from a blob, got ${audioEl?.getAttribute('src')}`, errors));
  dispose(audio);
  tally(check(!audioEl?.hasAttribute('src'),
    'teardown should release the player\'s source', errors));

  // An image renders as one.
  const image = await render(createFileSource({
    path: 'icon.bmp', absPath: '/proj/icon.bmp', mime: 'image/bmp', size: 2000, isBinary: true,
    url: () => SERVED_URL,
  }));
  try {
    tally(check(!!image.host.querySelector('img'), 'an image should render an <img>', errors));
  } finally {
    dispose(image);
  }

  // The model is told what the file is, and given no text.
  const extracted = await new MediaFileViewer().extract(createFileSource({
    path: 'clips/demo.mp4', mime: 'video/mp4', size: 1000, isBinary: true,
  }));
  tally(check(!extracted.text && !!extracted.warning?.includes('video'),
    `extract() should say it is a video and carry no text, got ${JSON.stringify(extracted)}`, errors));

  /** @type {Record<string, string>} */
  const englishWarnings = {};
  for (const mime of ['video/mp4', 'image/bmp']) {
    const source = createFileSource({ path: 'clip.bin', mime, size: 1000, isBinary: true });
    englishWarnings[mime] = (await new MediaFileViewer().extract(source)).warning || '';
  }

  // en-XA: an image with no path gets a fallback alt text, which also names the
  // lightbox it opens, so it is UI text — in both viewers that draw images.
  try {
    await underPseudoLocale('media-viewer-test', async () => {
      for (const Viewer of [ImageFileViewer, MediaFileViewer]) {
        const host = document.createElement('div');
        document.body.appendChild(host);
        try {
          await new Viewer().render(createFileSource({
            path: '', mime: 'image/png', size: 2000, isBinary: true,
            url: () => SERVED_URL, bytes: async () => new Uint8Array(0),
          }), host, { signal: new AbortController().signal });
          const alt = host.querySelector('img')?.getAttribute('alt') ?? null;
          tally(check(alt !== null && isPseudoLocalized(alt),
            `${Viewer.MANIFEST.id}: the unnamed image's alt text is not translated: ${JSON.stringify(alt)}`, errors));
        } finally {
          host.remove();
        }
      }

      // A file whose bytes cannot be fetched says why; the error is data.
      const failed = await render(createFileSource({
        path: '', mime: 'video/mp4', size: 4, isBinary: true,
        url: () => '', bytes: async () => { throw new Error('404'); },
      }));
      try {
        const text = failed.host.querySelector('.media-view-note')?.textContent ?? null;
        tally(check(text !== null && isPseudoLocalized(text) && text.includes('404'),
          `the failed-load note is not translated with its error: ${JSON.stringify(text)}`, errors));
      } finally {
        dispose(failed);
      }

      // Each kind's unsupported-format note, and a nameless player's aria-label.
      /** @type {Array<[string, string]>} */
      const kinds = [['image', 'image/png'], ['video', 'video/mp4'], ['audio', 'audio/mpeg']];
      for (const [kind, mime] of kinds) {
        const shown = await render(createFileSource({
          path: '', mime, size: 4, isBinary: true, url: () => SERVED_URL,
        }));
        try {
          const el = shown.host.querySelector(kind === 'image' ? 'img' : kind);
          tally(check(!!el, `${kind}: no element rendered`, errors));
          if (kind !== 'image') {
            const label = el?.getAttribute('aria-label') ?? null;
            tally(check(label !== null && isPseudoLocalized(label),
              `${kind}: the nameless player's aria-label is not translated: ${JSON.stringify(label)}`, errors));
          }
          el?.dispatchEvent(new Event('error'));
          const text = shown.host.querySelector('.media-view-note')?.textContent ?? null;
          tally(check(text !== null && isPseudoLocalized(text),
            `${kind}: the unsupported-format note is not translated: ${JSON.stringify(text)}`, errors));
        } finally {
          dispose(shown);
        }
      }

      // extract() is model-facing: its warnings stay English.
      for (const mime of ['video/mp4', 'image/bmp']) {
        const source = createFileSource({ path: 'clip.bin', mime, size: 1000, isBinary: true });
        const got = (await new MediaFileViewer().extract(source)).warning || '';
        tally(check(got === englishWarnings[mime],
          `${mime}: extract()'s warning must stay English under en-XA, got ${JSON.stringify(got)}`, errors));
      }
    }, { '@juggler/core': [
      'image',
      'Couldn’t load this file: {error}',
      '{kind, select, audio {audio} other {video}}',
      'This image format can’t be displayed here.',
      '{kind, select, audio {This audio format can’t be played here.} other {This video format can’t be played here.}}',
    ] });
  } catch (/** @type {any} */ e) {
    tally(check(false, `en-XA: ${e?.message}`, errors));
  }

  return { passed, failed, errors };
}
