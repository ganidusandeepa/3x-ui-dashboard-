/* fx.js — extra animation layer for the 3x-ui dashboard.
 *
 * Adds, on top of the existing GSAP/anime setup:
 *   1. 3D hover tilt + light glare on cards (vanilla-tilt)
 *   2. Success confetti on login and copy actions (canvas-confetti)
 *   3. Shimmer skeleton on the hero traffic numbers while data loads
 *
 * Fully self-contained and defensive: every effect no-ops if its CDN lib
 * is missing, on touch devices where inappropriate, or under
 * prefers-reduced-motion. It never throws into the app.
 */
(function () {
  'use strict';

  var reduce = false;
  try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  /* ---------------- 3D card tilt ---------------- */
  var TILT_SEL = '.data-card-hero, .card';

  function initTiltOn(el) {
    if (!el || el.__fxTilt) return;
    if (typeof VanillaTilt === 'undefined' || reduce || isTouch) return;
    // Skip chart cards — tilting a live canvas looks glitchy.
    if (el.classList.contains('main-chart-card')) return;
    try { if (el.querySelector && el.querySelector('canvas')) return; } catch (e) {}
    el.__fxTilt = true;
    try {
      VanillaTilt.init(el, {
        max: 6, speed: 400, scale: 1.012, perspective: 1200,
        glare: true, 'max-glare': 0.18, gyroscope: false
      });
    } catch (e) { el.__fxTilt = false; }
  }

  function initTiltAll(root) {
    try { (root || document).querySelectorAll(TILT_SEL).forEach(initTiltOn); } catch (e) {}
  }

  /* ---------------- Confetti ---------------- */
  function fire(opts) {
    if (reduce || typeof confetti !== 'function') return;
    try { confetti(Object.assign({ disableForReducedMotion: true, zIndex: 9999 }, opts)); } catch (e) {}
  }

  var PALETTE = ['#7c5cff', '#22d3ee', '#34d399', '#ffffff'];

  function celebrate() {
    if (reduce || typeof confetti !== 'function') return;
    fire({ particleCount: 90, spread: 72, startVelocity: 44, origin: { y: 0.35 }, colors: PALETTE });
    setTimeout(function () { fire({ particleCount: 42, angle: 60, spread: 55, origin: { x: 0, y: 0.62 }, colors: PALETTE }); }, 130);
    setTimeout(function () { fire({ particleCount: 42, angle: 120, spread: 55, origin: { x: 1, y: 0.62 }, colors: PALETTE }); }, 130);
  }

  function popAt(x, y) {
    fire({ particleCount: 26, spread: 48, startVelocity: 26, scalar: 0.85,
      origin: { x: x, y: y }, colors: PALETTE });
  }

  /* Wrap showToast so copy/success toasts get a small burst — no edits to main.js. */
  function wrapToast() {
    if (typeof window.showToast !== 'function' || window.showToast.__fx) return;
    var orig = window.showToast;
    var wrapped = function (msg, type) {
      try {
        if (type !== 'error' && /copied|copy|success|connected|signed|welcome/i.test(String(msg || ''))) {
          popAt(0.5, 0.14);
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    wrapped.__fx = true;
    window.showToast = wrapped;
  }

  /* ---------------- Shimmer skeleton on hero numbers while loading ---------------- */
  var SKEL_IDS = ['user-used', 'user-dl', 'user-up'];

  function skeletonOn() {
    if (reduce) return;
    SKEL_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('fx-skeleton');
    });
  }
  function skeletonOff() {
    SKEL_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove('fx-skeleton');
    });
  }

  function watchClientLoad() {
    var btn = document.getElementById('btn-login-client');
    if (!btn || btn.__fxSkel) return;
    btn.__fxSkel = true;
    btn.addEventListener('click', function () {
      skeletonOn();
      var used = document.getElementById('user-used');
      var done = false;
      var finish = function () { if (done) return; done = true; skeletonOff(); };
      if (used) {
        try {
          var mo = new MutationObserver(function () {
            if ((used.textContent || '').trim() !== '0.00') { finish(); mo.disconnect(); }
          });
          mo.observe(used, { childList: true, characterData: true, subtree: true });
        } catch (e) {}
      }
      setTimeout(finish, 4000); // safety net so numbers never stay hidden
    });
  }

  /* ---------------- boot ---------------- */
  function boot() {
    initTiltAll(document);
    wrapToast();
    watchClientLoad();

    // Cards for the admin/client views render after login — pick them up live.
    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (!n || n.nodeType !== 1) continue;
            if (n.matches && n.matches(TILT_SEL)) initTiltOn(n);
            initTiltAll(n);
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}

    // main.js may (re)define showToast after us; re-wrap a couple of times.
    setTimeout(wrapToast, 600);
    setTimeout(wrapToast, 1800);
  }

  window.FX = { celebrate: celebrate, confetti: fire, popAt: popAt, initTilt: initTiltAll };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
