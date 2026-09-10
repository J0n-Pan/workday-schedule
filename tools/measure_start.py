"""Measure how long the server takes to become ready (cold start).

Usage: python tools/measure_start.py [--runs 3]
It launches server/index.js, polls /api/health every 25ms and prints the elapsed time.
"""
import argparse
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = os.path.join(ROOT, 'runtime', 'node.exe')
if not os.path.isfile(NODE):
    NODE = 'node'
URL = 'http://127.0.0.1:5173/api/health'


def run_once():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    t0 = time.perf_counter()
    proc = subprocess.Popen(
        [NODE, os.path.join(ROOT, 'server', 'index.js')],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        while time.perf_counter() - t0 < 30:
            try:
                with opener.open(URL, timeout=1) as r:
                    if r.status == 200:
                        return (time.perf_counter() - t0) * 1000
            except Exception:
                pass
            time.sleep(0.025)
        return None
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs', type=int, default=3)
    args = ap.parse_args()
    times = []
    for i in range(args.runs):
        ms = run_once()
        times.append(ms)
        print(f'run {i + 1}: {"timeout" if ms is None else f"{ms:.0f} ms"}')
    valid = [t for t in times if t is not None]
    if valid:
        print(f'avg: {sum(valid) / len(valid):.0f} ms  min: {min(valid):.0f} ms  max: {max(valid):.0f} ms')
    return 0


if __name__ == '__main__':
    sys.exit(main())
