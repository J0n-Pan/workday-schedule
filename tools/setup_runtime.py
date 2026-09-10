"""Install a private Node.js runtime into ./runtime so the app is self-contained.

The launcher (launch.vbs) uses runtime\\node.exe first, so the app does not depend on
any globally installed Node or on the WorkBuddy directory.

Usage:
    python tools/setup_runtime.py                # find a local Node >= 22.5 and copy it
    python tools/setup_runtime.py --source EXE   # copy a specific node.exe
    python tools/setup_runtime.py --download     # fetch official Node 22 x64 zip
"""
import argparse
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, 'runtime')
TARGET = os.path.join(RUNTIME, 'node.exe')
MIN_VERSION = (22, 5)
DEFAULT_DIST = 'https://nodejs.org/dist/v22.22.2/node-v22.22.2-win-x64.zip'


def version_of(exe):
    try:
        out = subprocess.run([exe, '-v'], capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:
        return None
    m = re.match(r'v?(\d+)\.(\d+)\.(\d+)', out)
    return tuple(int(x) for x in m.groups()) if m else None


def ok(exe):
    v = version_of(exe)
    return v is not None and v >= MIN_VERSION, v


def candidates():
    found = []
    which = shutil.which('node')
    if which:
        found.append(which)
    for p in (
        os.path.join(os.environ.get('ProgramFiles', ''), 'nodejs', 'node.exe'),
        os.path.join(os.environ.get('ProgramW6432', ''), 'nodejs', 'node.exe'),
        os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs', 'nodejs', 'node.exe'),
        os.path.join(os.path.expanduser('~'), '.workbuddy', 'binaries', 'node', 'versions'),
    ):
        if p.endswith('versions') and os.path.isdir(p):
            for name in sorted(os.listdir(p), reverse=True):
                found.append(os.path.join(p, name, 'node.exe'))
        elif p:
            found.append(p)
    return [f for f in found if f and os.path.isfile(f)]


def install_from(exe):
    good, v = ok(exe)
    if not good:
        raise SystemExit(f'unusable node: {exe} (version={v}, need >= {MIN_VERSION[0]}.{MIN_VERSION[1]})')
    os.makedirs(RUNTIME, exist_ok=True)
    shutil.copy2(exe, TARGET)
    lic = os.path.join(os.path.dirname(exe), 'LICENSE')
    if os.path.isfile(lic):
        shutil.copy2(lic, os.path.join(RUNTIME, 'LICENSE-node.txt'))
    print(f'installed {TARGET} (v{".".join(map(str, v))})')


def install_download(url=DEFAULT_DIST):
    import urllib.request
    print(f'downloading {url}')
    with tempfile.TemporaryDirectory() as tmp:
        zpath = os.path.join(tmp, 'node.zip')
        with urllib.request.urlopen(url, timeout=120) as r, open(zpath, 'wb') as f:
            shutil.copyfileobj(r, f)
        with zipfile.ZipFile(zpath) as z:
            names = [n for n in z.namelist() if n.endswith('node.exe')]
            if not names:
                raise SystemExit('node.exe not found in archive')
            member = sorted(names, key=len)[0]
            os.makedirs(RUNTIME, exist_ok=True)
            with z.open(member) as src, open(TARGET, 'wb') as dst:
                shutil.copyfileobj(src, dst)
            for extra in ('LICENSE', 'LICENSE.md'):
                if extra in z.namelist():
                    with z.open(extra) as src, open(os.path.join(RUNTIME, 'LICENSE-node.txt'), 'wb') as dst:
                        shutil.copyfileobj(src, dst)
                    break
    print(f'installed {TARGET}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source')
    ap.add_argument('--download', action='store_true')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--url', default=DEFAULT_DIST)
    args = ap.parse_args()

    if os.path.isfile(TARGET) and not args.force:
        good, v = ok(TARGET)
        print(f'runtime already present: {TARGET} (v{".".join(map(str, v)) if v else "?"})')
        return 0

    if args.download:
        install_download(args.url)
    elif args.source:
        install_from(os.path.abspath(args.source))
    else:
        for exe in candidates():
            good, v = ok(exe)
            if good:
                install_from(exe)
                break
        else:
            raise SystemExit(
                'no local Node >= 22.5 found. Install Node, or run:\n'
                '  python tools/setup_runtime.py --download\n'
                '  python tools/setup_runtime.py --source path\\to\\node.exe'
            )
    return 0


if __name__ == '__main__':
    sys.exit(main())
