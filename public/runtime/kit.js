/* FairFight BD motion kit. Everything here is seeded and driven by paused timelines. */
(function () {
  const FF = (window.FF = {});
  const FRAME = 1 / 30;

  FF.rng = function (seed) {
    let s = seed >>> 0;
    return function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };

  /* Split on spaces only. Bengali conjuncts and matras must never be split into letters. */
  FF.split = function (sel) {
    document.querySelectorAll(sel).forEach((el) => {
      if (el.dataset.split) return;
      el.dataset.split = "1";
      const walk = (node) => {
        Array.from(node.childNodes).forEach((n) => {
          if (n.nodeType === 3) {
            const frag = document.createDocumentFragment();
            n.textContent.split(/(\s+)/).forEach((part) => {
              if (!part) return;
              if (/^\s+$/.test(part)) {
                frag.appendChild(document.createTextNode(" "));
                return;
              }
              const w = document.createElement("span");
              w.className = "w";
              w.textContent = part;
              frag.appendChild(w);
            });
            node.replaceChild(frag, n);
          } else if (n.nodeType === 1 && n.tagName !== "BR") {
            walk(n);
          }
        });
      };
      walk(el);
    });
  };

  /* Title entrances. Each film beat picks a different one. */
  FF.blurWords = function (tl, sel, t, stagger) {
    FF.split(sel);
    tl.fromTo(
      sel + " .w",
      { opacity: 0 },
      { opacity: 1, duration: 0.2, stagger: stagger || 0.08, ease: "power2.out" },
      t,
    );
  };
  FF.riseWords = function (tl, sel, t, stagger) {
    FF.split(sel);
    tl.fromTo(
      sel + " .w",
      { opacity: 0, y: 46, rotation: 3 },
      { opacity: 1, y: 0, rotation: 0, duration: 0.5, stagger: stagger || 0.07, ease: "expo.out" },
      t,
    );
  };
  FF.greyWords = function (tl, sel, t, stagger) {
    FF.split(sel);
    tl.fromTo(
      sel + " .w",
      { opacity: 0.16 },
      { opacity: 1, duration: 0.14, stagger: stagger || 0.09, ease: "none" },
      t,
    );
  };
  FF.slam = function (tl, sel, t, from) {
    tl.fromTo(
      sel,
      { opacity: 0, scale: from || 1.9 },
      { opacity: 1, scale: 1, duration: 0.3, ease: "expo.out" },
      t,
    );
  };
  FF.pop = function (tl, sel, t, opts) {
    const o = opts || {};
    tl.fromTo(
      sel,
      { opacity: 0, scale: o.from == null ? 0.2 : o.from, rotation: o.rot || 0 },
      {
        opacity: 1,
        scale: 1,
        rotation: 0,
        duration: o.dur || 0.5,
        stagger: o.stagger || 0,
        ease: o.ease || "back.out(2)",
      },
      t,
    );
  };
  FF.out = function (tl, sel, t, dur) {
    tl.to(sel, { opacity: 0, duration: dur || 0.18, ease: "power2.in" }, t);
  };

  /* Three-frame impact shake on a wrapper that nothing else transforms. */
  FF.shake = function (tl, sel, t, px) {
    const p = px || 16;
    tl.set(sel, { x: p, y: -p * 0.6 }, t);
    tl.set(sel, { x: -p * 0.7, y: p * 0.5 }, t + FRAME);
    tl.set(sel, { x: p * 0.35, y: -p * 0.2 }, t + FRAME * 2);
    tl.set(sel, { x: 0, y: 0 }, t + FRAME * 3);
  };

  /* Scene entrance and exit on the .stage wrapper: the cut lands on the fastest frame. */
  FF.whipIn = function (tl, sel, dir, t) {
    tl.fromTo(
      sel,
      { x: (dir || 1) * 420 },
      { x: 0, duration: 0.34, ease: "expo.out" },
      t || 0,
    );
  };
  FF.whipOut = function (tl, sel, dir, end) {
    tl.to(sel, { x: -(dir || 1) * 420, duration: 0.2, ease: "power3.in" }, end - 0.2);
  };
  FF.zoomIn = function (tl, sel, t) {
    tl.fromTo(
      sel,
      { scale: 1.28 },
      { scale: 1, duration: 0.36, ease: "expo.out" },
      t || 0,
    );
  };
  FF.zoomOut = function (tl, sel, end) {
    tl.to(sel, { scale: 1.5, duration: 0.2, ease: "power3.in" }, end - 0.2);
  };

  /* Expanding shockwave ring. */
  FF.ring = function (tl, parent, t, o) {
    const host = document.querySelector(parent);
    const r = o.r || 300;
    const el = document.createElement("div");
    el.style.cssText =
      "position:absolute;border-radius:50%;pointer-events:none;box-sizing:border-box;" +
      "left:" + (o.x - r) + "px;top:" + (o.y - r) + "px;width:" + r * 2 + "px;height:" + r * 2 + "px;" +
      "border:" + (o.w || 10) + "px solid " + (o.color || "#49a6ff") + ";opacity:0";
    host.appendChild(el);
    tl.set(el, { opacity: 0.95, scale: 0.12 }, t);
    tl.to(el, { opacity: 0, scale: 1, duration: o.dur || 0.6, ease: "expo.out" }, t);
  };

  /* Seeded particle burst with gravity. kind: "confetti", "spark" or "coin". */
  FF.burst = function (tl, parent, t, o) {
    const host = document.querySelector(parent);
    const rnd = FF.rng(o.seed || 7);
    const cols = o.colors || ["#ffd65a", "#49a6ff", "#2bd07a", "#ff6a76", "#ffffff"];
    const n = o.n || 30;
    for (let i = 0; i < n; i++) {
      const el = document.createElement("i");
      el.setAttribute("data-layout-ignore", "");
      const c = cols[Math.floor(rnd() * cols.length)];
      let w = 14 + rnd() * 12;
      let h = 22 + rnd() * 16;
      let extra = "border-radius:3px;background:" + c + ";";
      if (o.kind === "spark") {
        w = 6;
        h = 34 + rnd() * 44;
        extra = "border-radius:6px;background:" + c + ";box-shadow:0 0 14px " + c + ";";
      }
      if (o.kind === "coin") {
        w = h = 30 + rnd() * 18;
        extra = "border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff3b8,#ffc21e 55%,#b6861a);box-shadow:0 0 12px rgba(255,194,30,.6);";
      }
      el.style.cssText =
        "position:absolute;display:block;left:" + (o.x - w / 2) + "px;top:" + (o.y - h / 2) + "px;width:" + w + "px;height:" + h + "px;opacity:0;" + extra;
      host.appendChild(el);
      const a = o.spread != null ? -Math.PI / 2 + (rnd() - 0.5) * o.spread : rnd() * Math.PI * 2;
      const d = (o.r || 480) * (0.45 + rnd() * 0.75);
      const dx = Math.cos(a) * d;
      const dy = Math.sin(a) * d;
      const life = 0.45 + rnd() * 0.3;
      const rot = (rnd() - 0.5) * 900;
      const faceAngle = (a * 180) / Math.PI + 90;
      tl.set(el, { opacity: 1, x: 0, y: 0, rotation: o.kind === "spark" ? faceAngle : 0, scale: 0.4 }, t);
      tl.to(el, { x: dx, y: dy, rotation: o.kind === "spark" ? faceAngle : rot, scale: 1, duration: life, ease: "power3.out" }, t);
      if (o.kind === "spark") {
        tl.to(el, { opacity: 0, scaleY: 0.1, duration: 0.2, ease: "power1.in" }, t + life - 0.14);
      } else {
        tl.to(el, { y: "+=" + (o.fall || 420), rotation: "+=" + rot * 0.5, duration: 0.95, ease: "power2.in" }, t + life);
        tl.to(el, { opacity: 0, duration: 0.3, ease: "none" }, t + life + 0.65);
      }
    }
  };

  /* Count a number up in Bengali digits. Reads only the tween's own value, so any seek is exact. */
  const BN = "০১২৩৪৫৬৭৮৯";
  FF.bn = function (n) {
    return String(Math.round(n)).replace(/[0-9]/g, (d) => BN[+d]);
  };
  FF.count = function (tl, sel, t, from, to, dur, prefix) {
    const el = document.querySelector(sel);
    const state = { v: from };
    const write = () => {
      el.textContent = (prefix || "") + FF.bn(state.v);
    };
    write();
    tl.to(state, { v: to, duration: dur, ease: "power2.out", onUpdate: write, onComplete: write, onReverseComplete: write }, t);
  };

  /* Rotating sun rays, sized for a behind-the-hero glow. */
  FF.raysSvg = function (size, count, color) {
    const n = count || 16;
    let s = '<svg width="' + size + '" height="' + size + '" viewBox="-100 -100 200 200"><defs><radialGradient id="rg' + size + '"><stop offset="0" stop-color="' + color + '" stop-opacity=".85"/><stop offset="1" stop-color="' + color + '" stop-opacity="0"/></radialGradient></defs><g fill="url(#rg' + size + ')">';
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 360;
      s += '<path d="M0 0 L-7 -100 L7 -100 Z" transform="rotate(' + a + ')"/>';
    }
    return s + "</g></svg>";
  };

  /* The taka coin, used by every money beat. */
  FF.coinSvg = function (size) {
    return (
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 100 100"><circle cx="50" cy="53" r="44" fill="#a8760f"/><circle cx="50" cy="48" r="44" fill="#ffc21e"/><circle cx="50" cy="48" r="35" fill="#ffd65a" stroke="#d99a12" stroke-width="3"/><path d="M26 28 A32 32 0 0 1 60 18" fill="none" stroke="#fff6cf" stroke-width="5" stroke-linecap="round"/><text x="50" y="66" text-anchor="middle" font-family="Anek Bangla" font-weight="800" font-size="50" fill="#8a5f0a">৳</text></svg>'
    );
  };
})();
