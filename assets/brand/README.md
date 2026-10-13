# Pontis logo

`pontis-logo.svg` is the editable master, traced as three vector paths from the
provided P-shaped ribbon reference. It has no background or embedded bitmap.
The square view box is tightly fitted vertically for small interface icons.

`pontis-logo-dark.svg` keeps the same geometry and pale blue, with a lighter
graphite ribbon for dark interface surfaces. The favicon follows the browser's
color scheme. Chromium manifest icons are transparent PNGs at 16/32/48/128 px.

After editing the master, run `pnpm brand:generate` to update both apps' public
assets and extension icons. Run `pnpm brand:check` to detect missing or stale
copies. Both commands use the pinned SVG renderer in the root dev dependencies.

The earlier `pontis-logo-*-v*.png` files are design explorations, not runtime
assets.
