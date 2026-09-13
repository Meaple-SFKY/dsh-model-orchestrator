#!/usr/bin/env python3
"""Locale dictionary helper for maintaining lib/locales.js and the embedded copy.

The dictionary exists twice on purpose (the static client bundle imports nothing),
so maintaining it by hand is error-prone. This tool edits a value by KEY without
touching neighbouring entries — the failure mode hand-editing produced was a
multi-line value replacement swallowing the next key.

Usage (from this script's directory):
    python3 scripts/locale-tool.py add <key> <en> <zh>
    python3 scripts/locale-tool.py set <key> <en> <zh>
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGETS = [
    (ROOT / 'lib/locales.js', 'export const zh = {'),
    (ROOT / 'lib/client.js', 'const zh = {'),
]
KEYLINE = re.compile(r"^(\s*)'([^']+)':(.*)$")


def split_sections(text, boundary):
    idx = text.find(boundary)
    if idx == -1:
        raise SystemExit(f'boundary not found: {boundary!r}')
    return text[:idx], text[idx:]


def replace_value(text, key, value):
    """Replace only the VALUE of `key`, preserving the key line and neighbours."""
    lines = text.split('\n')
    out, hits, i = [], 0, 0
    while i < len(lines):
        m = KEYLINE.match(lines[i])
        if not m or m.group(2) != key:
            out.append(lines[i]); i += 1; continue
        indent, after = m.group(1), m.group(3)
        if after.strip() != '':
            out.append(f"{indent}'{key}': {value}")
            i += 1; hits += 1; continue
        out.append(f"{indent}'{key}':")
        j = i + 1
        while j < len(lines):
            nxt = lines[j]
            if nxt.strip() == '':
                j += 1; continue
            nindent = len(nxt) - len(nxt.lstrip())
            nm = KEYLINE.match(nxt)
            if nm and nindent <= len(indent):
                break
            if nindent <= len(indent) and not nxt.lstrip().startswith("'"):
                break
            j += 1
        out.append(f"{indent}  {value}")
        i = j; hits += 1
    return '\n'.join(out), hits


def insert_after(text, anchor, key, value, occurrence=1):
    """Insert one entry directly after `anchor`'s entry."""
    lines = text.split('\n')
    out, count, i = [], 0, 0
    while i < len(lines):
        m = KEYLINE.match(lines[i])
        if not m or m.group(2) != anchor:
            out.append(lines[i]); i += 1; continue
        count += 1
        indent = m.group(1)
        out.append(lines[i]); j = i + 1
        if m.group(3).strip() == '':
            while j < len(lines):
                nxt = lines[j]
                if nxt.strip() == '':
                    out.append(nxt); j += 1; continue
                nindent = len(nxt) - len(nxt.lstrip())
                nm = KEYLINE.match(nxt)
                if nm and nindent <= len(indent):
                    break
                if nindent <= len(indent) and not nxt.lstrip().startswith("'"):
                    break
                out.append(nxt); j += 1
        if count == occurrence:
            # The caller supplies the literal, which may or may not already end in
            # a comma; never emit a double comma.
            rendered = value.rstrip()
            if not rendered.endswith(','):
                rendered += ','
            out.append(f"{indent}'{key}': {rendered}")
        i = j
    if count < occurrence:
        raise SystemExit(f'anchor {anchor!r} appears {count} time(s)')
    return '\n'.join(out)


def main(argv):
    if len(argv) != 4:
        raise SystemExit(__doc__)
    mode, key, en, zh = argv
    for path, boundary in TARGETS:
        text = path.read_text()
        en_part, zh_part = split_sections(text, boundary)
        if mode == 'add':
            # Anchor on an existing stable key so both locales stay aligned.
            en_part = insert_after(en_part, 'capacity.note', key, en)
            zh_part = insert_after(zh_part, 'capacity.note', key, zh)
        elif mode == 'set':
            en_part, n1 = replace_value(en_part, key, en)
            zh_part, n2 = replace_value(zh_part, key, zh)
            if n1 != 1 or n2 != 1:
                raise SystemExit(f'{path}: {key} found en={n1} zh={n2}')
        else:
            raise SystemExit(f'unknown mode {mode!r}')
        path.write_text(en_part + zh_part)
        print(f'{path.relative_to(ROOT)}: {mode} {key}')


if __name__ == '__main__':
    main(sys.argv[1:])
