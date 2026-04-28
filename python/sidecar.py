#!/usr/bin/env python3
# NOTE (F-7): The Rust parent terminates this sidecar via Child::kill(), which
# sends SIGKILL on Unix. The SIGTERM handler below exists only for manual
# `kill -TERM <pid>` testing. SIGKILL cannot be caught or handled — this script
# will be terminated abruptly in production; no cleanup runs on SIGKILL.
import sys
import time
import signal

signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

print("[ai-dungeon-sidecar] hello, world", flush=True)

while True:
    time.sleep(60)
