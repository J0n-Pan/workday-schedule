"""Create the desktop shortcut for Workday (pure-python, no COM).

Usage: python tools/make_shortcut.py [--desktop DIR]
"""
import os
import sys

from pylnk3 import for_file

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAUNCHER = os.path.join(PROJECT, 'launch.vbs')
WSCRIPT = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'wscript.exe')
ICON = r'D:\workBuddy\WorkBuddy.exe'
NAME = '工作日程.lnk'


def main():
    desktop = None
    if '--desktop' in sys.argv:
        desktop = sys.argv[sys.argv.index('--desktop') + 1]
    if not desktop:
        desktop = os.path.join(os.path.expanduser('~'), 'Desktop')
    if not os.path.isdir(desktop):
        raise SystemExit(f'desktop not found: {desktop}')
    if not os.path.isfile(LAUNCHER):
        raise SystemExit(f'launcher not found: {LAUNCHER}')
    if not os.path.isfile(ICON):
        raise SystemExit(f'icon not found: {ICON}')

    target = os.path.join(desktop, NAME)
    for_file(
        WSCRIPT,
        lnk_name=target,
        arguments=f'"{LAUNCHER}"',
        description='Workday - local work schedule manager',
        icon_file=ICON,
        icon_index=0,
        work_dir=PROJECT,
        window_mode='Normal',
    )
    print(f'created: {target}')
    print(f'  target : {WSCRIPT}')
    print(f'  args   : "{LAUNCHER}"')
    print(f'  icon   : {ICON},0')
    print(f'  workdir: {PROJECT}')


if __name__ == '__main__':
    main()
