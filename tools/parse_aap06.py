#!/usr/bin/env python3
"""Parse AAP-06 (NATO Glossary of Terms and Definitions) into structured JSON.

Body grammar:
  bold  -> headword, "english term / terme francais" (may wrap over bold lines)
  plain -> definition lines, with the final line carrying the source and date
Lines keep their trailing spaces, so they concatenate directly.
"""
import html
import json
import re
import sys

PAGE_RE = re.compile(r'<page number="(\d+)"')
TEXT_RE = re.compile(r'<text top="(\d+)" left="(\d+)" width="(\d+)"[^>]*>(.*?)</text>', re.S)
TAG_RE = re.compile(r'<[^>]+>')
BOLD_RE = re.compile(r'<b>')

RUNNING_HEAD_RE = re.compile(r'^AAP-06\(\d{4}\)$|^[A-Z0-9\-]{1,6}$|^\d+$')
# AAP-06 prints the glossary twice: English-ordered first, then the French
# mirror.  Only the first half is kept.  (Verified for the 2019 edition.)
ENGLISH_SECTION_LAST_PAGE = 165
# A leading status marker sometimes precedes the definition text.
LEAD_MARKER_RE = re.compile(
    r'^\s*\((admitted|deprecated|obsolete|preferred|privil\u00e9gi\u00e9|'
    r'tol\u00e9r\u00e9|d\u00e9conseill\u00e9)\)\s*', re.I)
# The trailing "SOURCE, yyyy.mm.dd"; source tokens never contain spaces, which
# stops the pattern from eating the tail of the definition.
TAIL_RE = re.compile(
    r"(?:\s(?P<src>[A-Z][A-Za-z0-9&/().\-]{0,20}"
    r"(?:,\s*[A-Z][A-Za-z0-9&/().\-]{0,20}){0,3}),)?"
    r"\s*(?P<date>\d{4}\.\d{2}\.\d{2})\.?\s*$")
DATE_RE = re.compile(r'^(?P<src>.*?,\s*)?(?P<date>\d{4}\.\d{2}\.\d{2})\.?$')
ADMITTED_RE = re.compile(r'\s*\((admitted|deprecated|obsolete|preferred)\)', re.I)
# "term - ABBR" using a hyphen or an en/em dash
ABBR_SPLIT_RE = re.compile(r'\s+[‐-―-]\s+')


def read_lines(xml_path):
    with open(xml_path, encoding='utf-8', errors='replace') as fh:
        xml_text = fh.read()
    for chunk in re.split(r'(?=<page number=")', xml_text):
        pm = PAGE_RE.match(chunk)
        if not pm:
            continue
        page = int(pm.group(1))
        if page > ENGLISH_SECTION_LAST_PAGE:
            break
        for _top, _left, width, body in TEXT_RE.findall(chunk):
            bold = bool(BOLD_RE.search(body))
            txt = html.unescape(TAG_RE.sub('', body)).replace(' ', ' ')
            if not txt.strip():
                continue
            if RUNNING_HEAD_RE.match(txt.strip()):
                continue
            yield page, txt, bold


def split_entries(stream):
    entries, cur, prev_bold = [], None, False
    for page, txt, bold in stream:
        if bold and not prev_bold:
            if cur:
                entries.append(cur)
            cur = []
        if cur is not None:
            cur.append((txt, bold))
        prev_bold = bold
    if cur:
        entries.append(cur)
    return entries


def tidy(parts):
    return re.sub(r'\s+', ' ', ''.join(parts)).strip()


def split_term(term):
    """'crowd and riot control - CRC' -> ('crowd and riot control', 'CRC')"""
    term, flags = ADMITTED_RE.subn('', term)[0].strip(), ADMITTED_RE.findall(term)
    bits = ABBR_SPLIT_RE.split(term)
    if len(bits) == 2 and bits[1] and bits[1] == bits[1].upper() and len(bits[1]) <= 14:
        return bits[0].strip(), bits[1].strip(), [f.lower() for f in flags]
    return term, None, [f.lower() for f in flags]


def parse_entry(entry):
    head = tidy([t for t, b in entry if b])
    body = [t for t, b in entry if not b]
    if ' / ' not in head:
        return None

    en_head, fr_head = head.split(' / ', 1)
    en_term, en_abbr, flags = split_term(en_head)
    fr_term, fr_abbr, _ = split_term(fr_head)
    if not en_term:
        return None

    lines = tidy(body)
    date, source = None, None
    dm = TAIL_RE.search(lines)
    if not dm:
        return None
    source, date = dm.group('src'), dm.group('date')
    lines = lines[:dm.start()].strip()
    # Bracketed citations sit at either end of some definitions; keep them as
    # the source rather than leaving them in the prose.
    cites = []
    m_lead = re.match(r'^\[([^\]]{2,60})\]\s*', lines)
    if m_lead:
        cites.append(m_lead.group(1))
        lines = lines[m_lead.end():].strip()
    m_tail = re.search(r'\s*\[([^\]]{2,60})\]\.?$', lines)
    if m_tail:
        cites.append(m_tail.group(1))
        lines = lines[:m_tail.start()].strip()
    if cites:
        source = ', '.join([c for c in ([source] if source else []) + cites])

    lead = LEAD_MARKER_RE.match(lines)
    if lead:
        flags = sorted(set(flags + [lead.group(1).lower()]))
        lines = LEAD_MARKER_RE.sub('', lines, count=1).strip()

    return {
        'en': en_term,
        'fr': fr_term,
        'abbr': en_abbr,
        'fr_abbr': fr_abbr,
        'definition': lines,
        'source': source,
        'date': date,
        'flags': flags,
    }


def main(xml_path, out_path):
    entries = split_entries(read_lines(xml_path))
    records, skipped = [], 0
    seen = set()
    for e in entries:
        r = parse_entry(e)
        if r and r['definition']:
            key = (r['en'], r['definition'][:60])
            if key in seen:
                continue
            seen.add(key)
            records.append(r)
        else:
            skipped += 1
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(records, fh, ensure_ascii=False, indent=1)
    print(f'blocks={len(entries)} parsed={len(records)} skipped={skipped}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
