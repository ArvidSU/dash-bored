#!/bin/sh

set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_icon="$project_root/assets/icon.svg"
iconset_directory="$project_root/assets/icon.iconset"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "The macOS iconset must be generated on macOS because it uses sips." >&2
  exit 1
fi

mkdir -p "$iconset_directory"

render_icon() {
  icon_size=$1
  icon_name=$2
  sips -s format png -z "$icon_size" "$icon_size" "$source_icon" \
    --out "$iconset_directory/$icon_name" >/dev/null
}

render_icon 16 icon_16x16.png
render_icon 32 icon_16x16@2x.png
render_icon 32 icon_32x32.png
render_icon 64 icon_32x32@2x.png
render_icon 128 icon_128x128.png
render_icon 256 icon_128x128@2x.png
render_icon 256 icon_256x256.png
render_icon 512 icon_256x256@2x.png
render_icon 512 icon_512x512.png
render_icon 1024 icon_512x512@2x.png

echo "Generated $iconset_directory"
