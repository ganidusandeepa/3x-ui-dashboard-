/* fx.js — Award-winning animation & interactive UX layer for the 3x-ui dashboard.
 *
 * Capabilities:
 *   1. Left-Side Vertical Scroll Telemetry Rail (#scroll-side-rail) with proximity dock wave & live section detection
 *   2. Lenis Butter-Smooth Kinetic Scrolling synced with GSAP ticker
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

  /* ---------------- 1. Left-Side Vertical Scroll Telemetry Rail ---------------- */
  var scrollTimeout = null;
  var TOTAL_TICKS = 21; // 0% to 100% in 5% increments

  function initSideRail() {
    var rail = document.getElementById('scroll-side-rail');
    var ticksContainer = document.getElementById('rail-ticks');
    if (!rail || !ticksContainer || rail.__initialized) return;
    rail.__initialized = true;

    // Generate precision ruler tick marks
    ticksContainer.innerHTML = '';
    for (var i = 0; i < TOTAL_TICKS; i++) {
      var tick = document.createElement('div');
      tick.className = 'rail-tick' + (i % 5 === 0 ? ' major' : '');
      tick.setAttribute('data-index', i);
      ticksContainer.appendChild(tick);
    }

    // Click on rail to jump-scroll
    rail.addEventListener('click', function (e) {
      var rect = ticksContainer.getBoundingClientRect();
      var clickY = e.clientY - rect.top;
      var ratio = Math.max(0, Math.min(1, clickY / rect.height));
      var maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      var targetScroll = ratio * maxScroll;
      if (lenisInstance) {
        lenisInstance.scrollTo(targetScroll, { duration: 1.1 });
      } else {
        window.scrollTo({ top: targetScroll, behavior: 'smooth' });
      }
    });
  }

  function updateSideRail(scrollPos, maxScroll) {
    var rail = document.getElementById('scroll-side-rail');
    var progLine = document.getElementById('rail-progress-line');
    var indicator = document.getElementById('rail-indicator');
    var pctEl = document.getElementById('rail-ind-pct');
    var secEl = document.getElementById('rail-ind-sec');
    if (!rail || !indicator) return;

    var pct = maxScroll > 0 ? Math.min(100, Math.max(0, (scrollPos / maxScroll) * 100)) : 0;

    if (progLine) progLine.style.height = pct.toFixed(1) + '%';
    indicator.style.top = pct.toFixed(1) + '%';
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';

    // Fluid proximity wave on ruler ticks (Linear / Rauno dock wave)
    var currentTickIdx = (pct / 100) * (TOTAL_TICKS - 1);
    var allTicks = rail.querySelectorAll('.rail-tick');
    allTicks.forEach(function (tick, idx) {
      var dist = Math.abs(idx - currentTickIdx);
      if (dist < 2.5) {
        var weight = Math.cos(dist * (Math.PI / 5));
        var width = 6 + (weight * 11);
        tick.style.width = width.toFixed(1) + 'px';
        if (weight > 0.65) {
          tick.classList.add('active');
        } else {
          tick.classList.remove('active');
        }
      } else {
        tick.classList.remove('active');
        tick.style.width = (idx % 5 === 0) ? '10px' : '6px';
      }
    });

    // Detect active card in viewport
    if (secEl) {
      var cards = document.querySelectorAll('#tab-user-view .card');
      var activeLabel = '01 · TRAFFIC';
      var midScreen = window.innerHeight * 0.42;

      cards.forEach(function (c, i) {
        var r = c.getBoundingClientRect();
        if (r.top <= midScreen && r.bottom >= midScreen) {
          var h3 = c.querySelector('h3, .plan-status-pill, .ping-eyebrow');
          var text = h3 ? h3.textContent.trim().replace(/^[^a-zA-Z0-9]+/, '') : ('SECTION ' + (i + 1));
          activeLabel = '0' + (i + 1) + ' · ' + text.toUpperCase().slice(0, 14);
        }
      });
      secEl.textContent = activeLabel;
    }

    // Show rail while scrolling, tuck away after 1.2s idle
    document.body.classList.add('is-scrolling');
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(function () {
      document.body.classList.remove('is-scrolling');
    }, 1200);
  }

  /* ---------------- 2. Lenis Smooth Scrolling ---------------- */
  var lenisInstance = null;

  function initSmoothScroll() {
    if (reduce || isTouch || typeof Lenis === 'undefined') return;
    try {
      lenisInstance = new Lenis({
        duration: 1.15,
        easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
        direction: 'vertical',
        gestureDirection: 'vertical',
        smooth: true,
        smoothTouch: false,
        wheelMultiplier: 1.05
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

      lenisInstance.on('scroll', function (e) {
        var max = document.documentElement.scrollHeight - window.innerHeight;
        updateSideRail(e.scroll, max);
      });
    } catch (e) {}
  }

  // Native window scroll fallback (for touch / reduced motion / no Lenis)
  function initNativeScrollFallback() {
    window.addEventListener('scroll', function () {
      if (lenisInstance) return;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var scroll = window.scrollY || window.pageYOffset || 0;
      updateSideRail(scroll, max);
    }, { passive: true });
  }

  /* ---------------- 3. Cursor-Tracking Glass Spotlight ---------------- */
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

  /* ---------------- 4. Magnetic Button Physics ---------------- */
  var MAG_SEL = '.ping-btn, .plan-refresh, #btn-theme, #btn-bg, #btn-logout, .accent-btn';

  function bindMagnetic(btn) {
    if (!btn || btn.__fxMag || reduce || isTouch || typeof gsap === 'undefined') return;
    btn.__fxMag = true;
    var pullFactor = 0.30;

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

  /* ---------------- 5. 3D Card Tilt (Vanilla-Tilt) ---------------- */
  var TILT_SEL = '.data-card-hero, .card';

  function initTiltOn(el) {
    if (!el || el.__fxTilt) return;
    if (typeof VanillaTilt === 'undefined' || reduce || isTouch) return;
    if (el.classList.contains('main-chart-card')) return;
    try { if (el.querySelector && el.querySelector('canvas')) return; } catch (e) {}
    el.__fxTilt = true;
    try {
      VanillaTilt.init(el, {
        max: 4,
        speed: 400,
        scale: 1.01,
        perspective: 1200,
        glare: true,
        'max-glare': 0.12,
        gyroscope: false
      });
    } catch (e) { el.__fxTilt = false; }
  }

  function initTiltAll(root) {
    try { (root || document).querySelectorAll(TILT_SEL).forEach(initTiltOn); } catch (e) {}
  }

  /* ---------------- 6. Canvas Confetti ---------------- */
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

  /* ---------------- 7. Shimmer Skeleton on Hero Numbers ---------------- */
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

  /* ---------------- Boot ---------------- */
  function boot() {
    initSideRail();
    initSmoothScroll();
    initNativeScrollFallback();
    initTiltAll(document);
    initSpotlightsAll(document);
    initMagneticAll(document);
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
