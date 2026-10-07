#!/usr/bin/env bash
# =============================================================================
# scripts/transcode.sh — SonicWave 4K HDR → Adaptive DASH/AV1+Opus
# =============================================================================
# Targets:
#   VMAF >= 93 at 1080p | SVT-AV1 encode | Opus audio | 3-rung DASH ladder
#   HDR passthrough (BT.2020/PQ preserved) | Single-pass production speed
#
# Usage:
#   ./transcode.sh INPUT.mp4 OUTPUT_DIR/
#   ./transcode.sh INPUT.mp4 OUTPUT_DIR/ --vmaf
#   ./transcode.sh --batch /source/dir /output/dir
#
# Requirements:
#   ffmpeg >= 6.1 with --enable-libsvtav1 --enable-libopus (--enable-libvmaf for --vmaf)
#   Verify: ffmpeg -encoders 2>/dev/null | grep -E "libsvtav1|libopus"
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

# ---- Tunables (change here only) ------------------------------------------

SVT_PRESET=6          # 0=slowest/best quality, 12=fastest. 6=production sweet spot
CRF_1080=28           # ~VMAF 94-96 at 1080p
CRF_720=30            # ~VMAF 92 at 720p
CRF_480=32            # ~VMAF 90 at 480p
MAXRATE_1080=6000k    # VBV ceiling prevents burst overruns on high-motion scenes
MAXRATE_720=3000k
MAXRATE_480=1200k
BUFSIZE_MULT=2        # bufsize = maxrate x this
AUDIO_BITRATE=192k    # Opus 192k = transparent for music
AUDIO_SAMPLE_RATE=48000  # Opus native sample rate
SEG_DURATION=4        # DASH segment seconds; 4s = standard ABR reaction time
KF_INTERVAL=100       # keyframes every 100 frames (4s x 25fps)

# ---- Helpers ---------------------------------------------------------------

log() { echo "[transcode] $(date +%T) $*"; }
die() { echo "[transcode] ERROR: $*" >&2; exit 1; }
require_bin() { command -v "$1" &>/dev/null || die "Required: $1"; }

# Parse FFmpeg time= lines → progress %
progress_monitor() {
  local duration_secs="$1" fifo="$2"
  while IFS= read -r line; do
    if [[ "$line" =~ time=([0-9]{2}):([0-9]{2}):([0-9]{2}\.[0-9]+) ]]; then
      local h="${BASH_REMATCH[1]}" m="${BASH_REMATCH[2]}" s="${BASH_REMATCH[3]}"
      local current; current=$(echo "$h * 3600 + $m * 60 + $s" | bc)
      local pct; pct=$(echo "scale=0; $current * 100 / $duration_secs" | bc)
      printf "\r[transcode] %s%%" "$pct"
    fi
  done < "$fifo"
  echo
}

# ---- Argument parsing ------------------------------------------------------

BATCH_MODE=0 RUN_VMAF=0 INPUT="" OUTPUT_DIR="" BATCH_SRC="" BATCH_DST=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --batch) BATCH_MODE=1; BATCH_SRC="${2:?}"; BATCH_DST="${3:?}"; shift 3 ;;
    --vmaf)  RUN_VMAF=1; shift ;;
    -*)      die "Unknown flag: $1" ;;
    *)
      if   [[ -z "$INPUT"      ]]; then INPUT="$1"
      elif [[ -z "$OUTPUT_DIR" ]]; then OUTPUT_DIR="$1"
      else die "Unexpected arg: $1"; fi
      shift ;;
  esac
done

# ---- Checks ----------------------------------------------------------------

require_bin ffmpeg; require_bin ffprobe; require_bin bc
ffmpeg -encoders 2>/dev/null | grep -q "libsvtav1" || die "ffmpeg missing --enable-libsvtav1"
ffmpeg -encoders 2>/dev/null | grep -q "libopus"   || die "ffmpeg missing --enable-libopus"

if (( BATCH_MODE )); then
  [[ -d "$BATCH_SRC" ]] || die "Source dir not found: $BATCH_SRC"
  mkdir -p "$BATCH_DST"
else
  [[ -f "$INPUT" ]] || die "Input not found: $INPUT"
  [[ -n "$OUTPUT_DIR" ]] || die "Output dir required"
  mkdir -p "$OUTPUT_DIR"
fi

# ---- Single-file transcode -------------------------------------------------

