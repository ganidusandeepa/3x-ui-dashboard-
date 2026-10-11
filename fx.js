/* fx.js — Award-winning animation & interactive UX layer for the 3x-ui dashboard.
 *
 * Capabilities:
 *   1. Apple Fluid Kinetic Momentum Scrolling (Lenis + GSAP ticker)
 *   2. Optical Glass Specular Refraction tracking on scroll & cursor
 *   3. Dynamic cursor-tracking glass spotlight on cards & pills (--spot-x, --spot-y)
 *   4. Magnetic hover physics on interactive control buttons
 *   5. 3D card tilt & specular glare (vanilla-tilt)
 *   6. Confetti bursts on copy/success actions (canvas-confetti)
 *   7. Shimmer skeleton on traffic hero metrics during load
 *
 * Defensive & robust: No-ops gracefully if any CDN library is unavailable or under
 * prefers-reduced-motion. Never throws errors into runtime.
 */
(function () {
  'use strict';

  var reduce = false;
  try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  /* ---------------- 1. Apple Fluid Kinetic Momentum Scrolling ---------------- */
  var lenisInstance = null;
  var rafId = null;

  function updateCardRefraction() {
    if (reduce) return;
    try {
      var viewH = window.innerHeight || 800;
      var cards = document.querySelectorAll('.card, .login-card');
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var rect = card.getBoundingClientRect();
        // Calculate vertical progress relative to viewport (-1 top, 0 center, 1 bottom)
        var centerOffset = (rect.top + rect.height * 0.5 - viewH * 0.5) / (viewH * 0.5);
        if (centerOffset >= -1.5 && centerOffset <= 1.5) {
          // Adjust subtle specular reflection offset
          var shift = Math.round(centerOffset * 12);
          card.style.setProperty('--scroll-shine', shift + 'px');
        }
      }
    } catch (e) {}
  }

  function onScrollTick() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = null;
      updateCardRefraction();
    });
  }

  function initSmoothScroll() {
    if (reduce || isTouch || typeof Lenis === 'undefined') {
      window.addEventListener('scroll', onScrollTick, { passive: true });
      return;
    }
    try {
      lenisInstance = new Lenis({
        duration: 1.25,
        easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
        direction: 'vertical',
        gestureDirection: 'vertical',
        smooth: true,
        smoothTouch: false,
        wheelMultiplier: 1.0,
        lerp: 0.08
      });

      if (typeof gsap !== 'undefined') {
        gsap.ticker.add(function (time) {
          lenisInstance.raf(time * 1000);
        });
        gsap.ticker.lagSmoothing(0);
      } else {
        function raf(time) {
          lenisInstance.raf(time);
          requestAnimationFrame(raf);
        }
        requestAnimationFrame(raf);
      }

      lenisInstance.on('scroll', function () {
        onScrollTick();
      });
    } catch (e) {
      window.addEventListener('scroll', onScrollTick, { passive: true });
    }
  }

  /* ---------------- 2. Cursor-Tracking Glass Spotlight ---------------- */
  function bindSpotlight(el) {
    if (!el || el.__fxSpot || reduce || isTouch) return;
    el.__fxSpot = true;
    el.addEventListener('mousemove', function (e) {
      var rect = el.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      el.style.setProperty('--spot-x', x.toFixed(1) + 'px');
      el.style.setProperty('--spot-y', y.toFixed(1) + 'px');
    });
  }

  function initSpotlightsAll(root) {
    try {
      (root || document).querySelectorAll('.card, .login-card, .live-pill').forEach(bindSpotlight);
    } catch (e) {}
  }

  /* ---------------- 3. Magnetic Button & Pipeline Node Physics ---------------- */
  var MAG_SEL = '.ping-btn, .plan-refresh, #btn-theme, #btn-bg, #btn-logout, .accent-btn, .topo-node';

  function bindMagnetic(btn) {
    if (!btn || btn.__fxMag || reduce || isTouch || typeof gsap === 'undefined') return;
    btn.__fxMag = true;
    var isNode = btn.classList.contains('topo-node');
    var pullFactor = isNode ? 0.18 : 0.28;

    btn.addEventListener('mousemove', function (e) {
      var rect = btn.getBoundingClientRect();
      var x = (e.clientX - (rect.left + rect.width / 2)) * pullFactor;
      var y = (e.clientY - (rect.top + rect.height / 2)) * pullFactor;
      gsap.to(btn, { x: x, y: y, duration: 0.24, ease: 'power2.out' });
    });

    btn.addEventListener('mouseleave', function () {
      gsap.to(btn, { x: 0, y: 0, duration: 0.45, ease: 'elastic.out(1, 0.45)' });
    });
  }

  function initMagneticAll(root) {
    try {
      (root || document).querySelectorAll(MAG_SEL).forEach(bindMagnetic);
    } catch (e) {}
  }

  /* ---------------- 4. 3D Card Tilt (Vanilla-Tilt) ---------------- */
  var TILT_SEL = '.data-card-hero, .card';

  function initTiltOn(el) {
    if (!el || el.__fxTilt) return;
    if (typeof VanillaTilt === 'undefined' || reduce || isTouch) return;
    if (el.classList.contains('main-chart-card')) return;
    try { if (el.querySelector && el.querySelector('canvas')) return; } catch (e) {}
    el.__fxTilt = true;
    try {
      VanillaTilt.init(el, {
        max: 3.5,
        speed: 400,
        scale: 1.008,
        perspective: 1200,
        glare: true,
        'max-glare': 0.10,
        gyroscope: false
      });
    } catch (e) { el.__fxTilt = false; }
  }

  function initTiltAll(root) {
    try { (root || document).querySelectorAll(TILT_SEL).forEach(initTiltOn); } catch (e) {}
  }

  /* ---------------- 5. Canvas Confetti ---------------- */
  function fire(opts) {
    if (reduce || typeof confetti !== 'function') return;
    try { confetti(Object.assign({ disableForReducedMotion: true, zIndex: 9999 }, opts)); } catch (e) {}
  }

  var PALETTE = ['#5cb85c', '#38bdf8', '#818cf8', '#ffffff'];

  function celebrate() {
    if (reduce || typeof confetti !== 'function') return;
    fire({ particleCount: 80, spread: 70, startVelocity: 42, origin: { y: 0.35 }, colors: PALETTE });
    setTimeout(function () { fire({ particleCount: 36, angle: 60, spread: 50, origin: { x: 0, y: 0.62 }, colors: PALETTE }); }, 120);
    setTimeout(function () { fire({ particleCount: 36, angle: 120, spread: 50, origin: { x: 1, y: 0.62 }, colors: PALETTE }); }, 120);
  }

  function popAt(x, y) {
    fire({ particleCount: 26, spread: 48, startVelocity: 24, scalar: 0.85, origin: { x: x, y: y }, colors: PALETTE });
  }

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

  /* ---------------- 6. Shimmer Skeleton on Hero Numbers ---------------- */
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
      setTimeout(finish, 4000);
    });
  }

  function initPingFx() {
    var btn = document.getElementById('btn-ping');
    if (!btn || btn.__fxPing) return;
    btn.__fxPing = true;
    btn.addEventListener('click', function () {
      var card = document.getElementById('ping-card');
      if (card && typeof gsap !== 'undefined' && !reduce) {
        gsap.fromTo(card, { scale: 0.988 }, { scale: 1, duration: 0.42, ease: 'elastic.out(1, 0.55)' });
      }
    });
  }

  /* ---------------- Boot ---------------- */
  function boot() {
    initSmoothScroll();
    initTiltAll(document);
    initSpotlightsAll(document);
    initMagneticAll(document);
    initPingFx();
    wrapToast();
    watchClientLoad();

    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (!n || n.nodeType !== 1) continue;
            if (n.matches && n.matches(TILT_SEL)) initTiltOn(n);
            initTiltAll(n);
            initSpotlightsAll(n);
            initMagneticAll(n);
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}

    setTimeout(wrapToast, 600);
    setTimeout(wrapToast, 1800);
    updateCardRefraction();
  }

  window.FX = {
    celebrate: celebrate,
    confetti: fire,
    popAt: popAt,
    initTilt: initTiltAll,
    getLenis: function () { return lenisInstance; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
