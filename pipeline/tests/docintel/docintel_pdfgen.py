"""Byte-stable synthetic PDFs generated at test time (no PDF is committed).

A tiny hand-written PDF writer: standard Helvetica (no embedded fonts),
optional CropBox, /Rotate, text render modes and an image XObject standing in
for a scanned page. Same input, same bytes: no dates, ids or randomness.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field

# Helvetica advance widths (1/1000 em) for the ASCII range we use; unknown
# characters fall back to 556, the digit width.
HELVETICA_WIDTHS = {
    " ": 278, ",": 278, ".": 278, ":": 278, "/": 278, "-": 333, "@": 1015, "$": 556, "(": 333, ")": 333,
    **{d: 556 for d in "0123456789"},
    "a": 556, "b": 556, "c": 500, "d": 556, "e": 556, "f": 278, "g": 556, "h": 556, "i": 222, "j": 222,
    "k": 500, "l": 222, "m": 833, "n": 556, "o": 556, "p": 556, "q": 556, "r": 333, "s": 500, "t": 278,
    "u": 556, "v": 500, "w": 722, "x": 500, "y": 500, "z": 500,
    "A": 667, "B": 667, "C": 722, "D": 722, "E": 667, "F": 611, "G": 778, "H": 722, "I": 278, "J": 500,
    "K": 667, "L": 556, "M": 833, "N": 722, "O": 778, "P": 667, "Q": 778, "R": 722, "S": 667, "T": 611,
    "U": 722, "V": 667, "W": 944, "X": 667, "Y": 667, "Z": 611,
}


def text_width(text: str, size: float) -> float:
    return sum(HELVETICA_WIDTHS.get(c, 556) for c in text) * size / 1000.0


@dataclass(frozen=True)
class TextRun:
    x: float
    y: float
    text: str
    size: float = 12.0
    render_mode: int = 0  # 3 = invisible


@dataclass(frozen=True)
class PageSpec:
    texts: tuple[TextRun, ...] = ()
    width: float = 612.0
    height: float = 792.0
    crop_box: tuple[float, float, float, float] | None = None
    rotate: int = 0
    image: bool = False


@dataclass
class _Writer:
    objects: list[bytes] = field(default_factory=list)

    def add(self, body: bytes) -> int:
        self.objects.append(body)
        return len(self.objects)

    def set(self, num: int, body: bytes) -> None:
        self.objects[num - 1] = body


def _escape(text: str) -> bytes:
    raw = text.encode("cp1252")
    return raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _stream(content: bytes, extra: bytes = b"") -> bytes:
    return b"<< /Length %d %s>>\nstream\n" % (len(content), extra) + content + b"\nendstream"


def build_pdf(pages: list[PageSpec]) -> bytes:
    w = _Writer()
    catalog = w.add(b"")
    pages_obj = w.add(b"")
    font = w.add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    image = w.add(
        _stream(bytes([0, 255, 255, 0]), b"/Type /XObject /Subtype /Image /Width 2 /Height 2 "
                b"/ColorSpace /DeviceGray /BitsPerComponent 8 ")
    )
    kids: list[int] = []
    for spec in pages:
        ops: list[bytes] = []
        if spec.image:
            ops.append(b"q 300 0 0 300 150 250 cm /Im1 Do Q")
        for run in spec.texts:
            ops.append(
                b"BT /F1 %s Tf %d Tr %s %s Td (%s) Tj ET"
                % (_num(run.size), run.render_mode, _num(run.x), _num(run.y), _escape(run.text))
            )
        content = w.add(_stream(b"\n".join(ops)))
        extra = b""
        if spec.crop_box:
            extra += b" /CropBox [%s]" % b" ".join(_num(v) for v in spec.crop_box)
        if spec.rotate:
            extra += b" /Rotate %d" % spec.rotate
        page = w.add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %s %s]%s "
            b"/Resources << /Font << /F1 %d 0 R >> /XObject << /Im1 %d 0 R >> >> /Contents %d 0 R >>"
            % (pages_obj, _num(spec.width), _num(spec.height), extra, font, image, content)
        )
        kids.append(page)
    w.set(catalog, b"<< /Type /Catalog /Pages %d 0 R >>" % pages_obj)
    w.set(
        pages_obj,
        b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), len(kids)),
    )
    out = io.BytesIO()
    out.write(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for i, body in enumerate(w.objects, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % i + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(w.objects) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(w.objects) + 1, catalog, xref))
    return out.getvalue()


def _num(v: float) -> bytes:
    return (b"%d" % v) if float(v).is_integer() else (b"%.2f" % v)


def encrypt(pdf: bytes, password: str = "user-pass") -> bytes:
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf)))
    writer.encrypt(user_password=password, owner_password="owner-pass", algorithm="AES-128")
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


NOTICE_LINES = (
    "Summer Research Fellowship 2027 (SAMPLE, not a real program)",
    "Open to first-year and sophomore undergraduates.",
    "Applications are due March 30, 2027 at 5:00 PM ET.",
    "Apply at https://example.org/apply or email help@example.org.",
    "Stipend: $5,000 for ten weeks. Minimum GPA 3.0.",
)


def notice_page() -> PageSpec:
    return PageSpec(texts=tuple(TextRun(72, 720 - 24 * i, line) for i, line in enumerate(NOTICE_LINES)))