transcode_one() {
  local input="$1" outdir="$2"
  log "Probing: $input"

  local duration
  duration=$(ffprobe -v error -show_entries format=duration \
    -of default=noprint_wrappers=1:nokey=1 "$input")
  duration=${duration%.*}

  local color_transfer
  color_transfer=$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=color_transfer \
    -of default=nw=1:nk=1 "$input" 2>/dev/null || echo "unknown")

  local is_hdr=0
  [[ "$color_transfer" == "smpte2084" || "$color_transfer" == "arib-std-b67" ]] && is_hdr=1
  log "Duration: ${duration}s | HDR: $is_hdr"

  local fifo; fifo=$(mktemp -u /tmp/sw-transcode-XXXXXX.fifo)
  mkfifo "$fifo"
  progress_monitor "$duration" "$fifo" &
  local monitor_pid=$!

  # Build conditional HDR args
  local hdr_args=()
  if (( is_hdr )); then
    hdr_args=(-colorspace bt2020nc -color_primaries bt2020 -color_trc smpte2084)
  fi

  local maxrate_bufsize_1080="$(( ${MAXRATE_1080%k} * BUFSIZE_MULT ))k"
  local maxrate_bufsize_720="$(( ${MAXRATE_720%k}  * BUFSIZE_MULT ))k"
  local maxrate_bufsize_480="$(( ${MAXRATE_480%k}  * BUFSIZE_MULT ))k"

  # ------------------------------------------------------------------
  # FFmpeg — 3-rung DASH encode (annotated)
  #
  # -filter_complex: split video into 3 streams, scale each.
  #   lanczos: high-quality downscale (sharper than bilinear).
  #   force_original_aspect_ratio=decrease: letterbox safe.
  #   pad: ensure dimensions divisible by 2 (AV1 requirement).
  #
  # -crf N: Constant Rate Factor (quality target).
  #   SVT-AV1 CRF28 @ 1080p ≈ VMAF 94-96.
  #
  # -preset $SVT_PRESET: speed/quality. 6 = x264 "medium" equivalent.
  #
  # -svtav1-params:
  #   tune=0: PSNR/SSIM optimized (vs tune=1 subjective/sharpness).
  #   film-grain=8: encode grain as metadata (huge bitrate savings
  #     on cinematic/noisy content). Range 0-50.
  #   enable-overlays=1: reference frame overlay → better prediction.
  #
  # -g $KF_INTERVAL: forced keyframe every N frames.
  #   MUST equal seg_duration × fps so segments are independently
  #   decodable (critical for DASH seek/switching).
  #
  # -keyint_min $KF_INTERVAL: prevent mid-segment I-frames.
  # -sc_threshold 0: disable scene-change keyframe insertion.
  #
  # -pix_fmt yuv420p10le: 10-bit output. Required for HDR passthrough;
  #   negligible decode overhead vs 8-bit on modern GPUs.
  #
  # -map 0:a:0 libopus: single audio track.
  #   -vbr on: variable bitrate (better quality/bit than CBR).
  #   -application audio: music/speech mode (vs voip/lowdelay).
  #   -compression_level 10: max encoder effort.
  #
  # -af aresample=async=1000: correct A/V sync drift ≤1000 samples
  #   by resampling audio. Prevents desync in long files.
  #
  # -vsync vfr: variable frame rate. Never drop/duplicate frames.
  #   Correct for VOD where source fps may vary.
  #
  # -fflags +genpts: regenerate PTS if missing (broken HDR sources).
  #
  # -f dash: MPEG-DASH muxer. Writes MPD + .m4s segments.
  # -seg_duration: segment length. 4s = standard ABR adaptation.
  # -use_timeline 1: list segment durations explicitly (broad compat).
  # -use_template 1: $Number$ URLs (CDN cache-key friendly).
  # -adaptation_sets: separate A/V sets — player picks quality independently.
  # -init_seg_name / -media_seg_name: predictable CDN cache keys.
  # -dash_segment_type mp4: fMP4 segments (best Safari/Edge compat).
  # ------------------------------------------------------------------

  ffmpeg \
    -hide_banner -loglevel warning -stats \
    -fflags +genpts \
    -i "$input" \
    -filter_complex "
      [0:v]split=3[v1][v2][v3];
      [v1]scale=1920:1080:flags=lanczos,
              force_original_aspect_ratio=decrease,
              pad=1920:1080:(ow-iw)/2:(oh-ih)/2[v1080];
      [v2]scale=1280:720:flags=lanczos,
              force_original_aspect_ratio=decrease,
              pad=1280:720:(ow-iw)/2:(oh-ih)/2[v720];
      [v3]scale=854:480:flags=lanczos,
              force_original_aspect_ratio=decrease,
              pad=854:480:(ow-iw)/2:(oh-ih)/2[v480]
    " \
    -map "[v1080]" -c:v:0 libsvtav1 \
      -crf "$CRF_1080" -maxrate "$MAXRATE_1080" -bufsize "$maxrate_bufsize_1080" \
      -preset "$SVT_PRESET" \
      -svtav1-params "tune=0:film-grain=8:enable-overlays=1" \
      -g "$KF_INTERVAL" -keyint_min "$KF_INTERVAL" -sc_threshold 0 \
      -pix_fmt yuv420p10le "${hdr_args[@]}" \
    -map "[v720]"  -c:v:1 libsvtav1 \
      -crf "$CRF_720"  -maxrate "$MAXRATE_720"  -bufsize "$maxrate_bufsize_720" \
      -preset "$SVT_PRESET" \
      -svtav1-params "tune=0:film-grain=8:enable-overlays=1" \
      -g "$KF_INTERVAL" -keyint_min "$KF_INTERVAL" -sc_threshold 0 \
      -pix_fmt yuv420p10le "${hdr_args[@]}" \
    -map "[v480]"  -c:v:2 libsvtav1 \
      -crf "$CRF_480"  -maxrate "$MAXRATE_480"  -bufsize "$maxrate_bufsize_480" \
      -preset "$SVT_PRESET" \
      -svtav1-params "tune=0:film-grain=8" \
      -g "$KF_INTERVAL" -keyint_min "$KF_INTERVAL" -sc_threshold 0 \
      -pix_fmt yuv420p10le \
    -map 0:a:0 -c:a:0 libopus \
      -b:a "$AUDIO_BITRATE" -ar "$AUDIO_SAMPLE_RATE" \
      -vbr on -application audio -compression_level 10 \
      -af "aresample=async=1000" \
    -vsync vfr \
    -f dash \
    -seg_duration "$SEG_DURATION" \
    -use_timeline 1 -use_template 1 \
    -adaptation_sets "id=0,streams=v id=1,streams=a" \
    -init_seg_name 'init_$RepresentationID$.mp4' \
    -media_seg_name 'seg_$RepresentationID$_$Number%05d$.m4s' \
    -dash_segment_type mp4 \
    "${outdir}/manifest.mpd" \
    2>"$fifo"

  local rc=$?
  kill "$monitor_pid" 2>/dev/null || true
  rm -f "$fifo"
  (( rc == 0 )) || die "FFmpeg failed ($rc) on: $input"
  log "Done: ${outdir}/manifest.mpd"

  (( RUN_VMAF )) && verify_vmaf "$input" "$outdir"
}

