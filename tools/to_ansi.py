"""Convert a text file from UTF-8 to the system ANSI code page (GBK on Chinese Windows).

Usage: python to_ansi.py <file> [encoding-out]
The Windows script host reads .vbs files as ANSI, so UTF-8 Chinese text breaks parsing.
"""
import sys

path = sys.argv[1]
out_enc = sys.argv[2] if len(sys.argv) > 2 else 'gbk'
text = open(path, encoding='utf-8').read()
data = text.encode(out_enc)
with open(path, 'wb') as f:
    f.write(data)
print(f'converted {path} -> {out_enc}, {len(data)} bytes')
non_ascii = [c for c in text if ord(c) > 127]
print(f'non-ascii chars: {len(non_ascii)}')
