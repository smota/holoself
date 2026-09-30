#!/usr/bin/env bash
# D01 synthetic cgroup feasibility probe only; not a product supervisor.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
node="${D01_NODE:?Set D01_NODE to an absolute Node 20 executable}"
mode="${1:-worker}"
fixture="${2:-sample.md}"
if [[ "$mode" == inside ]]; then
  cg="$(cut -d: -f3 /proc/self/cgroup)"
  limit="$(cat "/sys/fs/cgroup${cg}/memory.max")"
  swap="$(cat "/sys/fs/cgroup${cg}/memory.swap.max")"
  printf 'verified_memory_max=%s verified_swap_max=%s\n' "$limit" "$swap"
  [[ "$limit" == 536870912 && "$swap" == 0 ]] || exit 88
  cd "$repo"
  "$node" scripts/evidence-spike.mjs --worker "$fixture" pdfjs4
  printf 'memory_peak_bytes=%s\n' "$(cat "/sys/fs/cgroup${cg}/memory.peak")"
  exit
fi
if [[ "$mode" == inside-descendant ]]; then
  printf 'probe_started=true\n'
  sleep 30 & child=$!
  start="$(awk '{print $22}' "/proc/$child/stat")"
  printf 'descendant_pid=%s descendant_start=%s\n' "$child" "$start"
  sleep 30
fi
if [[ "$mode" == inside-timeout ]]; then printf 'probe_started=true\n'; sleep 30; fi
[[ "$mode" == worker || "$mode" == descendant || "$mode" == timeout ]] || { echo 'unsupported mode' >&2; exit 2; }
unit="holoself-d01-$$-$(date +%s%N)"
if [[ "$mode" == worker ]]; then
  systemd-run --user --wait --collect --pipe --unit="$unit" \
    -p MemoryMax=536870912 -p MemorySwapMax=0 -p RuntimeMaxSec=60s \
    -E "D01_NODE=$node" /bin/bash "$repo/scripts/evidence-supervisor-linux.sh" inside "$fixture"
else
  start_ns="$(date +%s%N)"
  set +e
  output="$(systemd-run --user --wait --collect --pipe --unit="$unit" \
    -p MemoryMax=536870912 -p MemorySwapMax=0 -p RuntimeMaxSec=1s \
    -E "D01_NODE=$node" /bin/bash "$repo/scripts/evidence-supervisor-linux.sh" "inside-$mode" 2>&1)"
  status=$?
  set -e
  elapsed_ms=$(( ($(date +%s%N) - start_ns) / 1000000 ))
  printf '%s\nprobe_mode=%s status=%s outer_elapsed_ms=%s\n' "$output" "$mode" "$status" "$elapsed_ms"
  [[ $status -ne 0 ]] || exit 89
  [[ "$output" == *'probe_started=true'* && "$output" == *'Finished with result: timeout'* && "$output" == *'code=killed'* ]] || exit 92
  if [[ "$mode" == descendant ]]; then
    pid="$(sed -n 's/.*descendant_pid=\([0-9]*\).*/\1/p' <<< "$output" | head -1)"
    start="$(sed -n 's/.*descendant_start=\([0-9]*\).*/\1/p' <<< "$output" | head -1)"
    [[ -n "$pid" && -n "$start" ]] || exit 90
    current="$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)"
    printf 'descendant_same_identity_after_unit=%s\n' "$([[ "$current" == "$start" ]] && echo true || echo false)"
    [[ "$current" != "$start" ]] || exit 91
  fi
fi