# ---- VMAF verification (1080p rung) ----------------------------------------

verify_vmaf() {
  local ref="$1" outdir="$2"
  log "Running VMAF (1080p)..."
  ffmpeg -encoders 2>/dev/null | grep -q "libvmaf" || { log "WARN: libvmaf not built in — skip"; return; }

  local concat; concat=$(mktemp /tmp/sw-vmaf-XXXXXX.txt)
  find "$outdir" -name "seg_0_*.m4s" | sort > "$concat"
  local vmaf_log="${outdir}/vmaf.json"

  ffmpeg -hide_banner -loglevel error \
    -i "$ref" \
    -f concat -safe 0 -i "$concat" \
    -filter_complex "[0:v]scale=1920:1080:flags=lanczos[ref];[1:v][ref]libvmaf=log_path=${vmaf_log}:log_fmt=json:n_threads=4" \
    -f null - 2>/dev/null

  local score
  score=$(python3 -c "
import json
with open('${vmaf_log}') as f: d=json.load(f)
print(d['pooled_metrics']['vmaf']['mean'])
" 2>/dev/null || echo "N/A")

  log "VMAF score (1080p): $score"
  if [[ "$score" != "N/A" ]]; then
    local si=${score%.*}
    (( si >= 93 )) || log "WARN: VMAF $score < 93 — lower CRF_1080 or increase MAXRATE_1080"
  fi
  rm -f "$concat"
}

# ---- Batch mode ------------------------------------------------------------

batch_transcode() {
  local src="$1" dst="$2"
  local -a inputs
  mapfile -t inputs < <(find "$src" -maxdepth 2 -type f \
    \( -iname "*.mp4" -o -iname "*.mov" -o -iname "*.mkv" \
       -o -iname "*.webm" -o -iname "*.mxf" \) | sort)
  local total=${#inputs[@]}
  (( total > 0 )) || die "No video files in: $src"
  log "Batch: $total files"
  local i=1
  for f in "${inputs[@]}"; do
    local name; name=$(basename "${f%.*}")
    local outdir="${dst}/${name}"
    mkdir -p "$outdir"
    log "[$i/$total] $f"
    transcode_one "$f" "$outdir"
    (( i++ ))
  done
  log "Batch complete → $dst"
}

# ---- Entry -----------------------------------------------------------------

if (( BATCH_MODE )); then batch_transcode "$BATCH_SRC" "$BATCH_DST"
else transcode_one "$INPUT" "$OUTPUT_DIR"
fi
