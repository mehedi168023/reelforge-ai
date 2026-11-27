/* ReelForge neon reels kit: glowing captions, glass cards, karaoke boxes, emoji rain and stickers for
   talking-head reels. Everything is seeded and driven by the paused timeline, so any frame can be drawn alone.
   Glow is made from static gradients and tight shadows, never blur filters, so frames stay fast to draw. */
(function () {
  const RF = (window.RF = {});

  const COLORS = {
    red: { core: "#ff3347", light: "#ff8a94", deep: "#7a0010", ink: "#ffffff", glow: "255,30,50" },
    gold: { core: "#ffbf1f", light: "#fff2b0", deep: "#7a4c00", ink: "#2a1600", glow: "255,186,40" },
    purple: { core: "#9a3cff", light: "#dcb8ff", deep: "#33087a", ink: "#ffffff", glow: "150,60,255" },
    blue: { core: "#2b8cff", light: "#a8d6ff", deep: "#08307a", ink: "#ffffff", glow: "40,140,255" },
    green: { core: "#1fd07a", light: "#a9ffd2", deep: "#055a30", ink: "#002a14", glow: "40,210,120" },
    pink: { core: "#ff3d9a", light: "#ffb3d6", deep: "#7a0840", ink: "#ffffff", glow: "255,60,150" },
    white: { core: "#ffffff", light: "#ffffff", deep: "#8c95a5", ink: "#111111", glow: "255,255,255" },
  };
  RF.colors = COLORS;
  const col = (c) => COLORS[c] || COLORS.red;

  const EMOJI_FONT = "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
  const W = () => window.innerWidth || document.documentElement.clientWidth;
  const H = () => window.innerHeight || document.documentElement.clientHeight;

  RF.rng = function (seed) {
    let s = (seed || 1) >>> 0;
    return function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };

  let installed = false;
  function install() {
    if (installed) return;
    installed = true;
    const css = document.createElement("style");
    css.textContent =
      ".rf-layer{position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;pointer-events:none}" +
      ".rf-abs{position:absolute;left:0;top:0;white-space:nowrap}" +
      ".rf-bn{font-family:'Anek Bangla',sans-serif;font-weight:800;line-height:1.25}" +
      ".rf-en{font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;font-weight:800;letter-spacing:-0.02em;line-height:1.1}" +
      ".rf-w{display:inline-block}" +
      ".rf-halo{position:absolute;border-radius:50%;pointer-events:none}" +
      ".rf-emoji{font-family:" + EMOJI_FONT + ";line-height:1}";
    document.head.appendChild(css);
  }

  /** The layer components draw into, by default one shared full-frame layer on top of the page. */
  RF.layer = function (sel) {
    install();
    if (sel) return typeof sel === "string" ? document.querySelector(sel) : sel;
    let el = document.getElementById("rf-layer");
    if (!el) {
      el = document.createElement("div");
      el.id = "rf-layer";
      el.className = "rf-layer";
      document.body.appendChild(el);
    }
    return el;
  };

  function make(tag, cls, css, html) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (css) el.style.cssText = css;
    if (html != null) el.innerHTML = html;
    return el;
  }

  /** Places an element with its centre at x, y. GSAP keeps the centring when other tweens move it. */
  function place(el, x, y) {
    gsap.set(el, { x: x, y: y, xPercent: -50, yPercent: -50, opacity: 0 });
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  /** Whole words only: Bengali conjuncts and matras must never be split. */
  const words = (text) => String(text).trim().split(/\s+/);
  const fontClass = (text, font) => font || (/[ঀ-৿]/.test(text) ? "rf-bn" : "rf-en");

  /** A soft colour glow behind something, made from a static gradient. */
  function halo(c, alpha, cssBox) {
    return make("div", "rf-halo", cssBox + "background:radial-gradient(closest-side,rgba(" + c.glow + "," + alpha + "),rgba(" + c.glow + "," + alpha * 0.35 + ") 55%,rgba(" + c.glow + ",0) 100%)");
  }

  /** Neon text styling for one colour: bright core, white-hot centre and a tight glow. */
  function neonStyle(c) {
    return "color:" + c.core + ";text-shadow:0 0 1px rgba(255,255,255,.9),0 0 5px rgba(" + c.glow + ",1),0 0 14px rgba(" + c.glow + ",.9),0 0 28px rgba(" + c.glow + ",.55),0 3px 2px rgba(0,0,0,.6);";
  }
  const plainStyle = "color:#fff;text-shadow:0 3px 0 rgba(0,0,0,.45),0 0 6px rgba(0,0,0,.45);";

  function out(tl, el, end, dur) {
    if (end == null) return;
    tl.to(el, { opacity: 0, scale: 0.92, duration: dur || 0.16, ease: "power2.in" }, end - (dur || 0.16));
  }

  /* ---------------------------------------------------------------------------------------------
     neonText: the signature caption. Lines stack; a coloured line glows like a neon tube and a white
     line sits under it. Each line's words land one by one, from `at` or from per-word `times`.
     RF.neonText(tl, { t, end, x, y, size, lines: [{ text, color: 'red', at, times: [..] }, { text }] })
  --------------------------------------------------------------------------------------------- */
  RF.neonText = function (tl, o) {
    const host = RF.layer(o.host);
    const size = o.size || Math.round(W() * 0.078);
    const box = make("div", "rf-abs", "text-align:center;");
    host.appendChild(box);
    o.lines.forEach((line, li) => {
      const c = line.color && line.color !== "white" ? col(line.color) : null;
      const fs = line.size || (c ? size : Math.round(size * 0.9));
      const row = make("div", fontClass(line.text, line.font), "position:relative;font-size:" + fs + "px;" + (c ? neonStyle(c) : plainStyle));
      if (c) {
        const h = halo(c, line.glow == null ? 0.5 : line.glow, "left:-14%;right:-14%;top:-30%;bottom:-30%;");
        h.style.zIndex = "-1";
        row.appendChild(h);
        gsap.set(h, { opacity: 0 });
      }
      const spans = words(line.text).map((wd, i) => {
        const s = make("span", "rf-w", "", esc(wd));
        row.appendChild(s);
        if (i < words(line.text).length - 1) row.appendChild(document.createTextNode(" "));
        return s;
      });
      box.appendChild(row);
      const start = line.at != null ? line.at : o.t + li * 0.28;
      spans.forEach((s, i) => {
        const at = line.times ? line.times[i] : start + i * (o.stagger || 0.07);
        tl.fromTo(s, { opacity: 0, scale: 1.55, y: fs * 0.18 }, { opacity: 1, scale: 1, y: 0, duration: 0.24, ease: "back.out(2.2)" }, at);
        if (c) {
          // A neon tube flickers as it lights.
          tl.set(s, { opacity: 0.35 }, at + 0.1);
          tl.set(s, { opacity: 1 }, at + 0.14);
        }
      });
      if (c) tl.to(row.querySelector(".rf-halo"), { opacity: 1, duration: 0.3, ease: "power2.out" }, start);
    });
    place(box, o.x == null ? W() / 2 : o.x, o.y == null ? H() * 0.6 : o.y);
    tl.set(box, { opacity: 1 }, o.t);
    out(tl, box, o.end);
    return box;
  };

  /* ---------------------------------------------------------------------------------------------
     glassCard: a glossy 3D-looking pill with a light sweep, for hooks, claims and key phrases.
     RF.glassCard(tl, { t, end, text, color: 'gold'|'red'|'purple'|..., x, y, size, from: 'left'|'right', tilt })
  --------------------------------------------------------------------------------------------- */
  RF.glassCard = function (tl, o) {
    const host = RF.layer(o.host);
    const c = col(o.color || "gold");
    const size = o.size || Math.round(W() * 0.058);
    const dir = o.from === "left" ? -1 : 1;
    const card = make("div", "rf-abs", "");
    const glow = halo(c, 0.6, "left:-22%;right:-22%;top:-60%;bottom:-60%;");
    card.appendChild(glow);
    const body = make(
      "div",
      fontClass(o.text, o.font),
      "position:relative;overflow:hidden;font-size:" + size + "px;padding:" + size * 0.32 + "px " + size * 0.75 + "px;border-radius:" + size * 0.45 + "px;" +
        "color:" + c.ink + ";background:linear-gradient(180deg," + c.light + " 0%," + c.core + " 42%," + c.core + " 62%," + c.deep + " 100%);" +
        "border:" + Math.max(2, size * 0.05) + "px solid rgba(255,255,255,.75);" +
        "box-shadow:inset 0 " + -size * 0.14 + "px 0 rgba(0,0,0,.22),inset 0 " + size * 0.08 + "px 0 rgba(255,255,255,.45),0 " + size * 0.16 + "px 0 rgba(0,0,0,.3);" +
        "text-shadow:0 2px 0 rgba(" + (c.ink === "#ffffff" ? "0,0,0,.35" : "255,255,255,.45") + ");",
    );
    const shine = make("div", "", "position:absolute;left:4%;right:4%;top:6%;height:38%;border-radius:" + size * 0.4 + "px;background:linear-gradient(180deg,rgba(255,255,255,.6),rgba(255,255,255,0));");
    const sweep = make("div", "", "position:absolute;top:-30%;bottom:-30%;left:0;width:" + size * 0.9 + "px;background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.42),rgba(255,255,255,0));");
    body.appendChild(shine);
    body.appendChild(sweep);
    body.appendChild(make("span", "", "position:relative", esc(o.text)));
    card.appendChild(body);
    host.appendChild(card);
    place(card, o.x == null ? W() / 2 : o.x, o.y == null ? H() * 0.42 : o.y);
    gsap.set(sweep, { x: -size * 1.5, rotation: 18 });
    const tilt = o.tilt == null ? -4 * dir : o.tilt;
    tl.fromTo(card, { opacity: 0, xPercent: -50 + dir * 160, skewX: dir * -22, rotation: tilt * 3, scale: 0.8 }, { opacity: 1, xPercent: -50, skewX: 0, rotation: tilt, scale: 1, duration: 0.45, ease: "expo.out" }, o.t);
    tl.to(sweep, { x: size * 16, duration: 0.5, ease: "power2.inOut" }, o.t + 0.3);
    const hold = (o.end == null ? 2 : o.end - o.t) - 0.6;
    if (hold > 0.8) tl.to(card, { y: "-=" + size * 0.14, duration: hold / 2, ease: "sine.inOut", yoyo: true, repeat: 1 }, o.t + 0.45);
    if (o.end != null) tl.to(card, { opacity: 0, xPercent: -50 - dir * 120, skewX: dir * 18, duration: 0.22, ease: "power3.in" }, o.end - 0.22);
    return card;
  };

  /* ---------------------------------------------------------------------------------------------
     dashBox: words inside a dashed outline that light up karaoke-style as they are spoken.
     RF.dashBox(tl, { t, end, text, times: [one per word], color: 'purple', x, y, size })
  --------------------------------------------------------------------------------------------- */
  RF.dashBox = function (tl, o) {
    const host = RF.layer(o.host);
    const c = col(o.color || "purple");
    const size = o.size || Math.round(W() * 0.062);
    const box = make("div", "rf-abs " + fontClass(o.text, o.font), "font-size:" + size + "px;padding:" + size * 0.22 + "px " + size * 0.35 + "px;border:" + Math.max(2, size * 0.05) + "px dashed rgba(255,255,255,.9);border-radius:" + size * 0.2 + "px;background:rgba(0,0,0,.28);");
    const list = words(o.text);
    const spans = list.map((wd, i) => {
      const s = make("span", "rf-w", "position:relative;padding:0 " + size * 0.08 + "px;color:rgba(255,255,255,.45);");
      const fill = make("span", "", "position:absolute;left:0;top:8%;bottom:4%;width:100%;border-radius:" + size * 0.12 + "px;background:linear-gradient(180deg," + c.light + "," + c.core + " 55%," + c.deep + ");box-shadow:0 0 0 2px rgba(" + c.glow + ",.5);");
      fill.style.transformOrigin = "0 50%";
      const label = make("span", "", "position:relative", esc(wd));
      s.appendChild(fill);
      s.appendChild(label);
      box.appendChild(s);
      gsap.set(fill, { scaleX: 0 });
      return { s, fill, label };
    });
    host.appendChild(box);
    place(box, o.x == null ? W() / 2 : o.x, o.y == null ? H() * 0.62 : o.y);
    tl.fromTo(box, { opacity: 0, scale: 0.86 }, { opacity: 1, scale: 1, duration: 0.22, ease: "back.out(2)" }, o.t);
    spans.forEach((p, i) => {
      const at = o.times ? o.times[i] : o.t + 0.15 + i * 0.22;
      tl.to(p.fill, { scaleX: 1, duration: 0.16, ease: "power2.out" }, at);
      tl.to(p.label, { color: c.ink, duration: 0.08 }, at);
      tl.set(p.s, { color: "#fff" }, at);
    });
    out(tl, box, o.end);
    return box;
  };

  /* ---------------------------------------------------------------------------------------------
     wordPop: short English or Bengali line, word by word, with accent words in a glowing colour.
     RF.wordPop(tl, { t, end, text, times, accent: [index], color: 'blue', x, y, size })
  --------------------------------------------------------------------------------------------- */
  RF.wordPop = function (tl, o) {
    const host = RF.layer(o.host);
    const c = col(o.color || "blue");
    const size = o.size || Math.round(W() * 0.075);
    const box = make("div", "rf-abs " + fontClass(o.text, o.font), "font-size:" + size + "px;" + plainStyle);
    const accent = o.accent || [words(o.text).length - 1];
    words(o.text).forEach((wd, i) => {
      const hot = accent.includes(i);
      const s = make("span", "rf-w", "position:relative;" + (hot ? neonStyle(c) : ""), esc(wd));
      if (hot) {
        const h = halo(c, 0.45, "left:-25%;right:-25%;top:-35%;bottom:-35%;z-index:-1;");
        s.appendChild(h);
      }
      box.appendChild(s);
      box.appendChild(document.createTextNode(" "));
      const at = o.times ? o.times[i] : o.t + i * 0.16;
      tl.fromTo(s, { opacity: 0, y: size * 0.35, scale: hot ? 1.5 : 0.7 }, { opacity: 1, y: 0, scale: 1, duration: hot ? 0.32 : 0.2, ease: hot ? "back.out(2.6)" : "power3.out" }, at);
    });
    host.appendChild(box);
    place(box, o.x == null ? W() / 2 : o.x, o.y == null ? H() * 0.22 : o.y);
    tl.set(box, { opacity: 1 }, o.t);
    out(tl, box, o.end);
    return box;
  };

  /* ---------------------------------------------------------------------------------------------
     emojiRain: emoji rising from the bottom (or bursting from a point) for a feeling word.
     RF.emojiRain(tl, { t, dur, emoji: ['💀'], n, seed, mode: 'rise'|'burst', x, y, size: [min, max], top: 0.68 })
  --------------------------------------------------------------------------------------------- */
  RF.emojiRain = function (tl, o) {
    const host = RF.layer(o.host);
    const rnd = RF.rng(o.seed || 11);
    const list = o.emoji || ["💀"];
    const n = Math.min(o.n || 12, 24);
    const dur = o.dur || 2.2;
    const [smin, smax] = o.size || [Math.round(W() * 0.06), Math.round(W() * 0.17)];
    for (let i = 0; i < n; i++) {
      const s = smin + Math.pow(rnd(), 1.6) * (smax - smin);
      const el = make("div", "rf-abs rf-emoji", "font-size:" + s + "px;", list[i % list.length]);
      host.appendChild(el);
      const start = o.t + rnd() * dur * 0.45;
      const life = dur * (0.55 + rnd() * 0.45);
      const rot = (rnd() - 0.5) * 50;
      if (o.mode === "burst") {
        const a = -Math.PI / 2 + (rnd() - 0.5) * Math.PI * 1.4;
        const d = W() * (0.18 + rnd() * 0.3);
        place(el, o.x == null ? W() / 2 : o.x, o.y == null ? H() * 0.6 : o.y);
        tl.set(el, { opacity: 1, scale: 0.2, rotation: 0 }, start);
        tl.to(el, { x: "+=" + Math.cos(a) * d, y: "+=" + Math.sin(a) * d, scale: 1, rotation: rot, duration: 0.5, ease: "power3.out" }, start);
        tl.to(el, { y: "+=" + H() * 0.2, opacity: 0, duration: life - 0.5, ease: "power2.in" }, start + 0.5);
      } else {
        const x = (o.x0 == null ? W() * 0.08 : o.x0) + rnd() * ((o.x1 == null ? W() * 0.92 : o.x1) - (o.x0 == null ? W() * 0.08 : o.x0));
        place(el, x, H() + s);
        // `top` (a fraction of the height) is the ceiling, so emoji can stay under a caption.
        const rise = Math.min(H() * (0.3 + rnd() * 0.35) * (s / smax + 0.4), H() * (1 - (o.top == null ? 0 : o.top)) - s);
        tl.set(el, { opacity: s > smax * 0.75 ? 0.82 : 1, scale: 0.6, rotation: -rot }, start);
        tl.to(el, { y: "-=" + (rise + s), scale: 1, rotation: rot, duration: life, ease: "power2.out" }, start);
        tl.to(el, { x: "+=" + (rnd() - 0.5) * W() * 0.12, duration: life, ease: "sine.inOut" }, start);
        tl.to(el, { opacity: 0, duration: 0.35, ease: "power1.in" }, start + life - 0.35);
      }
    }
  };

  /* ---------------------------------------------------------------------------------------------
     sticker: an emoji or icon on a white rounded tile that pops in, wiggles, and pops out.
     RF.sticker(tl, { t, end, emoji: '🥶' | svg: '<svg..>', x, y, size, bg: '#fff' })
  --------------------------------------------------------------------------------------------- */
  RF.sticker = function (tl, o) {
    const host = RF.layer(o.host);
    const size = o.size || Math.round(W() * 0.16);
    const tile = make("div", "rf-abs", "width:" + size + "px;height:" + size + "px;border-radius:" + size * 0.22 + "px;background:" + (o.bg || "#fff") + ";box-shadow:0 " + size * 0.06 + "px 0 rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;");
    tile.appendChild(o.svg ? make("div", "", "width:78%;height:78%;", o.svg) : make("div", "rf-emoji", "font-size:" + size * 0.72 + "px;", o.emoji || "🔥"));
    host.appendChild(tile);
    place(tile, o.x == null ? W() / 2 : o.x, o.y == null ? H() * 0.75 : o.y);
    tl.fromTo(tile, { opacity: 0, scale: 0, rotation: -18 }, { opacity: 1, scale: 1, rotation: 0, duration: 0.42, ease: "back.out(2.6)" }, o.t);
    const life = (o.end == null ? 1.6 : o.end - o.t) - 0.6;
    if (life > 0.5) tl.to(tile, { rotation: 6, duration: life / 4, ease: "sine.inOut", yoyo: true, repeat: 3 }, o.t + 0.42);
    if (o.end != null) tl.to(tile, { scale: 0, opacity: 0, duration: 0.18, ease: "back.in(2)" }, o.end - 0.18);
    return tile;
  };

  /* ---------------------------------------------------------------------------------------------
     iconTile: an icon on dark glass with a glowing edge, for the topic of a line (money, chart, time).
     RF.iconTile(tl, { t, end, svg: RF.icons.chart, color: 'red', x, y, size })
  --------------------------------------------------------------------------------------------- */
  RF.iconTile = function (tl, o) {
    const host = RF.layer(o.host);
    const c = col(o.color || "red");
    const size = o.size || Math.round(W() * 0.15);
    const wrap = make("div", "rf-abs", "width:" + size + "px;height:" + size + "px;");
    wrap.appendChild(halo(c, 0.55, "left:-45%;right:-45%;top:-45%;bottom:-45%;"));
    const tile = make("div", "", "position:absolute;inset:0;border-radius:" + size * 0.16 + "px;background:linear-gradient(160deg,rgba(60,62,74,.78),rgba(14,14,20,.82));border:" + Math.max(2, size * 0.025) + "px solid rgba(255,255,255,.85);box-shadow:0 0 0 " + size * 0.025 + "px rgba(" + c.glow + ",.7),inset 0 0 0 " + size * 0.02 + "px rgba(" + c.glow + ",.45);display:flex;align-items:center;justify-content:center;");
    tile.appendChild(make("div", "", "width:70%;height:70%;", o.svg || RF.icons.chart));
    wrap.appendChild(tile);
    host.appendChild(wrap);
    place(wrap, o.x == null ? W() / 2 : o.x, o.y == null ? H() * 0.62 : o.y);
    tl.fromTo(wrap, { opacity: 0, scale: 0.3, rotation: 10 }, { opacity: 1, scale: 1, rotation: 0, duration: 0.4, ease: "back.out(2.2)" }, o.t);
    out(tl, wrap, o.end, 0.18);
    return wrap;
  };

  /* ---------------------------------------------------------------------------------------------
     lightLeak: a coloured flare sweeping in from an edge, to sell a card or a cut. Use on beats only.
     RF.lightLeak(tl, { t, dur, color: 'gold', side: 'right'|'left'|'top'|'bottom', strength })
  --------------------------------------------------------------------------------------------- */
  RF.lightLeak = function (tl, o) {
    const host = RF.layer(o.host);
    const c = col(o.color || "gold");
    const d = Math.max(W(), H()) * 0.7;
    const side = o.side || "right";
    const leak = halo(c, o.strength || 0.45, "left:0;top:0;width:" + d * 0.7 + "px;height:" + d + "px;");
    host.appendChild(leak);
    const pos = { right: [W(), H() * 0.45], left: [0, H() * 0.45], top: [W() * 0.5, 0], bottom: [W() * 0.5, H()] }[side];
    const drift = { right: [-W() * 0.18, 0], left: [W() * 0.18, 0], top: [0, H() * 0.12], bottom: [0, -H() * 0.12] }[side];
    place(leak, pos[0], pos[1]);
    const dur = o.dur || 1.2;
    tl.to(leak, { opacity: 1, duration: dur * 0.3, ease: "power2.out" }, o.t);
    tl.to(leak, { x: "+=" + drift[0], y: "+=" + drift[1], scaleY: 1.2, duration: dur, ease: "sine.inOut" }, o.t);
    tl.to(leak, { opacity: 0, duration: dur * 0.45, ease: "power2.in" }, o.t + dur * 0.55);
  };

  /** A lens streak: a thin bright horizontal line with a star, for the moment a card lands. */
  RF.streak = function (tl, o) {
    const host = RF.layer(o.host);
    const c = col(o.color || "gold");
    const len = o.len || W() * 0.9;
    const el = make("div", "rf-abs", "width:" + len + "px;height:" + Math.max(4, len * 0.008) + "px;border-radius:99px;background:linear-gradient(90deg,rgba(" + c.glow + ",0),rgba(255,255,255,.95) 50%,rgba(" + c.glow + ",0));");
    const star = halo(c, 1, "left:50%;top:50%;width:" + len * 0.12 + "px;height:" + len * 0.12 + "px;margin:" + -len * 0.06 + "px 0 0 " + -len * 0.06 + "px;");
    el.appendChild(star);
    host.appendChild(el);
    place(el, o.x == null ? W() / 2 : o.x, o.y == null ? H() / 2 : o.y);
    tl.fromTo(el, { opacity: 0, scaleX: 0.1 }, { opacity: 1, scaleX: 1, duration: 0.18, ease: "power3.out" }, o.t);
    tl.to(el, { opacity: 0, scaleX: 1.3, duration: 0.4, ease: "power2.in" }, o.t + 0.2);
  };

  /** A quick flash on a cut or a hit. */
  RF.flash = function (tl, t, o) {
    const host = RF.layer((o && o.host) || null);
    const el = make("div", "", "position:absolute;inset:0;background:" + ((o && o.color) || "#fff") + ";opacity:0");
    host.appendChild(el);
    tl.set(el, { opacity: (o && o.strength) || 0.55 }, t);
    tl.to(el, { opacity: 0, duration: (o && o.dur) || 0.22, ease: "power2.out" }, t);
  };

  /* Icons drawn for dark tiles. Each is an inline SVG string sized to its box. */
  RF.icons = {
    chart:
      '<svg viewBox="0 0 100 100" width="100%" height="100%"><g stroke-linecap="round"><line x1="20" y1="22" x2="20" y2="80" stroke="#ff3347" stroke-width="3"/><rect x="13" y="34" width="14" height="32" rx="2" fill="#ff3347"/><line x1="40" y1="30" x2="40" y2="86" stroke="#ff3347" stroke-width="3"/><rect x="33" y="44" width="14" height="30" rx="2" fill="#ff3347"/><line x1="60" y1="14" x2="60" y2="70" stroke="#21d07a" stroke-width="3"/><rect x="53" y="24" width="14" height="34" rx="2" fill="#21d07a"/><line x1="80" y1="8" x2="80" y2="56" stroke="#21d07a" stroke-width="3"/><rect x="73" y="16" width="14" height="28" rx="2" fill="#21d07a"/></g></svg>',
    bolt: '<svg viewBox="0 0 100 100" width="100%" height="100%"><path d="M58 6 L22 56 H46 L38 94 L78 40 H54 Z" fill="#ffc21e" stroke="#fff3b8" stroke-width="3" stroke-linejoin="round"/></svg>',
    heart: '<svg viewBox="0 0 100 100" width="100%" height="100%"><path d="M50 86 C10 58 8 30 28 20 C40 14 48 22 50 30 C52 22 60 14 72 20 C92 30 90 58 50 86 Z" fill="#ff3d6a" stroke="#ffb3c4" stroke-width="3"/></svg>',
    fire: '<svg viewBox="0 0 100 100" width="100%" height="100%"><path d="M50 94 C26 94 16 76 20 58 C24 42 36 36 34 16 C50 24 58 38 56 50 C62 46 64 38 64 32 C78 44 84 60 80 72 C76 86 64 94 50 94 Z" fill="#ff7a1a"/><path d="M50 92 C38 92 32 82 34 72 C36 62 46 58 46 48 C56 56 62 64 60 74 C64 72 66 68 66 64 C72 72 70 92 50 92 Z" fill="#ffd65a"/></svg>',
    check: '<svg viewBox="0 0 100 100" width="100%" height="100%"><circle cx="50" cy="50" r="40" fill="#1fd07a"/><path d="M30 52 L44 66 L72 36" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross: '<svg viewBox="0 0 100 100" width="100%" height="100%"><circle cx="50" cy="50" r="40" fill="#ff2639"/><path d="M34 34 L66 66 M66 34 L34 66" stroke="#fff" stroke-width="10" stroke-linecap="round"/></svg>',
    money: '<svg viewBox="0 0 100 100" width="100%" height="100%"><rect x="10" y="26" width="80" height="48" rx="8" fill="#1fd07a" stroke="#a9ffd2" stroke-width="3"/><circle cx="50" cy="50" r="14" fill="#0b7a45"/><text x="50" y="58" text-anchor="middle" font-family="Anek Bangla" font-weight="800" font-size="24" fill="#c8ffe2">৳</text></svg>',
    clock: '<svg viewBox="0 0 100 100" width="100%" height="100%"><circle cx="50" cy="50" r="40" fill="#fff" stroke="#2b8cff" stroke-width="6"/><path d="M50 26 V50 L66 60" fill="none" stroke="#111" stroke-width="7" stroke-linecap="round"/></svg>',
    play: '<svg viewBox="0 0 100 100" width="100%" height="100%"><rect x="8" y="20" width="84" height="60" rx="16" fill="#ff2639"/><path d="M42 36 V64 L66 50 Z" fill="#fff"/></svg>',
    star: '<svg viewBox="0 0 100 100" width="100%" height="100%"><path d="M50 8 L61 38 L93 38 L67 57 L77 89 L50 70 L23 89 L33 57 L7 38 L39 38 Z" fill="#ffc21e" stroke="#fff2b0" stroke-width="3" stroke-linejoin="round"/></svg>',
  };
})();
