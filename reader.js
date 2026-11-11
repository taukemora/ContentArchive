/* Encrypted ContentArchive reader.
 *
 * Loaded only by the generated encrypted entry (data-ca-encrypted="1").
 * All article bytes are authenticated ciphertext fetched from ./objects/.
 * The passphrase and DEK exist only in this script's memory; no browser
 * storage or service-worker cache is used.
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Media hydration scheduler
  //
  // Images are requested visible-first with a small bounded queue, instead of
  // serially walking the whole article. The factory is dependency-injected so
  // the exact same code is exercised by tests/reader_media_scheduler.mjs in
  // Node with a simulated DOM, geometry, and load promises.
  // -------------------------------------------------------------------------
  function createMediaScheduler(options) {
    var opts = options || {};
    var concurrency = Math.max(1, Math.min(6, opts.concurrency || 3));
    var prefetchFactor = opts.prefetchFactor == null ? 2 : opts.prefetchFactor;
    var jobs = opts.jobs || [];
    var frame = opts.frame || {
      request: function (fn) { return setTimeout(fn, 16); },
      cancel: function (id) { clearTimeout(id); },
    };
    var active = 0;
    var stopped = false;
    var frameId = null;
    var observer = null;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;

    function activeStill() {
      if (stopped) return false;
      if (controller && controller.signal.aborted) return false;
      return typeof opts.isActive !== 'function' || !!opts.isActive();
    }

    function viewport() {
      var rect = opts.viewport ? opts.viewport() : null;
      if (rect === null) return null; // pane explicitly unmeasurable (hidden)
      if (!rect || typeof rect.top !== 'number' || typeof rect.bottom !== 'number') {
        return { top: 0, bottom: opts.fallbackHeight || 0 };
      }
      if (!(rect.bottom - rect.top > 0)) {
        // A hidden pane has no measurable height. Treating it as a zero-height
        // window would make every node look visible and download the whole
        // article; pause instead until a resize makes the pane measurable.
        return null;
      }
      return rect;
    }

    function rankRect(rect, pane, limit) {
      if (!rect || typeof rect.top !== 'number' || typeof rect.bottom !== 'number') return null;
      var height = typeof rect.height === 'number' ? rect.height : rect.bottom - rect.top;
      if (!(height > 0)) return null; // zero-size nodes are never visible
      if (typeof rect.width === 'number' && !(rect.width > 0)) return null;
      var rank;
      var distance;
      if (rect.bottom >= pane.top && rect.top <= pane.bottom) {
        rank = 0;
        distance = rect.top > pane.top ? rect.top - pane.top : 0;
      } else if (rect.top > pane.bottom) {
        distance = rect.top - pane.bottom;
        rank = distance <= limit ? 1 : 3;
      } else {
        distance = pane.top - rect.bottom;
        rank = distance <= limit ? 2 : 3;
      }
      if (rank === 3) return null;
      return { rank: rank, distance: distance };
    }

    // A job can be mounted at several nodes (the same ciphertext object used by
    // two images, or by an image and an attachment link). Rank each occurrence
    // and keep the best; a min-top/max-bottom bounding box would treat two far
    // apart occurrences as one huge visible element.
    function bestRank(job, pane, limit) {
      var measured = opts.measure(job);
      var rects = Array.isArray(measured) ? measured : (measured ? [measured] : []);
      var best = null;
      for (var r = 0; r < rects.length; r += 1) {
        var ranked = rankRect(rects[r], pane, limit);
        if (!ranked) continue;
        if (!best || ranked.rank < best.rank ||
            (ranked.rank === best.rank && ranked.distance < best.distance)) {
          best = ranked;
        }
      }
      return best;
    }

    // Rank: 0 = currently visible, 1 = just below the pane, 2 = just above,
    // outside the prefetch window = not scheduled at all. The order is
    // recomputed from live geometry every time a slot frees, so a scroll or a
    // layout change reshuffles jobs that have not started yet.
    function candidates() {
      var pane = viewport();
      if (!pane) return []; // hidden pane: pause until it is measurable again
      var paneHeight = Math.max(1, pane.bottom - pane.top);
      var limit = paneHeight * prefetchFactor;
      var out = [];
      for (var i = 0; i < jobs.length; i += 1) {
        var job = jobs[i];
        if (job.state !== 'pending') continue;
        var best = bestRank(job, pane, limit);
        if (!best) continue;
        out.push({ job: job, rank: best.rank, distance: best.distance, index: job.index });
      }
      out.sort(function (a, b) {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (a.distance !== b.distance) return a.distance - b.distance;
        return a.index - b.index;
      });
      return out;
    }

    function startJob(job) {
      job.state = 'active';
      active += 1;
      for (var i = 0; i < job.nodes.length; i += 1) {
        // Native lazy loading would otherwise defer the blob URL we set later.
        if (job.nodes[i].tagName === 'IMG') job.nodes[i].loading = 'eager';
      }
      var promise;
      try {
        promise = opts.load(job, controller ? controller.signal : undefined);
      } catch (e) {
        active = Math.max(0, active - 1);
        job.state = 'failed';
        if (activeStill()) {
          try { opts.fail(job, e); } catch (ignored) { /* ignore */ }
        }
        return; // the caller's pump loop keeps filling the freed slot
      }
      Promise.resolve(promise).then(function (url) {
        active = Math.max(0, active - 1);
        if (stopped || job.state !== 'active') return;
        if (!activeStill()) {
          job.state = 'stale';
          return;
        }
        job.state = 'done';
        try {
          opts.apply(job, url);
        } catch (e) {
          try { opts.fail(job, e); } catch (ignored) { /* ignore */ }
        }
        scheduleRefresh(); // a decoded image can move everything below it
        pump();
      }, function (err) {
        active = Math.max(0, active - 1);
        if (stopped || job.state !== 'active') return;
        job.state = 'failed';
        if (!activeStill()) return;
        try { opts.fail(job, err); } catch (ignored) { /* ignore */ }
        pump();
      });
    }

    function pump() {
      if (!activeStill()) return;
      while (active < concurrency) {
        var ranked = candidates();
        if (!ranked.length) return;
        startJob(ranked[0].job);
      }
    }

    function scheduleRefresh() {
      if (stopped || frameId !== null) return;
      frameId = frame.request(function () {
        frameId = null;
        pump();
      });
    }

    function onViewportChange() {
      scheduleRefresh();
    }

    function start() {
      if (stopped) return api;
      if (opts.win && opts.win.addEventListener) {
        opts.win.addEventListener('resize', onViewportChange);
      }
      if (opts.scrollTarget && opts.scrollTarget.addEventListener) {
        opts.scrollTarget.addEventListener('scroll', onViewportChange, { passive: true });
      }
      if (opts.observeTarget && typeof ResizeObserver === 'function') {
        try {
          observer = new ResizeObserver(onViewportChange);
          observer.observe(opts.observeTarget);
          if (opts.scrollTarget && opts.scrollTarget !== opts.observeTarget) {
            observer.observe(opts.scrollTarget);
          }
        } catch (e) {
          observer = null;
        }
      }
      pump();
      return api;
    }

    function stop() {
      if (stopped) return api;
      stopped = true;
      if (frameId !== null) {
        try { frame.cancel(frameId); } catch (e) { /* ignore */ }
        frameId = null;
      }
      if (opts.win && opts.win.removeEventListener) {
        opts.win.removeEventListener('resize', onViewportChange);
      }
      if (opts.scrollTarget && opts.scrollTarget.removeEventListener) {
        opts.scrollTarget.removeEventListener('scroll', onViewportChange);
      }
      if (observer) {
        try { observer.disconnect(); } catch (e) { /* ignore */ }
        observer = null;
      }
      if (controller) {
        try { controller.abort(); } catch (e) { /* ignore */ }
      }
      for (var i = 0; i < jobs.length; i += 1) {
        if (jobs[i].state === 'pending' || jobs[i].state === 'active') jobs[i].state = 'stopped';
      }
      active = 0;
      return api;
    }

    function refreshNow() {
      if (!stopped) pump();
    }

    function stats() {
      var counts = { pending: 0, active: 0, done: 0, failed: 0, stale: 0, stopped: 0 };
      for (var i = 0; i < jobs.length; i += 1) {
        if (counts[jobs[i].state] != null) counts[jobs[i].state] += 1;
      }
      counts.inFlight = active;
      return counts;
    }

    var api = {
      start: start,
      stop: stop,
      refreshNow: refreshNow,
      stats: stats,
    };
    return api;
  }

  // Test seam: Node loads this file to exercise the scheduler above. Browsers
  // never define module.exports, so the shipped behaviour is unchanged.
  if (typeof module === 'object' && module && module.exports) {
    module.exports = { createMediaScheduler: createMediaScheduler };
    return;
  }

  var root = document.documentElement;
  if (!root || root.getAttribute('data-ca-encrypted') !== '1') return;

  var core = window.CAContentArchive;
  var subtle = window.crypto && window.crypto.subtle;
  var encoder = new TextEncoder();
  var decoder = new TextDecoder('utf-8', { fatal: true });

  var PROTOCOL = 'CA-ENC-1';
  var ITERATIONS = 600000;
  var SALT_BYTES = 16;
  var NONCE_BYTES = 12;
  var KEY_BYTES = 32;
  var TAG_BITS = 128;
  var CIPHER_OVERHEAD = 4 + NONCE_BYTES + TAG_BITS / 8;
  var MAX_SITE_BYTES = 128 * 1024;
  var MAX_INDEX_BYTES = 64 * 1024 * 1024;
  var MAX_ARTICLE_BYTES = 64 * 1024 * 1024;
  var MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  var MAX_ARTICLES = 20000;

  var OBJECT_RE = /^objects\/([0-9a-f]{64})\.([0-9a-f]{32})\.bin$/;
  var OID_RE = /^[0-9a-f]{64}$/;
  var ARCHIVE_RE = /^[0-9a-f]{32}$/;
  var VERSION_RE = /^[0-9a-f]{32}$/;
  var B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

  var epoch = 0;
  var locked = true;
  var session = null; // { archiveId, dekKey }
  var bodyToken = 0;
  var bodyAbort = null;
  var unlockAbort = null;
  var blobUrls = new Set();
  var overlayEl = null;
  var inputEl = null;
  var submitEl = null;
  var errorEl = null;
  var exitBtn = null;

  function fail(message) {
    var err = new Error(message);
    err.caFriendly = true;
    return err;
  }

  function concat(parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i += 1) total += parts[i].length;
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < parts.length; j += 1) {
      out.set(parts[j], offset);
      offset += parts[j].length;
    }
    return out;
  }

  function lp(bytes) {
    var out = new Uint8Array(4 + bytes.length);
    new DataView(out.buffer).setUint32(0, bytes.length);
    out.set(bytes, 4);
    return out;
  }

  function aad(archiveId, purpose, oid) {
    return concat([
      lp(encoder.encode(PROTOCOL)),
      lp(encoder.encode(archiveId)),
      lp(encoder.encode(purpose)),
      lp(encoder.encode(oid)),
    ]);
  }

  function b64(value, expectBytes) {
    if (typeof value !== 'string' || !B64_RE.test(value)) throw fail('invalid base64');
    var raw;
    try {
      raw = atob(value);
    } catch (e) {
      throw fail('invalid base64');
    }
    if (raw.length !== expectBytes) throw fail('invalid field length');
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  function hex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  function oidOf(rel) {
    var match = OBJECT_RE.exec(String(rel || ''));
    if (!match) throw fail('invalid object path');
    return match[1];
  }

  function exactKeys(obj, expected, label) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw fail('invalid ' + label);
    var actual = Object.keys(obj).sort().join(',');
    if (actual !== expected.slice().sort().join(',')) throw fail('invalid ' + label + ' fields');
  }

  function bytesField(value, max, label) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
      throw fail('invalid ' + label);
    }
    return value;
  }

  function parseSite(text) {
    var site;
    try {
      site = JSON.parse(text);
    } catch (e) {
      throw fail('invalid site manifest');
    }
    exactKeys(site, ['format', 'protocol', 'archive_id', 'kdf', 'wrap', 'index', 'version'], 'site');
    if (site.format !== 'contentarchive-encrypted-site' || site.protocol !== PROTOCOL) {
      throw fail('unsupported site protocol');
    }
    if (!ARCHIVE_RE.test(site.archive_id) || !VERSION_RE.test(site.version)) {
      throw fail('invalid site identifiers');
    }
    exactKeys(site.kdf, ['name', 'hash', 'iterations', 'salt', 'key_length'], 'kdf');
    if (
      site.kdf.name !== 'PBKDF2-HMAC-SHA256' ||
      site.kdf.hash !== 'sha256' ||
      site.kdf.iterations !== ITERATIONS ||
      site.kdf.key_length !== KEY_BYTES
    ) {
      throw fail('unsupported KDF parameters');
    }
    exactKeys(site.wrap, ['cipher', 'nonce', 'ciphertext', 'tag_length'], 'wrap');
    if (site.wrap.cipher !== 'AES-256-GCM' || site.wrap.tag_length !== TAG_BITS) {
      throw fail('unsupported wrapping parameters');
    }
    exactKeys(site.index, ['file', 'bytes'], 'index locator');
    if (!OBJECT_RE.test(site.index.file)) throw fail('invalid index path');
    bytesField(site.index.bytes, MAX_INDEX_BYTES, 'index size');
    var salt = b64(site.kdf.salt, SALT_BYTES);
    var nonce = b64(site.wrap.nonce, NONCE_BYTES);
    var wrapped = b64(site.wrap.ciphertext, KEY_BYTES + TAG_BITS / 8);
    return { site: site, salt: salt, nonce: nonce, wrapped: wrapped };
  }

  function parseIndex(raw, site) {
    var index;
    try {
      index = JSON.parse(decoder.decode(raw));
    } catch (e) {
      throw fail('invalid index');
    }
    exactKeys(index, ['format', 'protocol', 'archive_id', 'labels', 'articles'], 'index');
    if (
      index.format !== 'contentarchive-encrypted-index' ||
      index.protocol !== PROTOCOL ||
      index.archive_id !== site.archive_id
    ) {
      throw fail('index binding mismatch');
    }
    if (!index.labels || typeof index.labels !== 'object' || Array.isArray(index.labels)) {
      throw fail('invalid labels');
    }
    if (!Array.isArray(index.articles) || index.articles.length > MAX_ARTICLES) {
      throw fail('invalid article list');
    }

    var labels = Object.create(null);
    Object.keys(index.labels).forEach(function (key) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
      var value = index.labels[key];
      if (typeof key === 'string' && typeof value === 'string' && key.length <= 120) {
        labels[key] = value.slice(0, 200);
      }
    });

    var articles = index.articles.map(function (article) {
      if (!article || typeof article !== 'object' || Array.isArray(article)) throw fail('invalid article');
      if (typeof article.id !== 'string' || !OID_RE.test(article.id)) throw fail('invalid article id');
      if (!article.body || typeof article.body !== 'object') throw fail('invalid body locator');
      if (!OBJECT_RE.test(article.body.file) || oidOf(article.body.file) !== article.id) {
        throw fail('body locator mismatch');
      }
      bytesField(article.body.bytes, MAX_ARTICLE_BYTES, 'body size');
      if (typeof article.title !== 'string' || article.title.length > 4096) throw fail('invalid title');
      [
        'summary', 'original_title', 'source', 'category', 'category_label',
        'subcategory', 'context', 'status', 'content_note', 'image_note',
        'collection', 'published', 'archived', 'search_text', 'url',
      ].forEach(function (key) {
        if (article[key] != null && typeof article[key] !== 'string') throw fail('invalid article field');
      });
      if (article.tags != null && !Array.isArray(article.tags)) throw fail('invalid tags');
      return article;
    });

    return { articles: articles, labels: labels };
  }

  async function fetchBytes(path, limit, signal) {
    if (typeof path !== 'string' || path.indexOf('..') !== -1 || path.charAt(0) === '/') {
      throw fail('invalid fetch path');
    }
    var response = await fetch(path, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: signal,
    });
    if (!response.ok) throw fail('request failed');
    var buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit) throw fail('response too large');
    return new Uint8Array(buffer);
  }

  async function decryptObject(bytes, purpose, oid) {
    if (bytes.length < CIPHER_OVERHEAD) throw fail('ciphertext too short');
    if (bytes[0] !== 0x43 || bytes[1] !== 0x41 || bytes[2] !== 0x45 || bytes[3] !== 0x31) {
      throw fail('ciphertext header invalid');
    }
    var nonce = bytes.slice(4, 4 + NONCE_BYTES);
    var ciphertext = bytes.slice(4 + NONCE_BYTES);
    return new Uint8Array(
      await subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad(session.archiveId, purpose, oid), tagLength: TAG_BITS },
        session.dekKey,
        ciphertext
      )
    );
  }

  function stillValid(myEpoch, renderEpoch) {
    if (locked || !session || epoch !== myEpoch) return false;
    if (core && typeof core.getEpoch === 'function' && renderEpoch != null) {
      if (core.getEpoch() !== renderEpoch) return false;
    }
    return true;
  }

  function revokeBlobUrls() {
    blobUrls.forEach(function (url) {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        /* ignore */
      }
    });
    blobUrls.clear();
  }

  var IMAGE_MIME_RE = /^image\/(png|jpeg|webp|gif|svg\+xml|avif|bmp|x-icon)$/;
  var media = null; // active media scheduler for the current body

  function failMediaNode(node) {
    if (node.tagName === 'IMG') {
      var placeholder = document.createElement('span');
      placeholder.className = 'img-missing';
      placeholder.textContent = '[图片解密失败]';
      if (node.parentNode) node.parentNode.replaceChild(placeholder, node);
    } else {
      node.removeAttribute('data-ca-href');
      node.setAttribute('href', '#');
    }
  }

  // Keep the pending placeholder box until the blob has actually decoded.
  // Listeners are registered before src is assigned (a cached blob can fire
  // load synchronously), and the ready marker is only written while the
  // article/lock token is still current so a late event cannot touch a body
  // that has already been replaced.
  function hydrateImage(node, url, stillCurrent) {
    function cleanup() {
      node.removeEventListener('load', onLoad);
      node.removeEventListener('error', onError);
    }
    function onLoad() {
      cleanup();
      if (!stillCurrent()) return;
      node.setAttribute('data-ca-ready', '1');
    }
    function onError() {
      cleanup();
      if (!stillCurrent()) return;
      failMediaNode(node);
    }
    node.addEventListener('load', onLoad, { once: true });
    node.addEventListener('error', onError, { once: true });
    node.src = url;
  }

  function stopMedia() {
    if (!media) return;
    try { media.stop(); } catch (e) { /* ignore */ }
    media = null;
  }

  async function loadMediaJob(job, jobSignal, myEpoch, renderEpoch, token) {
    var bytes = await fetchBytes(job.rel, MAX_IMAGE_BYTES, jobSignal);
    var plain = await decryptObject(bytes, 'image', job.oid);
    // Do not create (or leak) a blob URL if the article/lock changed while
    // the ciphertext was in flight.
    if (!stillValid(myEpoch, renderEpoch) || token !== bodyToken || (jobSignal && jobSignal.aborted)) {
      throw fail('stale media');
    }
    var url = URL.createObjectURL(new Blob([plain], { type: job.mime }));
    blobUrls.add(url);
    return url;
  }

  function startMedia(bodyEl, signal, myEpoch, renderEpoch, token) {
    stopMedia();
    if (!stillValid(myEpoch, renderEpoch) || token !== bodyToken) return;

    var nodes = bodyEl.querySelectorAll('img[data-ca-src], a[data-ca-href]');
    var byKey = Object.create(null);
    var jobs = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var isImage = node.tagName === 'IMG';
      var rel = node.getAttribute(isImage ? 'data-ca-src' : 'data-ca-href');
      var mime = node.getAttribute('data-ca-mime') || '';
      var oid;
      try {
        if (!IMAGE_MIME_RE.test(mime)) throw fail('bad mime');
        oid = oidOf(rel);
      } catch (e) {
        // Cheap validation failures are safe to surface immediately; they do
        // not start a request and must not wait behind the visibility queue.
        failMediaNode(node);
        continue;
      }
      // Same ciphertext object used twice in one article is fetched once.
      var key = rel + '\u0000' + mime;
      var job = byKey[key];
      if (!job) {
        job = byKey[key] = {
          rel: rel,
          mime: mime,
          oid: oid,
          nodes: [],
          index: jobs.length,
          state: 'pending',
        };
        jobs.push(job);
      }
      job.nodes.push(node);
    }
    if (!jobs.length) return;

    var pane = bodyEl.closest ? bodyEl.closest('.reader-pane') : null;
    var frame = window.requestAnimationFrame ? {
      request: function (fn) { return window.requestAnimationFrame(fn); },
      cancel: function (id) { window.cancelAnimationFrame(id); },
    } : undefined;

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', stopMedia, { once: true });
    }

    function current() {
      return !signal.aborted && stillValid(myEpoch, renderEpoch) && token === bodyToken;
    }

    media = createMediaScheduler({
      jobs: jobs,
      concurrency: 3,
      prefetchFactor: 2,
      win: window,
      scrollTarget: pane || window,
      observeTarget: bodyEl,
      fallbackHeight: window.innerHeight || 0,
      frame: frame,
      measure: function (job) {
        // One ciphertext object can be mounted at several nodes. Report every
        // occurrence so the scheduler can rank the best one without collapsing
        // the list into one bounding box.
        var rects = [];
        for (var n = 0; n < job.nodes.length; n += 1) {
          var node = job.nodes[n];
          if (!node || typeof node.getBoundingClientRect !== 'function') continue;
          var rect = node.getBoundingClientRect();
          if (!rect) continue;
          rects.push({ top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height });
        }
        return rects.length ? rects : null;
      },
      viewport: function () {
        if (pane && typeof pane.getBoundingClientRect === 'function') {
          var rect = pane.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return { top: rect.top, bottom: rect.bottom };
          // The pane exists but is hidden (mobile list view). Report it as
          // unmeasurable so the scheduler pauses; falling back to the window
          // here would classify every zero-height node as visible.
          return null;
        }
        // No pane at all: the real window viewport is a valid fallback.
        return { top: 0, bottom: window.innerHeight || 0 };
      },
      load: function (job, jobSignal) {
        return loadMediaJob(job, jobSignal, myEpoch, renderEpoch, token);
      },
      apply: function (job, url) {
        for (var j = 0; j < job.nodes.length; j += 1) {
          var target = job.nodes[j];
          if (target.tagName === 'IMG') {
            hydrateImage(target, url, current);
          } else {
            target.href = url;
            target.target = '_blank';
            target.rel = 'noopener noreferrer';
            target.removeAttribute('data-ca-href');
          }
        }
      },
      fail: function (job) {
        for (var k = 0; k < job.nodes.length; k += 1) failMediaNode(job.nodes[k]);
      },
      isActive: current,
    });
    media.start();
  }

  function relocateSourceLine(bodyEl) {
    var articleRoot = bodyEl.closest ? bodyEl.closest('.reader-article') : null;
    var sourceLine = bodyEl.firstElementChild;
    var noteBody = articleRoot && articleRoot.querySelector('.archive-notes .alert-box');
    if (
      sourceLine && sourceLine.tagName === 'BLOCKQUOTE' && noteBody &&
      /^来源：/.test((sourceLine.textContent || '').trim()) &&
      (sourceLine.textContent || '').indexOf('发布：') !== -1
    ) {
      noteBody.prepend(sourceLine);
    }
  }

  async function mountBody(article, bodyEl, renderEpoch) {
    if (locked || !session) return;
    bodyToken += 1;
    var token = bodyToken;
    var myEpoch = epoch;
    if (bodyAbort) {
      try { bodyAbort.abort(); } catch (e) { /* ignore */ }
    }
    stopMedia();
    bodyAbort = new AbortController();
    var signal = bodyAbort.signal;
    revokeBlobUrls();
    bodyEl.innerHTML = '<div class="ca-body-pending">正在解密正文…</div>';

    try {
      if (!article.body || typeof article.body.file !== 'string') throw fail('missing body');
      var oid = oidOf(article.body.file);
      if (oid !== article.id) throw fail('body id mismatch');
      var bytes = await fetchBytes(article.body.file, MAX_ARTICLE_BYTES, signal);
      if (bytes.length !== article.body.bytes + CIPHER_OVERHEAD) throw fail('body size mismatch');
      var plain = await decryptObject(bytes, 'article', oid);
      if (!stillValid(myEpoch, renderEpoch) || token !== bodyToken) return;
      bodyEl.innerHTML = decoder.decode(plain);
      relocateSourceLine(bodyEl);
      startMedia(bodyEl, signal, myEpoch, renderEpoch, token);
    } catch (e) {
      if (!stillValid(myEpoch, renderEpoch) || token !== bodyToken) return;
      bodyEl.innerHTML = '<div class="alert-box alert-warning">正文解密失败或数据被篡改，已停止显示。</div>';
    }
  }

  function setError(message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = !message;
  }

  function showOverlay() {
    if (overlayEl) overlayEl.hidden = false;
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.hidden = true;
  }

  function buildOverlay() {
    overlayEl = document.createElement('div');
    overlayEl.className = 'ca-unlock';
    overlayEl.id = 'ca-unlock';
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');
    overlayEl.setAttribute('aria-labelledby', 'ca-unlock-title');

    var card = document.createElement('div');
    card.className = 'ca-unlock-card';

    var title = document.createElement('h1');
    title.className = 'ca-unlock-title';
    title.id = 'ca-unlock-title';
    title.textContent = '解锁私人阅读室';
    card.appendChild(title);

    var desc = document.createElement('p');
    desc.className = 'ca-unlock-desc';
    desc.id = 'ca-unlock-desc';
    desc.textContent = '本站只发布密文。口令仅在浏览器内存中用于解密，不会被保存或发送。';
    card.appendChild(desc);

    var label = document.createElement('label');
    label.className = 'ca-unlock-label';
    label.setAttribute('for', 'ca-passphrase');
    label.textContent = '访问口令';
    card.appendChild(label);

    inputEl = document.createElement('input');
    inputEl.className = 'ca-unlock-input';
    inputEl.id = 'ca-passphrase';
    inputEl.type = 'password';
    inputEl.autocomplete = 'off';
    inputEl.autocapitalize = 'off';
    inputEl.spellcheck = false;
    inputEl.setAttribute('aria-describedby', 'ca-unlock-desc ca-unlock-error');
    card.appendChild(inputEl);

    submitEl = document.createElement('button');
    submitEl.className = 'ca-unlock-submit';
    submitEl.id = 'ca-unlock-submit';
    submitEl.type = 'button';
    submitEl.textContent = '解锁';
    submitEl.addEventListener('click', function () { void handleUnlock(); });
    card.appendChild(submitEl);

    errorEl = document.createElement('p');
    errorEl.className = 'ca-error';
    errorEl.id = 'ca-unlock-error';
    errorEl.setAttribute('role', 'alert');
    errorEl.hidden = true;
    card.appendChild(errorEl);

    inputEl.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        void handleUnlock();
      }
    });

    overlayEl.appendChild(card);
    document.body.appendChild(overlayEl);
  }

  async function loadSite(signal) {
    var bytes = await fetchBytes('site.json', MAX_SITE_BYTES, signal);
    var text;
    try {
      text = decoder.decode(bytes);
    } catch (e) {
      throw fail('invalid site encoding');
    }
    return parseSite(text);
  }

  async function unwrapDek(parsed, passphrase) {
    var kdf = parsed.site.kdf;
    var material = await subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    var kekBits = await subtle.deriveBits(
      { name: 'PBKDF2', salt: parsed.salt, iterations: kdf.iterations, hash: 'SHA-256' },
      material,
      KEY_BYTES * 8
    );
    var kek = await subtle.importKey('raw', kekBits, 'AES-GCM', false, ['decrypt']);
    var dekBytes;
    try {
      dekBytes = new Uint8Array(
        await subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: parsed.nonce,
            additionalData: aad(parsed.site.archive_id, 'wrap', 'dek'),
            tagLength: TAG_BITS,
          },
          kek,
          parsed.wrapped
        )
      );
    } catch (e) {
      throw fail('unlock failed');
    }
    if (dekBytes.length !== KEY_BYTES) throw fail('invalid key');
    return dekBytes;
  }

  async function verifyIndexAddress(dekBytes, archiveId, oid) {
    var hkdfKey = await subtle.importKey('raw', dekBytes, 'HKDF', false, ['deriveBits']);
    var addressBits = await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('CA-ENC-1/address') },
      hkdfKey,
      KEY_BYTES * 8
    );
    var hmacKey = await subtle.importKey('raw', addressBits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    var signature = await subtle.sign('HMAC', hmacKey, encoder.encode('CA-ENC-1/oid\u0000index\u0000index'));
    if (hex(new Uint8Array(signature)) !== oid) throw fail('index address mismatch');
    return archiveId;
  }

  async function handleUnlock() {
    if (!inputEl || !submitEl) return;
    var passphrase = inputEl.value;
    inputEl.value = '';
    setError('');
    if (!passphrase) {
      setError('请输入口令。');
      inputEl.focus();
      return;
    }
    submitEl.disabled = true;
    var myEpoch = ++epoch;
    locked = true;
    if (unlockAbort) {
      try { unlockAbort.abort(); } catch (e) { /* ignore */ }
    }
    unlockAbort = new AbortController();
    var controller = unlockAbort;
    try {
      var parsed = await loadSite(controller.signal);
      if (epoch !== myEpoch) return;
      var dekBytes = await unwrapDek(parsed, passphrase);
      passphrase = '';
      if (epoch !== myEpoch) return;

      var indexOid = oidOf(parsed.site.index.file);
      await verifyIndexAddress(dekBytes, parsed.site.archive_id, indexOid);
      if (epoch !== myEpoch) return;

      var dekKey = await subtle.importKey('raw', dekBytes, 'AES-GCM', false, ['decrypt']);
      dekBytes = null;
      session = { archiveId: parsed.site.archive_id, dekKey: dekKey };

      var indexBytes = await fetchBytes(parsed.site.index.file, MAX_INDEX_BYTES, controller.signal);
      if (indexBytes.length !== parsed.site.index.bytes + CIPHER_OVERHEAD) throw fail('index size mismatch');
      var plain = await decryptObject(indexBytes, 'index', indexOid);
      if (epoch !== myEpoch) return;
      var index = parseIndex(plain, parsed.site);
      if (epoch !== myEpoch) return;

      locked = false;
      hideOverlay();
      installChrome();
      window.CA_HOOKS = { mountBody: mountBody };
      if (core && typeof core.boot === 'function') {
        core.boot(index.articles, index.labels);
      } else {
        throw fail('reader core missing');
      }
    } catch (e) {
      session = null;
      locked = true;
      window.CA_HOOKS = null;
      if (core && typeof core.shutdown === 'function') {
        try { core.shutdown(); } catch (ignored) { /* ignore */ }
      }
      if (epoch === myEpoch) {
        setError(e && e.caFriendly ? '口令错误或站点数据被篡改，无法解锁。' : '无法解锁，请稍后重试。');
      }
      showOverlay();
    } finally {
      passphrase = '';
      if (unlockAbort === controller) unlockAbort = null;
      if (submitEl) submitEl.disabled = false;
      if (inputEl && locked && epoch === myEpoch) inputEl.focus();
    }
  }

  function installChrome() {
    var hint = document.querySelector('.header-hint');
    if (hint) hint.textContent = '端到端加密 · 本地解锁';
    if (exitBtn) return;
    var actions = document.querySelector('.reader-actions');
    if (!actions) return;
    exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.id = 'ca-lock-btn';
    exitBtn.className = 'reading-button';
    exitBtn.textContent = '退出';
    exitBtn.addEventListener('click', function () { lockAndClear(); });
    actions.insertBefore(exitBtn, actions.firstChild);
  }

  function lockAndClear() {
    epoch += 1;
    locked = true;
    bodyToken += 1;
    if (bodyAbort) {
      try { bodyAbort.abort(); } catch (e) { /* ignore */ }
      bodyAbort = null;
    }
    if (unlockAbort) {
      try { unlockAbort.abort(); } catch (e) { /* ignore */ }
      unlockAbort = null;
    }
    stopMedia();
    revokeBlobUrls();
    session = null;
    window.CA_HOOKS = null;
    if (core && typeof core.shutdown === 'function') {
      try { core.shutdown(); } catch (e) { /* ignore */ }
    }
    try {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (e) {
      /* ignore */
    }
    document.title = '内容收藏夹';
    if (inputEl) inputEl.value = '';
    setError('');
    showOverlay();
  }

  if (!subtle) {
    buildOverlay();
    setError('当前浏览器不支持 Web Crypto，无法解锁本站。');
    if (submitEl) submitEl.disabled = true;
    showOverlay();
    return;
  }

  buildOverlay();
  showOverlay();
  var initialHint = document.querySelector('.header-hint');
  if (initialHint) initialHint.textContent = '端到端加密 · 需要口令';
  if (inputEl) inputEl.focus();

  window.addEventListener('pagehide', function () {
    lockAndClear();
  });

  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      lockAndClear();
    }
  });

  // A locked page must never expose previously rendered content through the
  // back/forward cache even if a browser restores DOM without pagehide.
  window.addEventListener('unload', function () {
    epoch += 1;
    locked = true;
    stopMedia();
    revokeBlobUrls();
    session = null;
  });
})();
