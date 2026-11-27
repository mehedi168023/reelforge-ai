# Edit a video

Two stages, in this order. Stage 1 ends your turn, unless the person turned on Autopilot.

## Stage 1: go through the video and report
1. `media_info` for length, size and sound.
2. `video_frames` across the whole clip, at most 12 per call: about one frame every 2-3 s. Note where the face sits, black bars, burned-in text, framing and lighting.
3. `transcribe` for word timings if a voice provider is set up. If a script was given, use its spelling and keep the transcript's timing. Without it, say captions will be estimated.
4. State who it is for and what the viewer should do or know by the end.
5. Report, then stop, with the headings in the person's language:

```
## What this video is
## What can be improved (at most 10, highest impact first; each: t=12.4s problem -> exact fix)
## What I'll do (style, captions, motion and icons, sound, with moments)
## Please check (wrong words, claims you can't verify)
```

## Stage 2: edit
- Set `footage` in `project.json`, with the page background transparent. Match the source's shape; use a 1080-wide or 1080-tall canvas if it's smaller, and tell the person it will look soft. Set `duration` to the clip's length from `media_info`, never longer.
- Keep text and overlays off the face. Check each against a frame at its own time, since heads move. Portrait default: chest zone, about 600-700 px from the bottom of a 1080x1920 canvas. With no speaker, or black bars, recompose and say so.
- Each overlay needs a reason in the words at that moment, and lands on the word. About one every 6-8 s under a minute, leaving stretches to the speaker.
- Cuts aren't possible in the browser version. Punch-ins, pushes and shakes are, through `camera` in `project.json`, and a colour grade through `grade`. Use them together with captions and overlays (see `style-neon-reels`). Aim zooms at the face and check them with `snapshot`.
- If the source has a music bed, keep it and add fewer effects. A style that asks for less sound wins.
- Rendering footage is much slower than graphics, since each frame is decoded. Warn about the wait for clips over 30 s.
- Snapshot every overlay moment, render, then check `video_frames` from the finished file.
