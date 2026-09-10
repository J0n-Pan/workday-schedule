"""打包 Windows 免安装版，用于发布到 GitHub Releases。

产物：dist/workday-schedule-<version>-win-x64.zip
解压后目录内直接双击 setup.bat（或 launch.vbs）即可使用，无需联网、无需安装 Node。

用法：
    python tools/package_release.py                 # 需要 runtime/node.exe 已存在
    python tools/package_release.py --skip-runtime  # 打小包（用户需自备 Node）
"""
import argparse
import io
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
RUNTIME_EXE = os.path.join(ROOT, 'runtime', 'node.exe')

EXCLUDE_DIRS = {'.git', '.github', 'data', 'dist', 'node_modules', 'runtime', '__pycache__'}
EXCLUDE_DIRS_REL = {os.path.join('tests', '.tmp')}
EXCLUDE_FILES = {'.DS_Store', 'Thumbs.db'}


def version():
    with io.open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as f:
        return json.load(f)['version']


def is_excluded(rel):
    parts = rel.replace('/', os.sep).split(os.sep)
    if parts[0] in EXCLUDE_DIRS:
        return True
    if os.sep.join(parts[:2]) in EXCLUDE_DIRS_REL:
        return True
    if parts[-1] in EXCLUDE_FILES:
        return True
    if parts[-1].endswith(('.pyc', '.log')):
        return True
    return False


def collect():
    out = []
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if not is_excluded(os.path.relpath(os.path.join(base, d), ROOT))]
        for name in files:
            full = os.path.join(base, name)
            rel = os.path.relpath(full, ROOT)
            if is_excluded(rel):
                continue
            out.append((full, rel))
    return sorted(out, key=lambda x: x[1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--skip-runtime', action='store_true', help='不打包 Node 运行时（体积从约 40MB 降到约 1MB）')
    ap.add_argument('--out', default=DIST)
    args = ap.parse_args()

    if not args.skip_runtime and not os.path.isfile(RUNTIME_EXE):
        raise SystemExit(
            'runtime/node.exe 不存在。请先运行：\n'
            '  python tools/setup_runtime.py --download\n'
            '或使用 --skip-runtime 打不含运行时的包。'
        )

    ver = version()
    suffix = 'win-x64' if not args.skip_runtime else 'win-x64-noruntime'
    name = f'workday-schedule-{ver}-{suffix}'
    os.makedirs(args.out, exist_ok=True)
    zip_path = os.path.join(args.out, f'{name}.zip')

    entries = collect()
    if not args.skip_runtime:
        lic = os.path.join(ROOT, 'runtime', 'LICENSE-node.txt')
        if os.path.isfile(lic):
            entries.append((lic, os.path.join('runtime', 'LICENSE-node.txt')))
        entries.append((RUNTIME_EXE, os.path.join('runtime', 'node.exe')))

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for full, rel in entries:
            z.write(full, os.path.join(name, rel))

    size = os.path.getsize(zip_path)
    print(f'created: {zip_path}')
    print(f'  entries: {len(entries)}')
    print(f'  size   : {size / 1024 / 1024:.1f} MB')
    print(f'  解压后进入 {name}/ 双击 setup.bat 即可使用')
    return 0


if __name__ == '__main__':
    sys.exit(main())
