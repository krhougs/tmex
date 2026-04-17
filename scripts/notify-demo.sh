#!/bin/sh
set -eu

sleep_s="${1:-1}"

say() {
  printf '\n==> %s\n' "$1"
}

pause() {
  sleep "$sleep_s"
}

say "1) 普通 BEL"
printf '\a'
pause

say "2) OSC 9"
printf '\033]9;tmex osc9 test\a'
pause

say "3) OSC 777"
printf '\033]777;notify;Build finished;All tests passed\a'
pause

say "4) OSC 1337"
printf '\033]1337;RequestAttention=yes\a'
pause

say "done"
