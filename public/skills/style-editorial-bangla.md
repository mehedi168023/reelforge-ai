---
name: style-editorial-bangla
description: Editorial Bangla caption style for talking-head shorts, especially Bengali or mixed Bengali-English speech. Oversized captions in the chest zone that mix heavy Bengali with gold serif English, with size contrast between words. Use when the person picks Editorial Bangla, or for story, advice and personal-brand shorts in Bengali.
---

# Editorial Bangla

Modelled on a study of a short-form Bengali advice video. The captions are the whole design, so they must look typeset, not auto-generated. Use the style only, never another creator's footage or name.

## The look

- **Placement:** lower-centre over the chest, about 600-700 px from the bottom in portrait on a 1080x1920 canvas, always under the chin. With no speaker, place them in the clear space under the picture. The footage stays natural, with only a light darkening at the bottom for contrast.
- **Type mix:**
  - English or emphasis words: a large serif (Playfair Display 800 or EB Garamond bold), warm gold `#F5C26B`.
  - Bengali words: a heavy Bengali face (Anek Bangla 800, or Hind Siliguri 600), white. Copy the font files from `$REELFORGE_HOME/plugin/reelforge/skills/explainer-video/assets/template/assets/fonts/` into `assets/fonts/` and declare them with `@font-face`.
- **Size contrast:** in each group, one word is 2-3 times the size of the rest, and small words tuck against it, like `But` large with `তুমি` small beside it, or `তুমি` large with `যখন` small under it. Stack two or three short lines with tight leading (1.0-1.1) and no overflow.
- **Groups:** two to five words, one group at a time. A key word gets its own screen, large.

## Motion

Words appear on their spoken time, with a fast scale from 1.12 to 1 and an opacity jump in 2-3 frames, and no slide. Earlier words of the group stay until the group ends. Cut between groups with no exit animation when speech is quick. A slow punch-in from 1.0 to 1.06 on the footage across a sentence adds life, using a wrapper.

Never split Bengali into letters: conjuncts and matras break. Reveal whole words only.

## Text accuracy

The transcript will be wrong for Bengali. If there is a script, take the spelling from it. If not, correct what is obviously mis-heard using the sentence's meaning, list every word you changed or couldn't place, and ask the person to check them. Keep the speaker's own English words in English.

## Sound

Very little: a soft tick on key words at most, and a low whoosh on a big topic change.

## Mistakes to avoid

Don't give every word the same size; that is the auto-caption look this style exists to avoid. Don't use gold on more than one word per group, or it stops meaning emphasis.
