#!/usr/bin/env bash
# The real footage, as JPEG frames the film draws (30 fps, cropped to the terminal window, 1280 px wide).
# usage: bash tools/clips.sh <intro.mp4> <demo.mp4>
#   intro.mp4 = @kirtandopamine's "Introducing terminal-mac" (x.com/kirtandopamine/status/2117678349828976746)
#   demo.mp4  = @kirtandopamine's "this is a demo of claude using terminal-mac" (…/status/2117678355440914786)
# (both are in VoiceBox Files → Videos/terminal-mac). Frames go to assets/clips/ (not in git).
set -e
I="$1"; D="$2"; O=assets/clips; rm -rf $O; mkdir -p $O/a $O/b $O/c
CROP="crop=2860:1830:250:150,scale=1280:-2"
ffmpeg -v error -ss 1.3 -t 4.7 -i "$I" -vf "fps=30,$CROP" -q:v 3 $O/a/%03d.jpg          # typing terminal-mac → macOS boots in the terminal
ffmpeg -v error -ss 8.9 -t 1.8 -i "$I" -vf "fps=30,$CROP" -q:v 3 $O/b/%03d.jpg          # System Settings → About: "Apple Virtual Machine 1"
ffmpeg -v error -ss 1.6 -t 1.6 -i "$D" -vf "fps=30,$CROP" -q:v 3 $O/c/%03d.jpg          # the prompt to Claude, real time
ffmpeg -v error -ss 3.2 -t 83 -i "$D" -vf "setpts=PTS/16,fps=30,$CROP" -q:v 3 -start_number 49 $O/c/%03d.jpg   # Claude draws it, 16x
ls $O/a | wc -l; ls $O/b | wc -l; ls $O/c | wc -l; du -sh $O
