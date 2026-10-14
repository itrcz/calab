// Developer docs behaviour (ADR-0099): drawer, search, code tabs, copy buttons, TOC scroll-spy.
// Plain ES2019, no dependencies, served from 'self' (CSP). Everything works without it except search.
(function () {
  'use strict';
  var root = document.querySelector('.docs');
  if (!root) return;
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };

  // ---- Drawer (≤ 1100 px): solid scrim, Escape / scrim / link closes, focus moves in and back.
  var menu = root.querySelector('[data-docs-menu]');
  var nav = document.getElementById('docs-nav');
  var scrim = root.querySelector('[data-docs-scrim]');
  var wide = window.matchMedia('(min-width: 1100px)');
  function setDrawer(open) {
    if (!menu || !nav || !scrim) return;
    root.toggleAttribute('data-nav-open', open);
    menu.setAttribute('aria-expanded', String(open));
    scrim.hidden = !open;
    if (open) {
      var cur = nav.querySelector('[aria-current="page"]') || nav.querySelector('a');
      if (cur) { cur.scrollIntoView({ block: 'center' }); cur.focus({ preventScroll: true }); }
    }
  }
  if (menu) menu.addEventListener('click', function () { setDrawer(!root.hasAttribute('data-nav-open')); });
  if (scrim) scrim.addEventListener('click', function () { setDrawer(false); });
  if (nav) nav.addEventListener('click', function (e) { if (e.target.closest('a')) setDrawer(false); });
  wide.addEventListener('change', function () { if (wide.matches) setDrawer(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && root.hasAttribute('data-nav-open')) { setDrawer(false); menu.focus(); }
  });
  var current = nav && nav.querySelector('[aria-current="page"]');
  if (current && wide.matches) current.scrollIntoView({ block: 'nearest' });

  // ---- Copy buttons
  var copied = root.getAttribute('data-copied') || 'Copied';
  root.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    var pre = btn.closest('figure').querySelector('pre');
    if (!pre || !navigator.clipboard) return;
    navigator.clipboard.writeText(pre.innerText.replace(/\n$/, '')).then(function () {
      var label = btn.textContent;
      btn.textContent = copied;
      btn.classList.add('is-done');
      setTimeout(function () { btn.textContent = label; btn.classList.remove('is-done'); }, 1500);
    });
  });

  // ---- Code tabs: click / arrows / Home / End; the choice applies to every group with that label.
  function selectTab(label, focus) {
    root.querySelectorAll('[data-tabs]').forEach(function (group) {
      var tabs = group.querySelectorAll('[role="tab"]');
      var match = null;
      tabs.forEach(function (t) { if (t.getAttribute('data-tab') === label) match = t; });
      if (!match) return;
      tabs.forEach(function (t) {
        var on = t === match;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
    });
    if (focus) focus.focus();
    store.set('calab.docs.tab', label);
  }
  root.addEventListener('click', function (e) {
    var tab = e.target.closest('[data-tabs] [role="tab"]');
    if (tab) selectTab(tab.getAttribute('data-tab'));
  });
  root.addEventListener('keydown', function (e) {
    var tab = e.target.closest && e.target.closest('[data-tabs] [role="tab"]');
    if (!tab) return;
    var tabs = Array.prototype.slice.call(tab.parentNode.querySelectorAll('[role="tab"]'));
    var i = tabs.indexOf(tab);
    var next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length]
      : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    selectTab(next.getAttribute('data-tab'), next);
  });
  var saved = store.get('calab.docs.tab');
  if (saved) selectTab(saved);

  // ---- TOC scroll-spy: the last heading above the top third of the viewport is current.
  var tocLinks = root.querySelectorAll('[data-toc]');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var heads = [];
    tocLinks.forEach(function (a) { var h = document.getElementById(a.getAttribute('data-toc')); if (h) heads.push(h); });
    var visible = new Set();
    var mark = function () {
      var id = null;
      for (var i = 0; i < heads.length; i++) if (visible.has(heads[i])) { id = heads[i].id; break; }
      if (id === null) {
        for (var j = heads.length - 1; j >= 0; j--) if (heads[j].getBoundingClientRect().top < 120) { id = heads[j].id; break; }
      }
      tocLinks.forEach(function (a) { a.toggleAttribute('aria-current', a.getAttribute('data-toc') === id); });
    };
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) visible.add(en.target); else visible.delete(en.target); });
      mark();
    }, { rootMargin: '-64px 0px -66% 0px' });
    heads.forEach(function (h) { io.observe(h); });
  }

  // ---- Search: index loaded on first focus; prefix / substring scoring; results grouped by page.
  var input = document.getElementById('docs-q');
  var box = document.getElementById('docs-results');
  if (!input || !box) return;
  var index = null;
  var loading = null;
  var active = -1;
  var options = [];
  var noResults = root.getAttribute('data-no-results') || 'Nothing found';
  function load() {
    if (!loading) {
      loading = fetch(input.getAttribute('data-index')).then(function (r) { return r.json(); })
        .then(function (data) { index = data; render(); }, function () { loading = null; });
    }
  }
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hl(text, tokens) {
    var out = esc(text);
    tokens.forEach(function (t) {
      var re = new RegExp('(' + esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      out = out.replace(re, '<mark>$1</mark>');
    });
    return out;
  }
  function fieldScore(text, t, prefix, word, sub) {
    var s = text.toLowerCase();
    if (s.indexOf(t) === 0) return prefix;
    var at = s.indexOf(t);
    if (at < 0) return 0;
    return /[\s\-_/.(«"]/.test(s.charAt(at - 1)) ? word : sub;
  }
  function search(q) {
    var tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length || !index) return { tokens: tokens, pages: [] };
    var pages = [];
    index.forEach(function (p) {
      var hits = [];
      p.h.forEach(function (h) {
        var total = 0;
        for (var i = 0; i < tokens.length; i++) {
          var t = tokens[i];
          var sc = Math.max(fieldScore(h.t, t, 10, 8, 5), fieldScore(p.t, t, 6, 5, 3), fieldScore(h.x, t, 2, 2, 1), fieldScore(p.s, t, 1, 1, 1));
          if (!sc) return;
          total += sc;
        }
        hits.push({ h: h, score: total + (h.i === '' ? 1 : 0) });
      });
      if (!hits.length) return;
      hits.sort(function (a, b) { return b.score - a.score; });
      pages.push({ p: p, hits: hits.slice(0, 3), score: hits[0].score });
    });
    pages.sort(function (a, b) { return b.score - a.score; });
    return { tokens: tokens, pages: pages.slice(0, 8) };
  }
  function render() {
    var q = input.value.trim();
    options = [];
    active = -1;
    input.removeAttribute('aria-activedescendant');
    if (!q) { close(); return; }
    if (!index) { load(); return; }
    var res = search(q);
    var html = '';
    res.pages.forEach(function (r, pi) {
      html += '<div class="docs-result" role="group" aria-labelledby="dr-' + pi + '"><p class="docs-result-page" id="dr-' + pi + '">' +
        esc(r.p.t) + ' <span>' + esc(r.p.s) + '</span></p>';
      r.hits.forEach(function (hit) {
        var id = 'dro-' + options.length;
        var href = r.p.u + (hit.h.i ? '#' + encodeURIComponent(hit.h.i) : '');
        options.push(id);
        html += '<a role="option" id="' + id + '" href="' + esc(href) + '" aria-selected="false"><strong>' + hl(hit.h.t, res.tokens) +
          '</strong>' + (hit.h.x ? '<span>' + hl(hit.h.x.slice(0, 140), res.tokens) + '</span>' : '') + '</a>';
      });
      html += '</div>';
    });
    box.innerHTML = html || '<p class="docs-result-empty">' + esc(noResults) + '</p>';
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function close() {
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  }
  function move(d) {
    if (!options.length) return;
    if (active >= 0) document.getElementById(options[active]).setAttribute('aria-selected', 'false');
    active = (active + d + options.length) % options.length;
    var el = document.getElementById(options[active]);
    el.setAttribute('aria-selected', 'true');
    el.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', options[active]);
  }
  input.addEventListener('focus', load);
  input.addEventListener('input', render);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (box.hidden) render(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      var id = options[active >= 0 ? active : 0];
      if (id) { e.preventDefault(); location.href = document.getElementById(id).getAttribute('href'); close(); }
    } else if (e.key === 'Escape') {
      if (!box.hidden) { e.preventDefault(); close(); } else { input.value = ''; input.blur(); }
    }
  });
  document.addEventListener('pointerdown', function (e) { if (!e.target.closest('.docs-search')) close(); });
  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if ((e.key === '/' && !typing) || (e.key === 'k' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); input.focus(); input.select(); }
  });
})();
