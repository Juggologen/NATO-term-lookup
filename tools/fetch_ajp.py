#!/usr/bin/env python3
"""List the current Allied Joint Publication PDFs published on GOV.UK.

Writes a manifest of {code, title, url} so the download step is reproducible.
"""
import json
import re
import sys
import urllib.request

API = 'https://www.gov.uk/api/content'
COLLECTION = '/government/collections/allied-joint-publication-ajp'
UA = {'User-Agent': 'nato-term-lookup-build/1.0'}
CODE_RE = re.compile(r'\(?\b(AJP-[0-9]+(?:\.[0-9]+)*)\b', re.I)


def get(path):
    req = urllib.request.Request(API + path, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as fh:
        return json.load(fh)


def publication_paths(doc):
    paths = set()
    def walk(node):
        if isinstance(node, dict):
            if node.get('base_path', '').startswith('/government/publications/'):
                paths.add(node['base_path'])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(doc)
    return sorted(paths)


def main(out_path):
    coll = get(COLLECTION)
    paths = publication_paths(coll)
    print(f'publications in collection: {len(paths)}', file=sys.stderr)

    manifest = []
    for p in paths:
        try:
            doc = get(p)
        except Exception as exc:
            print(f'  skip {p}: {exc}', file=sys.stderr)
            continue
        title = doc.get('title', '')
        m = CODE_RE.search(title)
        code = m.group(1).upper() if m else None
        atts = (doc.get('details') or {}).get('attachments') or []
        for a in atts:
            url = a.get('url', '')
            if not url.lower().endswith('.pdf'):
                continue
            at = a.get('title', '')
            if re.search(r'archive|superseded|withdrawn', at + ' ' + url, re.I):
                continue
            acode = code
            m2 = CODE_RE.search(at)
            if m2:
                acode = m2.group(1).upper()
            manifest.append({'code': acode or 'AJP', 'title': title,
                             'attachment': at, 'url': url})
    # keep one PDF per AJP code: prefer the longest attachment title mentioning an edition
    best = {}
    for item in manifest:
        k = item['code']
        cur = best.get(k)
        score = (1 if re.search(r'edition', item['attachment'], re.I) else 0,
                 len(item['attachment']))
        if cur is None or score > cur[0]:
            best[k] = (score, item)
    chosen = [v[1] for v in best.values()]
    chosen.sort(key=lambda x: x['code'])
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(chosen, fh, ensure_ascii=False, indent=1)
    print(f'manifest entries: {len(chosen)}', file=sys.stderr)
    for c in chosen:
        print(f"  {c['code']:<10} {c['attachment'][:60]}")


if __name__ == '__main__':
    main(sys.argv[1])
