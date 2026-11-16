# Segmentor — play the type

A VJ tool for **Segmentor**, Mălin Neamțu's variable typeface (Type and Media, KABK, 2025).
Live at **https://malinneamtzu.com/segmentor/**.

Nine pads = Segmentor's nine axes (keys Q W E / A S D / Z X C, MIDI notes 60–68),
five styles (keys 1–5), type your own word, effects, camera, backgrounds,
audio input and recording. Plain HTML/CSS/JS, no build step.

## Files
- `index.html`, `style.css`, `app.js`: the tool. When you change `style.css` or `app.js`, bump the `?v=` number in `index.html` so browsers fetch the new version.
- `fonts/segmentor-0X.json`: outline data of the five styles, made from the June 2025 TTFs with
  `python scripts/segmentor_glyphs.py <folder with 20250528-Segmentor-0X.ttf>` (needs fontTools).
- `fonts/Segmentor.woff2`: the menu font.

## Publishing
GitHub Pages serves the `main` branch at malinneamtzu.com/segmentor/ (the domain comes from the
malinneamtzu.github.io repo). Every push to `main` goes live within a minute or two.

Test locally: `python3 -m http.server 8000` in this folder, then open http://localhost:8000/.

© Mălin Neamțu. The Segmentor font data is not licensed for reuse.
