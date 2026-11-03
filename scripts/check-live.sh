#!/usr/bin/env bash
# Verify link-preview tags and the preview video on a deployed URL.
# Usage: scripts/check-live.sh https://libreng-tubig.vercel.app
set -u
URL="${1:?usage: check-live.sh <url>}"
URL="${URL%/}"
MAX=$((5 * 1024 * 1024))
fail=0
bad() { echo "FAIL: $*"; fail=1; }

# Flatten to one line so tags spanning several lines still match.
html="$(curl -fsSL "$URL/" | tr '\n\r\t' '   ')" || { echo "FAIL: cannot fetch $URL/"; exit 1; }

for key in og:video og:video:secure_url og:video:type og:video:width og:video:height og:image og:title og:description \
           twitter:card twitter:player twitter:player:width twitter:player:height; do
  if ! printf '%s' "$html" | grep -Eqi "<meta[^>]*(property|name)[[:space:]]*=[[:space:]]*\"$key\"[^>]*>"; then
    bad "missing meta $key"
  fi
done
printf '%s' "$html" | grep -Eqi "name[[:space:]]*=[[:space:]]*\"twitter:card\"[^>]*content[[:space:]]*=[[:space:]]*\"player\"|content[[:space:]]*=[[:space:]]*\"player\"[^>]*name[[:space:]]*=[[:space:]]*\"twitter:card\"" || bad "twitter:card is not player"
for key in og:video og:video:secure_url twitter:player og:image; do
  val="$(printf '%s' "$html" | grep -Eoi "<meta[^>]*\"$key\"[^>]*>" | head -1 | grep -Eoi "content[[:space:]]*=[[:space:]]*\"[^\"]*\"" | sed -E 's/^[^"]*"//; s/"$//')"
  case "$val" in https://*) ;; *) bad "$key is not an absolute https URL ($val)";; esac
done

video="$(printf '%s' "$html" | grep -Eoi "<meta[^>]*\"og:video\"[^>]*>" | head -1 | grep -Eoi "content[[:space:]]*=[[:space:]]*\"[^\"]*\"" | sed -E 's/^[^"]*"//; s/"$//')"
video="${video:-$URL/og/preview.mp4}"
hdr="$(curl -fsSIL "$video")" || bad "cannot HEAD $video"
status="$(printf '%s' "$hdr" | grep -E '^HTTP' | tail -1 | awk '{print $2}')"
ctype="$(printf '%s' "$hdr" | grep -i '^content-type:' | tail -1 | tr -d '\r' | awk '{print tolower($2)}')"
size="$(curl -fsSL "$video" | wc -c | tr -d ' ')"
[ "$status" = "200" ] || bad "video status $status"
case "$ctype" in video/mp4*) ;; *) bad "video content-type '$ctype'";; esac
[ "$size" -gt 0 ] && [ "$size" -lt "$MAX" ] || bad "video size $size bytes (need 0 < size < $MAX)"

player="$(curl -s -o /dev/null -w '%{http_code}' "$URL/og/player.html")"
[ "$player" = "200" ] || bad "player.html status $player"

if [ "$fail" -eq 0 ]; then echo "OK: tags present, $video is $ctype, $size bytes"; else exit 1; fi
