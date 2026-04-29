#!/usr/bin/env python3
# NOTE (F-7): The Rust parent terminates this sidecar via Child::kill(), which
# sends SIGKILL on Unix. The SIGTERM handler below exists only for manual
# `kill -TERM <pid>` testing. SIGKILL cannot be caught or handled — this script
# will be terminated abruptly in production; no cleanup runs on SIGKILL.
#
# Wire protocol (line-delimited JSON, both directions):
#   Request  (parent → sidecar, via stdin):  {"id": "<string>", "msg": "<string>"}
#   Response (sidecar → parent, via stdout): {"id": "<string>", "reply": "<string>"}
#
# Each request must carry a unique `id`; each response echoes that `id`.
# Lines that cannot be parsed as JSON, or that are missing `id`/`msg`, are
# logged to stderr and silently ignored — no stdout line is written.
# The sidecar exits cleanly when stdin reaches EOF.
import json
import signal
import sys

signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

# Startup banner on stderr so it does not pollute the JSON stdout channel.
print("[ai-dungeon-sidecar] hello, world", file=sys.stderr, flush=True)

for line in sys.stdin:
    stripped = line.strip()
    if not stripped:
        continue

    try:
        request = json.loads(stripped)
    except json.JSONDecodeError:
        print(f"[sidecar] invalid request: {stripped!r}", file=sys.stderr, flush=True)
        continue

    request_id = request.get("id")
    msg = request.get("msg")

    if request_id is None or msg is None:
        print(f"[sidecar] invalid request: {stripped!r}", file=sys.stderr, flush=True)
        continue

    response = json.dumps({"id": request_id, "reply": "Hello"})
    print(response, flush=True)
