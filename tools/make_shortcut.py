"""Create the desktop shortcut for Workday (pure-python, no COM).

Usage: python tools/make_shortcut.py [--desktop DIR] [--icon PATH] [--name NAME]
The icon is optional; when omitted, no icon is set (Windows uses the default).
"""
import os
import sys

from pylnk3 import for_file

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAUNCHER = os.path.join(PROJECT, 'launch.vbs')
WSCRIPT = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'wscript.exe')
NAME = os.environ.get('WORKDAY_SHORTCUT_NAME', '工作日程.lnk')


def main():
    desktop = None
    icon = None
    if '--icon' in sys.argv:
        icon = sys.argv[sys.argv.index('--icon') + 1]
    if '--name' in sys.argv:
        globals()['NAME'] = sys.argv[sys.argv.index('--name') + 1]
    if '--desktop' in sys.argv:
        desktop = sys.argv[sys.argv.index('--desktop') + 1]
    if not desktop:
        desktop = os.path.join(os.path.expanduser('~'), 'Desktop')
    if not os.path.isdir(desktop):
        raise SystemExit(f'desktop not found: {desktop}')
    if not os.path.isfile(LAUNCHER):
        raise SystemExit(f'launcher not found: {LAUNCHER}')
    if icon and not os.path.isfile(icon):
        raise SystemExit(f'icon not found: {icon}')

    target = os.path.join(desktop, NAME)
    for_file(
        WSCRIPT,
        lnk_name=target,
        arguments=f'"{LAUNCHER}"',
        description='Workday - local work schedule manager',
        icon_file=icon,
        icon_index=0,
        work_dir=PROJECT,
        window_mode='Normal',
    )
    print(f'created: {target}')
    print(f'  target : {WSCRIPT}')
    print(f'  args   : "{LAUNCHER}"')
    print(f'  icon   : {icon or "(default)"},0')
    print(f'  workdir: {PROJECT}')


if __name__ == '__main__':
    main()
