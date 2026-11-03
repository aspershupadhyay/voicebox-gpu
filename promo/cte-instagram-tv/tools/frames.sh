#!/bin/sh
# The Reel that plays on the TV is our own (Catch the Error: Cyclon, Files -> Videos/Cyclon).
# usage: sh tools/frames.sh <cyclon.mp4>   -> assets/reel/NNN.jpg (0-14 s at 30 fps) and assets/thumb/tN.jpg
set -e; mkdir -p assets/reel assets/thumb
ffmpeg -v error -y -ss 0 -t 14 -i "$1" -vf "fps=30,scale=432:768" -q:v 4 assets/reel/%03d.jpg
for t in 4 9 14 20 24 33 37 44 50 56; do ffmpeg -v error -y -ss $t -i "$1" -frames:v 1 -vf scale=270:480 -q:v 4 assets/thumb/t$t.jpg; done
