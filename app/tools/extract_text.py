"""Text extraction for chat/mail attachments (SecondBrain, 2026-11-18).

Reads a JSON list of {"id","path","name"} from stdin and prints one JSON object per line:
{"id", "kind", "text", "error"}. Read-only: files are opened for reading, nothing is written.
Supported: PDF (pypdf), DOCX/XLSX/PPTX (zip + XML), plain text formats (md, txt, csv, json, html, xml).
Run with `python -I` so nothing from the working directory is imported.
"""
import json
import re
import sys
import zipfile
from html import unescape

MAX_CHARS = 300_000
TEXT_EXT = {"md", "txt", "csv", "tsv", "json", "html", "htm", "xml", "log", "yaml", "yml", "js", "ts", "py", "css", "sql"}


def clean(text):
    text = text.replace("\x00", " ")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()[:MAX_CHARS]


def sniff(path, name):
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    with open(path, "rb") as f:
        head = f.read(8)
    if head.startswith(b"%PDF"):
        return "pdf"
    if head.startswith(b"PK"):
        try:
            with zipfile.ZipFile(path) as z:
                names = set(z.namelist())
            if "word/document.xml" in names:
                return "docx"
            if "xl/sharedStrings.xml" in names or "xl/workbook.xml" in names:
                return "xlsx"
            if any(n.startswith("ppt/slides/slide") for n in names):
                return "pptx"
        except zipfile.BadZipFile:
            return None
        return None
    if ext in TEXT_EXT:
        return "html" if ext in {"html", "htm"} else "text"
    if not ext:
        with open(path, "rb") as f:
            sample = f.read(4096)
        try:
            decoded = sample.decode("utf-8")
        except UnicodeDecodeError:
            return None
        printable = sum(ch.isprintable() or ch in "\n\r\t" for ch in decoded)
        return "text" if decoded and printable / len(decoded) > 0.95 else None
    return None


def xml_text(data):
    data = re.sub(r"</w:p>|</a:p>|<w:br/>|<w:tab/>", "\n", data)
    return unescape(re.sub(r"<[^>]+>", " ", data))


def extract(path, name):
    kind = sniff(path, name)
    if kind is None:
        return None, ""
    if kind == "pdf":
        from pypdf import PdfReader
        reader = PdfReader(path)
        parts, total = [], 0
        for page in reader.pages:
            try:
                t = page.extract_text() or ""
            except Exception:
                t = ""
            parts.append(t)
            total += len(t)
            if total > MAX_CHARS:
                break
        return kind, clean("\n\n".join(parts))
    if kind in {"docx", "xlsx", "pptx"}:
        with zipfile.ZipFile(path) as z:
            if kind == "docx":
                members = ["word/document.xml"]
            elif kind == "xlsx":
                members = [n for n in z.namelist() if n == "xl/sharedStrings.xml"]
            else:
                members = sorted(n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n))
            text = "\n".join(xml_text(z.read(m).decode("utf-8", "replace")) for m in members)
        return kind, clean(text)
    with open(path, "rb") as f:
        raw = f.read(MAX_CHARS * 4).decode("utf-8", "replace")
    if kind == "html":
        raw = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
        raw = unescape(re.sub(r"<[^>]+>", " ", raw))
    return "text", clean(raw)


def main():
    items = json.load(sys.stdin)
    for item in items:
        out = {"id": item["id"], "kind": None, "text": "", "error": None}
        try:
            out["kind"], out["text"] = extract(item["path"], item.get("name") or "")
        except Exception as e:  # one broken file must not stop the batch
            out["error"] = f"{type(e).__name__}: {e}"[:300]
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
