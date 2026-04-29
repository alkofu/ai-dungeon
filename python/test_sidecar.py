#!/usr/bin/env python3
"""Tests for sidecar.py line-delimited JSON request/response loop."""

import json
import subprocess
import sys
import os

SIDECAR_PATH = os.path.join(os.path.dirname(__file__), "sidecar.py")


def run_sidecar(input_bytes: bytes, timeout: float = 5.0):
    """Run the sidecar with given stdin bytes and return (stdout, stderr, returncode)."""
    result = subprocess.run(
        [sys.executable, SIDECAR_PATH],
        input=input_bytes,
        capture_output=True,
        timeout=timeout,
    )
    return result.stdout, result.stderr, result.returncode


def test_well_formed_request_produces_hello_reply():
    """A well-formed request produces one well-formed {"id": ..., "reply": "Hello"} line on stdout."""
    request = json.dumps({"id": "x", "msg": "Hi"}) + "\n"
    stdout, stderr, returncode = run_sidecar(request.encode())

    assert returncode == 0, f"Expected exit 0, got {returncode}; stderr={stderr!r}"

    lines = [l for l in stdout.decode().splitlines() if l.strip()]
    assert len(lines) == 1, f"Expected exactly one stdout line, got: {lines!r}"

    response = json.loads(lines[0])
    assert response == {"id": "x", "reply": "Hello"}, f"Unexpected response: {response!r}"

    # Startup banner must be on stderr only
    assert b"hello, world" in stderr, f"Startup banner missing from stderr; stderr={stderr!r}"
    assert b"hello, world" not in stdout, "Startup banner must not appear on stdout"


def test_malformed_json_does_not_crash_and_produces_no_stdout():
    """Malformed JSON does not crash and produces no stdout line."""
    malformed = b"this is not json\n"
    stdout, stderr, returncode = run_sidecar(malformed)

    assert returncode == 0, f"Expected exit 0, got {returncode}; stderr={stderr!r}"

    lines = [l for l in stdout.decode().splitlines() if l.strip()]
    assert len(lines) == 0, f"Expected no stdout lines for malformed input, got: {lines!r}"

    # Should log an error to stderr
    assert b"invalid request" in stderr, f"Expected error log in stderr; stderr={stderr!r}"


def test_eof_on_stdin_causes_clean_exit():
    """EOF on stdin causes a clean exit (exit code 0)."""
    # Send no input — just close stdin immediately
    stdout, stderr, returncode = run_sidecar(b"")

    assert returncode == 0, f"Expected exit 0 on EOF, got {returncode}; stderr={stderr!r}"


def test_multiple_requests_produce_multiple_replies():
    """Multiple well-formed requests each produce one reply."""
    requests = "\n".join([
        json.dumps({"id": "a", "msg": "Hi"}),
        json.dumps({"id": "b", "msg": "Hello"}),
        json.dumps({"id": "c", "msg": "Test"}),
    ]) + "\n"

    stdout, stderr, returncode = run_sidecar(requests.encode())

    assert returncode == 0, f"Expected exit 0, got {returncode}"

    lines = [l for l in stdout.decode().splitlines() if l.strip()]
    assert len(lines) == 3, f"Expected 3 stdout lines, got: {lines!r}"

    for i, (line, expected_id) in enumerate(zip(lines, ["a", "b", "c"])):
        response = json.loads(line)
        assert response == {"id": expected_id, "reply": "Hello"}, \
            f"Line {i}: unexpected response {response!r}"


def test_missing_id_field_produces_no_stdout():
    """Request missing 'id' field logs an error and produces no stdout."""
    request = json.dumps({"msg": "Hi"}) + "\n"
    stdout, stderr, returncode = run_sidecar(request.encode())

    assert returncode == 0, f"Expected exit 0, got {returncode}"

    lines = [l for l in stdout.decode().splitlines() if l.strip()]
    assert len(lines) == 0, f"Expected no stdout lines for missing id, got: {lines!r}"
    assert b"invalid request" in stderr, f"Expected error log in stderr; stderr={stderr!r}"


def test_missing_msg_field_produces_no_stdout():
    """Request missing 'msg' field logs an error and produces no stdout."""
    request = json.dumps({"id": "x"}) + "\n"
    stdout, stderr, returncode = run_sidecar(request.encode())

    assert returncode == 0, f"Expected exit 0, got {returncode}"

    lines = [l for l in stdout.decode().splitlines() if l.strip()]
    assert len(lines) == 0, f"Expected no stdout lines for missing msg, got: {lines!r}"
    assert b"invalid request" in stderr, f"Expected error log in stderr; stderr={stderr!r}"


if __name__ == "__main__":
    tests = [
        test_well_formed_request_produces_hello_reply,
        test_malformed_json_does_not_crash_and_produces_no_stdout,
        test_eof_on_stdin_causes_clean_exit,
        test_multiple_requests_produce_multiple_replies,
        test_missing_id_field_produces_no_stdout,
        test_missing_msg_field_produces_no_stdout,
    ]

    failed = []
    for test in tests:
        try:
            test()
            print(f"  PASS  {test.__name__}")
        except Exception as e:
            print(f"  FAIL  {test.__name__}: {e}")
            failed.append(test.__name__)

    if failed:
        print(f"\n{len(failed)} test(s) failed.")
        sys.exit(1)
    else:
        print(f"\nAll {len(tests)} tests passed.")
