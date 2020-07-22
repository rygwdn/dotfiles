#!/bin/bash

set -e

# FROM https://stackoverflow.com/questions/29082422/ffmpeg-video-compression-specific-file-size


origin_video="$1"
target_video_size_MB="$2"

[[ ! -f "${origin_video}" ]] && echo "file does not exist" 1>&2 && exit 1
[[ -z "${target_video_size_MB}" ]] && echo "requires target size in mb" 1>&2 && exit 1

read -p "will re-encode ${origin_video} to approx ${target_video_size_MB}Mb. Press Enter"

set -x

#ffprobe -v error -show_streams -select_streams a "$origin_video" | grep -Po "(?<=^duration\=)\d*\.\d*"
#ffprobe -v error -pretty -show_streams -select_streams a "$origin_video"

origin_duration_s=$(ffprobe -v error -show_streams -select_streams a "$origin_video" | grep -Po "(?<=^duration\=)\d*\.\d*")
origin_audio_bitrate_kbit_s=$(ffprobe -v error -pretty -show_streams -select_streams a "$origin_video" | grep -Po "(?<=^bit_rate\=)[\d.]+")
target_audio_bitrate_kbit_s=$origin_audio_bitrate_kbit_s # TODO for now, make audio bitrate the same
target_video_bitrate_kbit_s=$(\
    awk \
    -v size="$target_video_size_MB" \
    -v duration="$origin_duration_s" \
    -v audio_rate="$target_audio_bitrate_kbit_s" \
    'BEGIN { print  ( ( size * 8192.0 ) / ( 1.048576 * duration ) - audio_rate ) }')

echo "---------------- Pass 1 - Analyze -------------"
ffmpeg \
    -y \
    -i "$origin_video" \
    -c:v libx264 \
    -b:v "$target_video_bitrate_kbit_s"k \
    -pass 1 \
    -an \
    -f mp4 \
    /dev/null \
&& echo "---------------- Pass 2 - Encode -------------" \
&& ffmpeg \
    -i "$origin_video" \
    -c:v libx264 \
    -b:v "$target_video_bitrate_kbit_s"k \
    -pass 2 \
    -c:a aac \
    -b:a "$target_audio_bitrate_kbit_s"k \
    "${origin_video%.*}-${target_video_size_MB}mB.mp4"
