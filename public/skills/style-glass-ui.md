---
name: style-glass-ui
description: Glass UI editing style for premium talking-head shorts, agency, business, SaaS and hiring content. Heavy two-tone italic titles over the chest, plus small glass interface popups that act out what is said, such as star ratings, stat cards and dials. Use when the person picks Glass UI, or wants a modern, premium, product-UI feel.
---

# Glass UI

Modelled on a study of a short-form talking-head edit with interface-style overlays. It looks like a product's own interface reacting to the speaker. Use the style only, never another creator's footage, name or a company's logo.

## The look

- **Footage:** a dark, cool grade with a soft vignette, and darkness rising from the bottom so overlays read. Draw it as a page layer over the footage: a dark translucent wash and a gradient rising from the bottom. No CSS filters.
- **Titles:** two lines over the chest, heavy wide italic caps (Montserrat 900 italic or Archivo Black skewed about -8 degrees). Line one is white, line two is the accent, usually electric blue with a thin outline or soft glow: `WELL IT / DEPENDS`. Use two to four words only, on key phrases, not on every sentence.
- **Glass popups**, each with rounded corners, a light 1 px edge and a dark translucent base. Put them over the chest, with the face clear:
  - rating pill: five stars filling one by one, with a gold outcome badge at the end ("Best");
  - stat cards: three small thumbnails with bold numbers over them, the middle one larger (`1.2M / 1M / 2M`);
  - side dial: a ring entering from the frame edge, an accent bar, a light title and a small subtitle (`THE TASK / any specific task...`);
  - notification, slider, toggle and progress bar as the words call for them.
- **Captions:** none besides titles and popups, unless asked.

Numbers and labels must come from what's said or supplied. Never invent a metric to fill a card.

## Motion

Popups arrive with a soft spring (`back.out(1.4)`) over 0.35-0.5 s, then act: stars fill 0.08 s apart, numbers count, dials turn. They leave in half that time. Titles land with a quick scale from 1.15 and a blur from 8 px to 0, then hold dead still. One element at a time; let the speaker have the frame for a few seconds between them.

## Sound

Soft UI click on each star or toggle, a gentle pop on arrival, a short whoosh on a large title. Keep them quiet and crisp.

## Mistakes to avoid

Glass over bright footage goes white on white, so put a scrim behind it. Don't stack two popups. Don't cover the hands if they are gesturing at the popup, because that gesture sells it: place the popup between them.
