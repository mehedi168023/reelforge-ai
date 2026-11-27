---
name: style-neon-reels
description: Neon Reels editing style for talking-head reels and shorts, especially Bangla. Glowing neon captions, glossy glass cards, karaoke boxes, emoji rain, stickers and icon tiles over a cool cinematic grade with punch-in zooms. Use when the person picks Neon Reels, sends a reel to be edited "high level", or asks for the glowing-caption reel look.
---

# Neon Reels

Modelled on a study of high-end Bangla reel edits: a speaker to camera, a cool, contrasty grade, and a caption treatment that changes with every phrase. The energy comes from three things working together: the **camera** (punch-ins on emphasis), the **caption** (glowing, landing word by word), and a **reaction** (emoji, sticker or icon) on the feeling word. Use the style only, never another creator's footage, name, handle or text.

Load `examples/neon-reels` for a complete worked page and its `project.json`.

## Setup

- `project.json`: `footage` is the person's clip; `width`/`height` match it (1080x1920 for vertical). The page background is transparent.
- Load the kit: `<script src="assets/gsap.min.js"></script><script src="assets/reels.js"></script>` plus the Anek Bangla `@font-face` from the skeleton. `assets/kit.js` can be loaded too, for `FF.shake` or `FF.burst`.
- Add a static dark gradient over the lower 60% of the page (see the example's `#floor`), so neon reads on snow, sky or a white wall.
- Captions need word timings. Run `transcribe` and place every word on its `start`. Without it, say the timing is estimated.

## The grade (project.json `grade`)

The look is cool and contrasty, with skin still natural. Start from:

```json
"grade": {"brightness": 0.94, "contrast": 1.16, "saturation": 0.88, "tint": "#2a5cff", "tintAmount": 0.12, "vignette": 0.5}
```

Check it with `snapshot` against a source frame from `video_frames`. For warm indoor footage use `tint` `#ff8a3d` at 0.08 instead. Dark footage: raise `brightness` to 1.0-1.05 and lower `contrast` to 1.08. Never push saturation above 1.1, because skin turns orange. The grade affects only the footage, not the captions.

## The camera (project.json `camera`)

Keys apply in time order: `{"t", "zoom", "x", "y", "ease", "dur"}`. `x` and `y` are the point to centre on (0-1, default 0.5). `ease` is `"cut"` (jumps at t), `"smooth"` (eases over `dur`, default 0.45 s) or `"push"` (even drift over `dur`). `{"t": 3.4, "shake": 14}` adds a three-frame jolt in pixels.

- **Punch-in on emphasis:** a `cut` to 1.15-1.25 on the key word, then a `cut` back to 1 on the next phrase. Aim `y` at the face (about 0.35-0.42 on a vertical talking head) so the head never leaves the frame. Check with `snapshot`.
- **Open on movement:** start at 1.12 and ease to 1 over 0.6 s, so the first frame is already moving.
- **Slow push** of 1 to 1.1 over 3-4 s under a long sentence keeps it alive.
- **Shake** only on an impact word (pain, shock, a number). At most once in 8 s.
- Change the zoom every 2-4 s. Don't zoom past 1.3, because the footage softens.

## Caption treatments (assets/reels.js)

Every helper takes the timeline and an options object, with times in seconds and positions in pixels. Rotate treatments: never use the same one three phrases in a row.

| Call | When | Notes |
|---|---|---|
| `RF.neonText(tl, {t, end, y, lines:[{text, color:'red', times}, {text, at}]})` | The default for any spoken phrase | A neon line (red by default) over a white line. Put the key part of the phrase in the neon line and the rest in white. `times` = each word's start. |
| `RF.glassCard(tl, {t, end, text, color, y, from})` | Hook, claims, questions, offers | Glossy pill sliding in. Gold for the hook, purple for a turn ("কিন্তু"), red for a warning, blue for a tip. Alternate `from: 'left'`/`'right'`. Two cards can stack (a small `?` card with `size: 90`). |
| `RF.dashBox(tl, {t, end, text, times, color})` | A sentence said slowly, a list, an instruction | Dashed outline; each word fills karaoke-style on its time. |
| `RF.wordPop(tl, {t, end, text, times, accent:[i], color:'blue', y})` | English phrases, punchlines, wide shots | Word by word, upper third (`y` about 0.2 of the height). The accent word glows. |
| `RF.emojiRain(tl, {t, dur, emoji:['💀'], n, seed, top})` | On a feeling word: 💀 pain, 🥶 cold, 🥵 hard work, 😂 joke, 🔥 hype, 😱 shock | 8-14 emoji. Set `top` (about 0.68) so they stay under the caption. Change `seed` each time. `mode: 'burst', x, y` bursts from a point instead. |
| `RF.sticker(tl, {t, end, emoji, y})` | A single feeling, or an object named | A white tile that pops in and wiggles. Place it under the caption, off the face. `svg:` takes an icon instead. |
| `RF.iconTile(tl, {t, end, svg: RF.icons.chart, color})` | A topic noun: money, trading, time, video, success | Dark glass with a glowing edge. Icons: chart, bolt, heart, fire, check, cross, money, clock, play, star. Draw your own SVG for anything else. |
| `RF.lightLeak(tl, {t, dur, color, side})`, `RF.streak(tl, {t, y, color})` | With a glass card, or on a scene change | Leak from the side the card enters from; streak on the moment it lands. |
| `RF.flash(tl, t)` | A hard topic change | Pair it with a camera `cut`. |

### Rhythm (match it)

- A caption lands on the **first word of its phrase**, never before the speaker says it. Each word lands on its own `start` from words.json.
- A caption stays up until the phrase ends (+0.1 s) or the next one starts, so the screen is never empty while someone talks.
- One **reaction** (emoji, sticker or icon) every 4-6 s, on the most emotional word, not on every line.
- About one **glass card** per 8-10 s. It's the loudest treatment; it loses its effect if every line is a card.
- First frame: a glass card or a neon line already on screen, because it's the thumbnail.

### Placement

- Vertical 1080x1920: captions at 58-66% of the height (chest level), cards at 38-46%, English pops at about 20%. Keep the face clear. Check with `snapshot` at each caption's time, since heads move.
- Keep text inside the middle 84% of the width. Split a line over about 18 Bengali characters into a neon line and a white line.
- Bengali stays whole words; the kit splits only on spaces. English uses the kit's Latin font automatically.

## Sound

Every graphic needs a sound with a cause on screen. These are the defaults:

- whoosh 0.3-0.35 on a card entering, and whoosh-low on a camera cut
- impact-light 0.35 on a shake
- glitch-1 0.25-0.3 on the neon flicker of a pain line
- pop or pop-high 0.35 on stickers and icon tiles
- sparkle 0.25 on emoji rain
- ping 0.25 on a karaoke box
- riser at most once, before the payoff

The speaker's voice comes first. If the clip has music, drop all effects to 0.2.

## Before rendering

Snapshot every caption's entry and middle, and every camera cut. Read each frame as a stranger would:
- Is the face clear?
- Does any text collide with an emoji?
- Is the neon readable against the background?
- Is the zoom not too soft?

After `render`, check `video_frames` from the MP4.

## Mistakes to avoid

- Don't caption every word as a full subtitle. Short phrases read faster and look edited.
- Avoid two treatments at once in the same zone. The one exception is a card plus its `?` badge.
- Don't put neon red on a red or orange background. Switch that line to purple or blue.
- Avoid CSS `filter`, blur or `backdrop-filter`; the kit's glow is already built to render fast.
