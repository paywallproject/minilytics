/*! Minilytics tracker — <script defer data-website-id="SITE_ID" src="https://YOUR-HOST/js/script.js"></script> */
(function () {
  'use strict';
  var w = window, d = document, loc = w.location, nav = w.navigator;
  var script = d.currentScript;
  if (!script) return;

  var siteId = script.getAttribute('data-website-id');
  var endpoint = script.getAttribute('data-api') || new URL(script.src).origin + '/api/event';
  var allowLocal = script.hasAttribute('data-allow-localhost');
  // Opt-in for sites flooded by page-loading bots: wait for a sign of a person before counting a Direct visit (see "held" below).
  var requireInteraction = script.hasAttribute('data-require-interaction');
  var cookieDomain = script.getAttribute('data-domain');
  var VID = 'ml_vid', SID = 'ml_sid', YEAR = 31536000, SESSION = 1800;

  var queued = (w.minilytics && w.minilytics.q) || [];
  function noop() {}

  // Opt yourself out: visit any page with ?ml_ignore=true (undo with ?ml_ignore=false).
  try {
    var ig = new URLSearchParams(loc.search).get('ml_ignore');
    if (ig === 'true') localStorage.setItem('ml_ignore', '1');
    if (ig === 'false') localStorage.removeItem('ml_ignore');
  } catch (e) {}
  var ignored = false;
  try { ignored = localStorage.getItem('ml_ignore') === '1'; } catch (e) {}
  var local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|.*\.local$)/.test(loc.hostname) || loc.protocol === 'file:';
  if (!siteId || ignored || nav.webdriver || (local && !allowLocal)) {
    w.minilytics = noop;
    w.minilytics.attribution = function () { return {}; };
    return;
  }

  // ---- cookies (first-party, shared across subdomains so app.site.com and site.com are one visitor)
  function readCookie(name) {
    var m = d.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function rootDomain() {
    if (cookieDomain) return cookieDomain;
    var parts = loc.hostname.split('.');
    if (parts.length < 2 || /^\d+$/.test(parts[parts.length - 1])) return null;
    for (var i = parts.length - 2; i >= 0; i--) {
      var cand = parts.slice(i).join('.');
      d.cookie = 'ml_t=1; path=/; domain=' + cand + '; SameSite=Lax';
      if (readCookie('ml_t')) {
        d.cookie = 'ml_t=; path=/; domain=' + cand + '; max-age=0';
        return cand;
      }
    }
    return null;
  }
  var domain = rootDomain();
  var newSession = !readCookie(SID);
  function writeCookie(name, value, maxAge) {
    d.cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=' + maxAge + '; SameSite=Lax' +
      (domain ? '; domain=' + domain : '') + (loc.protocol === 'https:' ? '; Secure' : '');
  }
  function uuid() {
    if (w.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }
  function ids() {
    var vid = readCookie(VID) || uuid();
    var sid = readCookie(SID) || uuid();
    writeCookie(VID, vid, YEAR);
    writeCookie(SID, sid, SESSION); // sliding 30 minute session
    return { vid: vid, sid: sid };
  }

  // ---- transport
  // Personal data in URLs (e.g. ?email= on a payment return page) never leaves the browser.
  var PRIVATE_PARAM = /^(e-?mail|name|phone|password|pass|token|access_token|id_token|auth|code|secret|key|api_key|license_key|license)$/i;
  function cleanUrl(href) {
    try {
      var u = new URL(href);
      var drop = [];
      u.searchParams.forEach(function (_, k) { if (PRIVATE_PARAM.test(k)) drop.push(k); });
      for (var i = 0; i < drop.length; i++) u.searchParams.delete(drop[i]);
      return u.toString();
    } catch (e) { return href; }
  }
  var lastPageviewAt = 0;
  function send(type, extra, beacon) {
    if (type === 'pageview') lastPageviewAt = Date.now();
    // While a pageview is held, other events wait with it: a goal can fire on its own when the page loads (the
    // PaywallProject plugin reports "paywall shown" on every article, bots included), so it isn't a sign of a
    // person. Logging in is: that sends everything. Clicks get here after the pointerdown that already released.
    if (held && type !== 'ping') {
      if (type !== 'identify') { if (queued.length < 20) queued.push([type, extra, beacon]); return; }
      release();
    }
    var id = ids();
    var body = { w: siteId, t: type, u: cleanUrl(loc.href), vid: id.vid, sid: id.sid, sw: w.screen ? screen.width : 0, v: 2 };
    for (var k in extra) if (extra[k] !== undefined) body[k] = extra[k];
    var json = JSON.stringify(body);
    // text/plain keeps this a "simple" request: no CORS preflight, works with sendBeacon.
    if (beacon && nav.sendBeacon) {
      try { if (nav.sendBeacon(endpoint, new Blob([json], { type: 'text/plain' }))) return; } catch (e) {}
    }
    try {
      fetch(endpoint, { method: 'POST', body: json, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } }).catch(noop);
    } catch (e) {}
  }

  // ---- engaged time (only while the tab is visible)
  var visibleSince = d.visibilityState === 'visible' ? Date.now() : 0;
  var pending = 0, pings = 0, shown = 0;
  function flushTime(beacon) {
    if (visibleSince) {
      var dt = Date.now() - visibleSince;
      pending += dt;
      shown += dt;
      visibleSince = d.visibilityState === 'visible' ? Date.now() : 0;
    }
    if (pending >= 1000 && !held) { send('ping', { d: Math.round(pending), a: early && acts ? acts + '.' + actSecs : undefined }, beacon); pending = 0; }
  }
  d.addEventListener('visibilitychange', function () {
    if (d.visibilityState === 'visible') { visibleSince = Date.now(); earlyAgain(); }
    else flushTime(true);
  });
  w.addEventListener('pagehide', function () { sendEngage(); flushTime(true); });
  setInterval(function () {
    if (d.visibilityState === 'visible' && pings < 30) { pings++; flushTime(false); }
  }, 60000);
  // On the first page of a new visit, also report time early (at about 1s, 3.5s and 15.5s on screen): the server
  // holds some new visits until there's a sign someone saw the page, and this counts them at once, without relying
  // on the report sent when the page closes (which phones often drop).
  // The same on the other pages of a visit's first few minutes (the server may still be holding the visit), and
  // again once the page has been on screen 15.5s in total when the reader switched tabs in between.
  if (newSession) writeCookie('ml_y', '1', 300);
  var early = newSession || !!readCookie('ml_y');
  function earlyFlush() { if (d.visibilityState === 'visible') flushTime(false); }
  function earlyAgain() { if (early && shown < 15500) setTimeout(earlyFlush, 15500 - shown + 100); }
  if (early) [1200, 3500, 15500].forEach(function (t) { setTimeout(earlyFlush, t); });


  // ---- pageviews (including single-page-app navigation)
  var lastPage = null, firstView = true;
  function pageview() {
    var page = loc.pathname + loc.search;
    if (page === lastPage) return;
    if (lastPage !== null) flushTime(false);
    lastPage = page;
    pings = 0;
    var data = { r: firstView ? d.referrer : '', tz: firstView ? timeZone() : undefined };
    // A new visit with no referrer and no campaign tags is where page-loading bots hide (they arrive "Direct" and
    // never touch the page). Hold its pageview until the first sign of a person: moving the mouse, scrolling,
    // tapping, clicking or typing. Visits from anywhere else are counted straight away. Only on sites that opt in.
    if (firstView && newSession && requireInteraction && !externalReferrer() && !/[?&](utm_\w+|ref|via|gclid|fbclid|msclkid)=/i.test(loc.search)) held = data;
    else send('pageview', data);
    firstView = false;
  }
  // A referrer from this same site doesn't count: a person who got here from another page of the site has already
  // clicked or pressed a key there, which would have started their visit.
  function externalReferrer() {
    try {
      var h = new URL(d.referrer).hostname;
      return !!h && h !== loc.hostname && !(domain && (h === domain || h.slice(-domain.length - 1) === '.' + domain));
    } catch (e) { return false; }
  }
  var held = null, queued = [];
  function release() {
    var data = held, q = queued;
    held = null;
    queued = [];
    if (data) send('pageview', data);
    for (var i = 0; i < q.length; i++) send(q[i][0], q[i][1], q[i][2]);
  }
  function timeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return undefined; }
  }

  // ---- engagement: the first real mouse move, scroll, tap, click or keypress on this page (bots that only load pages never send it)
  var engaged = false, ENGAGE = ['pointermove', 'scroll', 'pointerdown', 'keydown', 'touchstart'];
  function onEngage(e) {
    if (engaged || (e && e.isTrusted === false)) return;
    engaged = true;
    ENGAGE.forEach(function (t) { w.removeEventListener(t, onEngage, true); });
    release();
    // Which interaction came first and how long after the page started loading (helps tell scripts from people).
    var ms;
    try { ms = Math.round(w.performance.now()); } catch (x) {}
    // Sent a moment after the pageview, so it doesn't overtake it (the mouse often moves as the page loads); sent at
    // once if the page closes first.
    // Also how long the page had been on screen by then (time in another tab or app doesn't count).
    var v = shown + (visibleSince ? Date.now() - visibleSince : 0);
    engageMsg = { p: { k: e && e.type, ms: ms, v: Math.round(v) } };
    var wait = Math.max(0, lastPageviewAt + 800 - Date.now());
    if (wait) setTimeout(sendEngage, wait);
    else sendEngage();
  }
  var engageMsg = null;
  function sendEngage() {
    if (!engageMsg) return;
    var m = engageMsg;
    engageMsg = null;
    send('engage', m, true);
  }
  ENGAGE.forEach(function (t) { w.addEventListener(t, onEngage, { capture: true, passive: true }); });
  // How much the page is used in a visit's first minutes (measuring only): every trusted move, scroll, tap or key,
  // and in how many separate seconds. A scripted crawler sends one mouse move; a person reading sends many.
  var acts = 0, actSecs = 0, lastActSec = -1;
  function onAct(e) {
    if (!early || (e && e.isTrusted === false) || acts >= 999) return;
    acts++;
    var sec = Math.floor(Date.now() / 1000);
    if (sec !== lastActSec) { lastActSec = sec; actSecs++; }
  }
  if (early) ENGAGE.forEach(function (t) { w.addEventListener(t, onAct, { capture: true, passive: true }); });
  var hist = w.history;
  if (hist && hist.pushState) {
    ['pushState', 'replaceState'].forEach(function (fn) {
      var orig = hist[fn];
      hist[fn] = function () { var r = orig.apply(this, arguments); setTimeout(pageview, 0); return r; };
    });
    w.addEventListener('popstate', pageview);
  }

  // ---- goals, outbound links, Dodo / Stripe / Polar checkout links
  function goal(name, props) {
    if (!name) return;
    send('goal', { n: String(name).slice(0, 64), p: props || undefined }, true);
  }
  function attribution() {
    var id = ids();
    return { ml_visitor_id: id.vid, ml_session_id: id.sid };
  }
  function isPolarCheckout(u) {
    if (!/(^|\.)polar\.sh$/.test(u.hostname)) return false;
    // Permanent checkout links and session URLs live on buy.polar.sh (polar_cl_ / polar_c_).
    if (/(^|\.)buy\.polar\.sh$/.test(u.hostname)) return true;
    return /polar_cl_|polar_c_/.test(u.pathname);
  }
  // Checkout links carry the visitor: Dodo links as metadata, Stripe payment links (buy.stripe.com) in
  // client_reference_id, unless the site already sets its own. Polar checkout links only persist
  // reference_id / UTM query params, so the visitor goes in reference_id. They're tagged as soon as they
  // appear on the page, not just on click, because other scripts (e.g. Umami's click tracking) may copy
  // the href and navigate before our click handler runs.
  function tagCheckoutLink(a) {
    try {
      var u = new URL(a.href);
      var att = attribution();
      var q = u.searchParams;
      if (/(^|\.)dodopayments\.com$/.test(u.hostname)) {
        q.set('metadata_ml_visitor_id', att.ml_visitor_id);
        q.set('metadata_ml_session_id', att.ml_session_id);
      } else if (u.hostname === 'buy.stripe.com') {
        var ref = q.get('client_reference_id');
        if (ref && ref.indexOf('ml_') !== 0) return;
        q.set('client_reference_id', 'ml_' + att.ml_visitor_id + '__' + att.ml_session_id);
      } else if (isPolarCheckout(u)) {
        if (!q.get('reference_id')) q.set('reference_id', att.ml_visitor_id);
      } else return;
      var next = u.toString();
      if (a.href !== next) a.href = next;
    } catch (e) {}
  }
  function tagCheckoutLinks() {
    var links = d.querySelectorAll('a[href*="dodopayments.com"], a[href*="buy.stripe.com"], a[href*="polar.sh"]');
    for (var i = 0; i < links.length; i++) tagCheckoutLink(links[i]);
  }
  var tagQueued = false;
  function queueTag() {
    if (tagQueued) return;
    tagQueued = true;
    setTimeout(function () { tagQueued = false; tagCheckoutLinks(); }, 50);
  }
  if (w.MutationObserver) {
    new MutationObserver(queueTag).observe(d.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', tagCheckoutLinks);
  else tagCheckoutLinks();
  // Refresh right before a click starts, in case the session id rotated while the page sat idle.
  function onPress(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a) tagCheckoutLink(a);
  }
  d.addEventListener('pointerdown', onPress, true);
  d.addEventListener('keydown', function (e) { if (e.key === 'Enter') onPress(e); }, true);
  function onClick(e) {
    var el = e.target && e.target.closest ? e.target : null;
    if (!el) return;
    var g = el.closest('[data-ml-goal]');
    if (g) {
      var props = {};
      for (var i = 0; i < g.attributes.length; i++) {
        var at = g.attributes[i];
        if (at.name.indexOf('data-ml-goal-') === 0) props[at.name.slice(13)] = at.value.slice(0, 255);
      }
      goal(g.getAttribute('data-ml-goal'), Object.keys(props).length ? props : undefined);
    }
    var a = el.closest('a[href]');
    if (a) {
      tagCheckoutLink(a);
      try {
        var u = new URL(a.href, loc.href);
        if (/^https?:$/.test(u.protocol) && u.hostname !== loc.hostname && !(domain && u.hostname.slice(-domain.length) === domain)) {
          send('outbound', { n: u.origin + u.pathname }, true);
        }
      } catch (err) {}
    }
  }
  d.addEventListener('click', onClick, true);
  d.addEventListener('auxclick', onClick, true);

  // ---- public API
  function api(cmd, a, b) {
    if (cmd === 'goal' || cmd === 'track') goal(a, b);
    else if (cmd === 'identify' && a) send('identify', { p: { user_id: a.user_id || a.id, email: a.email, name: a.name } });
    else if (cmd === 'pageview') { lastPage = null; pageview(); }
  }
  api.attribution = attribution;
  w.minilytics = api;

  pageview();
  for (var q = 0; q < queued.length; q++) api.apply(null, queued[q]);
})();
