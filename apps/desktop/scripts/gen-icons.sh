#!/usr/bin/env bash
# Generate all app icons from build/icons/src/*.svg (owner-provided).
# Requires: rsvg-convert (brew install librsvg); iconutil (macOS) for .icns.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=build/icons/src
OUT=build/icons
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- macOS: Apple-style icon = artwork at 80.5% of canvas, squircle-ish mask, transparent margins.
cp "$SRC/icon_macos.svg" "$TMP/artwork.svg"   # librsvg only loads external files next to the input
cat > "$TMP/mac.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <clipPath id="sq"><rect x="100" y="100" width="824" height="824" rx="185" ry="185"/></clipPath>
    <filter id="sh" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.28"/>
    </filter>
  </defs>
  <g clip-path="url(#sq)" filter="url(#sh)">
    <image x="100" y="100" width="824" height="824" xlink:href="artwork.svg"/>
  </g>
</svg>
SVG
mkdir -p "$OUT/mac" "$TMP/icon.iconset"
for s in 16 32 64 128 256 512 1024; do
  rsvg-convert -w $s -h $s "$TMP/mac.svg" -o "$TMP/mac-$s.png"
done
cp "$TMP/mac-16.png"   "$TMP/icon.iconset/icon_16x16.png"
cp "$TMP/mac-32.png"   "$TMP/icon.iconset/icon_16x16@2x.png"
cp "$TMP/mac-32.png"   "$TMP/icon.iconset/icon_32x32.png"
cp "$TMP/mac-64.png"   "$TMP/icon.iconset/icon_32x32@2x.png"
cp "$TMP/mac-128.png"  "$TMP/icon.iconset/icon_128x128.png"
cp "$TMP/mac-256.png"  "$TMP/icon.iconset/icon_128x128@2x.png"
cp "$TMP/mac-256.png"  "$TMP/icon.iconset/icon_256x256.png"
cp "$TMP/mac-512.png"  "$TMP/icon.iconset/icon_256x256@2x.png"
cp "$TMP/mac-512.png"  "$TMP/icon.iconset/icon_512x512.png"
cp "$TMP/mac-1024.png" "$TMP/icon.iconset/icon_512x512@2x.png"
if command -v iconutil >/dev/null; then iconutil -c icns "$TMP/icon.iconset" -o "$OUT/mac/icon.icns"; fi
cp "$TMP/mac-1024.png" "$OUT/mac/icon.png"

# --- Windows / Linux: rounded square, full bleed (electron-builder converts png -> ico).
mkdir -p "$OUT/win" "$OUT/linux"
rsvg-convert -w 1024 -h 1024 "$SRC/icon_other.svg" -o "$OUT/win/icon.png"
for s in 16 32 48 64 128 256 512; do
  rsvg-convert -w $s -h $s "$SRC/icon_other.svg" -o "$OUT/linux/${s}x${s}.png"
done

# --- Tray: macOS template (black glyph, alpha only), others: color glyph.
mkdir -p "$OUT/tray"
sed 's/fill="[^"]*"/fill="#000000"/g; s/stroke="[^"]*"/stroke="#000000"/g' "$SRC/fav.svg" > "$TMP/tray-template.svg"
rsvg-convert -w 16 -h 16 "$TMP/tray-template.svg" -o "$OUT/tray/trayTemplate.png"
rsvg-convert -w 32 -h 32 "$TMP/tray-template.svg" -o "$OUT/tray/trayTemplate@2x.png"
rsvg-convert -w 16 -h 16 "$SRC/icon_other.svg" -o "$OUT/tray/tray.png"
rsvg-convert -w 32 -h 32 "$SRC/icon_other.svg" -o "$OUT/tray/tray@2x.png"
rsvg-convert -w 64 -h 64 "$SRC/icon_other.svg" -o "$OUT/tray/tray@4x.png"

# --- Tray, Windows monochrome (setting «Монохромная иконка в трее», CBF-171): the same glyph in
# white (dark taskbar) and black (light taskbar); 16/20/24/32/48 px = 100/125/150/200/300 % DPI.
for c in White:#ffffff Black:#000000; do
  name=${c%%:*}; hex=${c#*:}
  sed "s/fill=\"[^\"]*\"/fill=\"$hex\"/g; s/stroke=\"[^\"]*\"/stroke=\"$hex\"/g" "$SRC/fav.svg" > "$TMP/tray-mono.svg"
  for e in 16: 20:@1.25x 24:@1.5x 32:@2x 48:@3x; do
    rsvg-convert -w "${e%%:*}" -h "${e%%:*}" "$TMP/tray-mono.svg" -o "$OUT/tray/trayMono$name${e#*:}.png"
  done
done

# --- Web: favicon + touch icons.
mkdir -p "$OUT/web"
cp "$SRC/fav.svg" "$OUT/web/favicon.svg"
rsvg-convert -w 32 -h 32   "$SRC/fav.svg"        -o "$OUT/web/favicon-32.png"
rsvg-convert -w 180 -h 180 "$SRC/icon_other.svg" -o "$OUT/web/apple-touch-icon.png"
rsvg-convert -w 192 -h 192 "$SRC/icon_other.svg" -o "$OUT/web/icon-192.png"
rsvg-convert -w 512 -h 512 "$SRC/icon_other.svg" -o "$OUT/web/icon-512.png"

echo "icons generated in $OUT"
