# Making a film

Learned on a real 90-second film, including its mistakes.

## Before planning
- Compare any website or app screen with the script. List amounts, offers or conditions you can't find, or that conflict. Don't change a script's claim yourself; flag it.
- Don't put real player names, IDs or live referral codes on screen.

## Plan beat by beat
Write the plan in your message: one row per spoken phrase with time, exact on-screen words, what the icon does, and the sound.

- **The icon acts out the sentence.** Give it a job, not a place beside text. A wallet opens and coins try to escape, then "no worries" sends them home. A ticket's price is struck out and the torn stub reads zero. Ask "what would this line look like as a tiny silent film?"
- **Vary the shapes:** a number landing, before and after, one chosen from many, a diagram that grows, a machine running. Three equal cards and bullet lists read as slides.
- **Change the world with the subject:** tint the ground gold for money, purple for invites, green for free, red for alerts. Use flat colours or a simple static gradient.
- **Keep text true to the script.** Keep every qualifier, match the script's pronoun (আপনি vs তুমি), and show short phrases rather than full subtitles.
- Scenes run up to about 13 s with several reveals, and start at a real pause.

## Kit (assets/kit.js)
| Call | Use |
|---|---|
| `FF.blurWords`, `riseWords`, `greyWords`, `slam` | Title entrances; vary them through the film (none uses blur here) |
| `FF.pop`, `FF.out` | Element in, element out |
| `FF.shake(tl, "#wrap", t, px)` | Three-frame impact, on a wrapper nothing else moves; it resets x and y to 0 |
| `FF.whipIn`, `whipOut`, `zoomIn`, `zoomOut` | Scene entrance and exit on a stage wrapper |
| `FF.ring(tl, "#fx", t, {x,y,r,color})`, `FF.burst(tl, "#fx", t, {x,y,n,kind,r,seed})` | Shockwave; particles of kind `spark`, `coin` or `confetti`. Keep `n` under 30 |
| `FF.count(tl, sel, t, from, to, dur, prefix)`, `FF.bn(n)` | Count-up, Bengali digits |
| `FF.raysSvg(size,count,color)`, `FF.coinSvg(size)` | Rays, taka coin |

Draw icons as inline SVG with one group per moving part, and rotate parts with `svgOrigin`.

## Mistakes that have already cost time
- Hidden start positions must really leave the frame: a rotated or scaled object 800 px away still peeked in.
- Have the headline on screen at frame 0, since it's the thumbnail on social players.
- Avoid dead air: on a long phrase, keep something working (a spinning coin, gears, a filling bar) and pay it off on the key word.
- X marks read as "wrong". Use a crown, tick or swords for neutral or positive items.
- Key text stays inside the middle 80% of the frame. Check for text colliding with other elements.
- Keep Latin text in a font that has it (`sans-serif` is fine); the Bengali files have no Latin glyphs.

## Sound
Every effect needs a cause on screen: whoosh on cuts and big moves, coin on money, pop on badges, impact only on big moments, the riser at most once. Keep most at volume 0.2-0.4 and impacts at 0.35-0.45, because the voice comes first. A peak inside a file lands slightly after its start: pop 0.12 s, whoosh 0.16 s, impact 0.14 s, coin 0.04 s, ping 0.32 s.

## Before rendering
Snapshot every scene's start, middle and hero moment. Read each frame as a stranger would: is any text cut off, colliding, or too small? Then render, and look at `video_frames` from the finished file.
