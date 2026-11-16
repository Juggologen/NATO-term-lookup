"""Helvetica (Adobe AFM) advance widths, 1/1000 em, for the glyphs the PDF uses."""
_W = {}
def _add(chars, w):
    for c in chars:
        _W[c] = w

_add(" ", 278); _add("!", 278); _add('"', 355); _add("#", 556); _add("$", 556)
_add("%", 889); _add("&", 667); _add("'", 191); _add("(", 333); _add(")", 333)
_add("*", 389); _add("+", 584); _add(",", 278); _add("-", 333); _add(".", 278)
_add("/", 278); _add("0123456789", 556); _add(":", 278); _add(";", 278)
_add("<", 584); _add("=", 584); _add(">", 584); _add("?", 556); _add("@", 1015)
_add("ABDEFHKNPRSTUVXYZ", 0)  # placeholder, overwritten below
for c, w in zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ",
                [667,667,722,722,667,611,778,722,278,500,667,556,833,
                 722,778,667,778,722,667,611,722,667,944,667,667,611]):
    _W[c] = w
_add("[", 278); _add("\\", 278); _add("]", 278); _add("^", 469); _add("_", 556); _add("`", 333)
for c, w in zip("abcdefghijklmnopqrstuvwxyz",
                [556,556,500,556,556,278,556,556,222,222,500,222,833,
                 556,556,556,556,333,500,278,556,500,722,500,500,500]):
    _W[c] = w
_add("{", 334); _add("|", 260); _add("}", 334); _add("~", 584)
_add("àáâãäå", 556)        # a-accents
_add("èéêë", 556)                     # e-accents
_add("ìíîï", 278)                     # i-accents
_add("òóôõö", 556)               # o-accents
_add("ùúûü", 556)                     # u-accents
_add("ç", 500); _add("ñ", 556)
_add("ýÿ", 500)
_add("ÀÁÂÃÄÅ", 667)
_add("ÈÉÊË", 667)
_add("ÌÍÎÏ", 278)
_add("ÒÓÔÕÖ", 778)
_add("ÙÚÛÜ", 722)
_add("Ç", 722); _add("Ñ", 722)
_add("Æ", 1000); _add("æ", 889)
_add("Œ", 944); _add("œ", 944)
_add("ß", 611); _add("ø", 611); _add("Ø", 778)
_add("°", 400); _add("«", 556); _add("»", 556)
_add("–", 556); _add("—", 1000)
_add("‘’", 222); _add("“”", 333)
_add("…", 1000); _add("·", 278); _add("€", 556)
_add(" ", 278); _add("±", 584); _add("×", 584)
_add("©", 737); _add("®", 737); _add("§", 556); _add("¶", 537)

DEFAULT = 556
SCALE = 16.5 / 1000.0   # Helvetica 11pt rendered at 1.5x


def em(text):
    return sum(_W.get(c, DEFAULT) for c in text)


def px(text):
    """Rendered width in the same pixel units pdftohtml -xml reports."""
    return em(text) * SCALE
