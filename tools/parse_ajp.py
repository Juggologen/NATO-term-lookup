#!/usr/bin/env python3
"""Extract the Lexicon from each Allied Joint Publication.

Every AJP ends with a Lexicon holding the doctrine vocabulary that the AAP-15
and AAP-06 glossaries do not carry - which is where most operational planning
abbreviations live (MAOP, AOD, GAT, JFACC, JPTL and so on).

Heading wording varies between publications ("Part 1 - Acronyms and
abbreviations", "Acronyms, abbreviations, and initialisms", none at all), so
the lexicon is located by its title page and its contents are classified by
shape instead:
  "ABBR<2+ spaces>expansion"                      -> an abbreviation
  block whose text ends "(NATO Agreed)" or similar -> a term and definition
"""
import json
import os
import re
import subprocess
import sys

LEXICON_RE = re.compile(r'^\s*lexicon\s*$', re.I)
PART2_RE = re.compile(r'(part\s*(?:2|ii)\b\s*[-–—]?\s*terms)|'
                      r'(^\s*terms\s+and\s+definitions\.?\s*$)', re.I)
FURNITURE_RE = re.compile(
    r'^\s*(lex-\s*\d+|edition\s+[a-z]\s+version\s+\d+(\s*\+.*)?|lexicon(\s+to)?|'
    r'ajp-[0-9.]+(\([a-z]\))?(\(\d\))?|[0-9]+|[ivxlc]+|intentionally blank)\s*$', re.I)
NOISE_RE = re.compile(r'^\s*(\d+\s+)?(available at|the lexicon contains|a more\b|this database|'
                      r'regularly and|comprehensive list|natoterm|the nso\b|'
                      r'and is not meant|definitive list|crown copyright|published by|'
                      r'this publication is available|part\s*[12i]+\b)', re.I)
ENTRY_RE = re.compile(r'^(?P<ind>\s*)(?P<abbr>[A-Za-z0-9][A-Za-z0-9&/()\-.\'+]{0,19})'
                      r'\s{2,}(?P<rest>\S.*?)\s*$')
STATUS_TAIL_RE = re.compile(r'\s*\((?P<s>[^()]{1,60})\)\s*$')
HAS_LOWER_WORD = re.compile(r'[a-z]{2,}')


def text_of(pdf, cache_dir):
    out = os.path.join(cache_dir, os.path.basename(pdf) + '.txt')
    if not os.path.exists(out):
        subprocess.run(['pdftotext', '-layout', pdf, out],
                       check=True, stderr=subprocess.DEVNULL)
    with open(out, encoding='utf-8', errors='replace') as fh:
        return fh.read().splitlines()


def lexicon_region(lines):
    marks = [i for i, l in enumerate(lines) if LEXICON_RE.match(l)]
    start = marks[-1] if marks else int(len(lines) * 0.82)
    return start + 1, lines[start + 1:]


def blocks(region):
    """Yield (start_index, [stripped lines]) for blank-line separated blocks."""
    buf, start = [], 0
    for i, raw in enumerate(region):
        if not raw.strip():
            if buf:
                yield start, buf
            buf = []
            continue
        if not buf:
            start = i
        buf.append(raw.strip())
    if buf:
        yield start, buf


def parse_terms(region, consumed):
    out = []
    for start, blk in blocks(region):
        blk = [l for l in blk if not FURNITURE_RE.match(l) and not NOISE_RE.match(l)]
        if len(blk) < 2:
            continue
        # A two-column line is an abbreviation row, not a term heading.
        if re.search(r'\S\s{2,}\S', blk[0]):
            continue
        term = re.sub(r'\s+', ' ', blk[0]).strip()
        body = re.sub(r'\s+', ' ', ' '.join(blk[1:])).strip()
        m = STATUS_TAIL_RE.search(body)
        if not m:
            continue                       # only trust blocks that carry a status
        status = m.group('s').strip()
        definition = body[:m.start()].strip()
        if not (3 < len(term) < 90) or len(definition) < 20:
            continue
        if not HAS_LOWER_WORD.search(term):
            continue
        out.append({'term': term, 'definition': definition, 'status': status})
        for j in range(start, start + len(blk) + 1):
            consumed.add(j)
    return out


def parse_abbrs(region, consumed):
    out, last = [], None
    for i, raw in enumerate(region):
        if i in consumed:
            last = None
            continue
        if not raw.strip():
            last = None
            continue
        if FURNITURE_RE.match(raw) or NOISE_RE.match(raw):
            last = None
            continue
        m = ENTRY_RE.match(raw)
        if m and len(m.group('ind')) <= 14:
            abbr = m.group('abbr').strip()
            rest = m.group('rest').strip()
            if rest and not rest.startswith('(') and HAS_LOWER_WORD.search(rest):
                last = {'abbr': abbr, 'full': rest}
                out.append(last)
                continue
        if last is not None and raw.startswith(' ' * 16):
            last['full'] = (last['full'] + ' ' + raw.strip()).strip()
        else:
            last = None

    cleaned, seen = [], set()
    for e in out:
        full = re.sub(r'\s+', ' ', e['full']).strip(' .,;')
        full = re.sub(r'\s*\d{1,3}$', '', full).strip()
        abbr = e['abbr'].strip(' .')
        if not abbr or len(full) < 3 or full.lower() == abbr.lower():
            continue
        # Lexicon expansions are short phrases; anything longer is body prose
        # that the two-column pattern happened to match.
        if len(full) > 120:
            continue
        # Real abbreviations carry an upper-case letter or digit. This drops
        # paragraph list markers ("a.", "n", "A.1") that look like a column.
        if len(abbr) < 2 or not re.search(r'[A-Z0-9]', abbr):
            continue
        if re.fullmatch(r'[A-Za-z]\.?\d*(\.\d+)*', abbr):
            continue
        if re.fullmatch(r'[\d.]+', abbr):
            continue
        key = (abbr.upper(), full.lower())
        if key in seen:
            continue
        seen.add(key)
        cleaned.append({'abbr': abbr, 'full': full})
    return cleaned


def main(pdf_dir, manifest_path, out_path):
    manifest = json.load(open(manifest_path, encoding='utf-8'))
    cache = os.path.join(pdf_dir, '_txt')
    os.makedirs(cache, exist_ok=True)
    records = []
    for m in manifest:
        name = re.sub(r'[^A-Za-z0-9.]', '_', m['code']) + '.pdf'
        path = os.path.join(pdf_dir, name)
        if not os.path.exists(path):
            print(f'  missing {name}', file=sys.stderr)
            continue
        lines = text_of(path, cache)
        _start, region = lexicon_region(lines)
        consumed = set()
        terms = parse_terms(region, consumed)
        abbrs = parse_abbrs(region, consumed)
        records.append({'code': m['code'], 'title': m['title'],
                        'abbreviations': abbrs, 'terms': terms})
        print(f'  {m["code"]:<10} abbr={len(abbrs):<4} terms={len(terms)}')
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(records, fh, ensure_ascii=False, indent=1)
    ta = sum(len(r['abbreviations']) for r in records)
    tt = sum(len(r['terms']) for r in records)
    print(f'publications={len(records)} abbreviations={ta} terms={tt}')


if __name__ == '__main__':
    main(*sys.argv[1:])
