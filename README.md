# NATO Lookup

A quick-reference for NATO abbreviations and terms, built to answer two questions fast:

- **What does this abbreviation mean?** Type `OPORD`, get *operation order*.
- **What is this thing called?** Type *order telling units what to do*, get `OPORD`.

It is a single static page. Once loaded it makes **no network requests at all** —
every search runs against a terminology file held in the browser. Install it on a
phone and it works with no signal.

## Using it

| Field | What to type | What you get |
| --- | --- | --- |
| **Abbreviation** | `CIMIC`, `rOE`, partial forms like `MEDE` | Every sense of that abbreviation, exact matches first |
| **Term or description** | The proper term, or plain words in English or Swedish | Ranked candidate entries |

Fill in both fields to narrow results to entries matching both. `/` jumps to the
abbreviation field, `Esc` clears the focused field. The theme follows the
operating system and the toggle overrides it.

### Installing on a phone

Open the page, then *Add to Home Screen* (iOS Safari) or *Install app*
(Android Chrome). A service worker caches the whole app, so it opens and
searches offline.

## What is in the data

`data/terms.json` holds **7,372 entries**, built from two published NATO sources:

| Source | Content | Entries |
| --- | --- | --- |
| **AAP-15** — NATO Glossary of Abbreviations used in NATO Documents and Publications | Abbreviation → full form, with the French equivalent | 4,865 with an abbreviation |
| **AAP-06** — NATO Glossary of Terms and Definitions (2019) | Term → definition | 2,950 entries carry a definition |

Both are published by the NATO Standardization Office. The AAP-15 content is a
NATOTerm extract dated 15 April 2026; AAP-06 ceased publication as a bilingual
Allied publication in 2022 and the 2019 edition is the last full one, so some
definitions are older than the abbreviation list.

Where an AAP-15 full form matches an AAP-06 term, the definition is attached to
the abbreviation. 145 deprecated abbreviations are kept as cross-references
("use X instead").

### Unofficial additions

Three small layers are **not** NATO terminology. They exist so the search can be
driven in everyday language, and the app labels them:

- `data/supplementary.json` — 14 abbreviations in common use that the official
  extracts do not contain (NOTAM, IFF, UAV, PSYOPS, LNO and similar). Shown with
  a **Common usage** tag.
- `data/sv-keywords.json` — Swedish terms for 119 entries, shown on the card as
  `SV`. A search aid, not a translation authority.
- `data/aliases.json` — plain-language English phrases ("roadside bomb" → IED)
  for 83 entries. Used for searching only; not displayed.

All three are plain JSON and are meant to be extended — see below.

## How well does the description search work?

Looking up an abbreviation, or a term by its proper name, is reliable.

Finding an entry from a *paraphrase* is ordinary keyword search with stemming
and a hand-written keyword layer, not a language model. On a sample of
descriptions phrased without reference to the entry's own wording, the intended
entry came first about half the time. When a description fails, the fix is to
add the phrasing to `data/aliases.json` and rebuild — which is why that file
exists.

## Extending the keyword layers

Both keyword files use the same shape. `abbr` is keyed by abbreviation; add
`"en"` to bind the keywords to one sense when an abbreviation has several.
`term` is keyed by an English term.

```json
{
  "abbr": {
    "ROE": [{ "k": ["when soldiers may open fire", "use of force rules"] }],
    "AD":  [{ "en": "air defence", "k": ["anti aircraft"] }]
  },
  "term": {
    "centre of gravity": ["source of strength"]
  }
}
```

`sv-keywords.json` is identical but uses `"sv"` instead of `"k"`. Diacritics are
optional in both: search folds `å ä ö é` to their base letters, so *sjöräddning*
and *sjoraddning* both match.

After editing, rebuild `data/terms.json`:

```bash
python3 tools/build_data.py parsed/aap15.json parsed/aap06.json data/terms.json data/sv-keywords.json data/supplementary.json data/aliases.json
```

Then bump `CACHE` in `sw.js` so installed copies pick up the new file.

## Rebuilding from the source PDFs

`tools/` contains the full pipeline. It needs `poppler-utils` and Python 3.

```bash
pdftohtml -xml -i -stdout AAP-15.pdf > aap15.xml
pdftohtml -xml -i -stdout AAP-06.pdf > aap06.xml
python3 tools/parse_aap15.py aap15.xml parsed/aap15.json
python3 tools/parse_aap06.py aap06.xml parsed/aap06.json
python3 tools/build_data.py parsed/aap15.json parsed/aap06.json data/terms.json \
        data/sv-keywords.json data/supplementary.json data/aliases.json
```

The AAP-15 parser reads the PDF's typography rather than its text: bold marks a
headword, upright text is the entry's primary language and italic the secondary,
and the status line (`NATO Agreed` / `Agréé OTAN`) says which is which. Line
breaks are re-flowed using Helvetica metrics (`tools/helv.py`), so a wrapped
phrase can be told apart from a second synonym on its own line.

## Layout

```
index.html      markup
styles.css      light/dark theming, no framework
app.js          index building, search, rendering
sw.js           offline cache
data/           terminology and the keyword layers
tools/          PDF parsers and the dataset builder
```

No build step, no dependencies, no CDN. Everything the page loads is in this
repository.

## Licence and attribution

The code in this repository is MIT licensed — see `LICENSE`.

The terminology is NATO's. NATO states that its terminology may be copied
without the express consent of the NATO Standardization Office provided NATO is
shown as the source; terminology NATO has taken from external sources may be
subject to third-party copyright. This is an unofficial aid and carries no
status — for anything authoritative, use NATOTerm and the current standards.
