"""
e-Tax の手続の XSD（spec/etax）が読み込む様式の一覧を出す（様式の ID・様式名・中のシート）。
新しい版の XSD を入れたら動かし、spec/etax/coverage.md の対応表と見比べる
使い方: python3 -I scripts/etax_procedure_forms.py shotoku/RKO0010-250.xsd
"""
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "spec", "etax")
XS = "{http://www.w3.org/2001/XMLSchema}"


def form_name(path: str) -> str:
    """XSD の注記の「様式名：」（空白はまとめる）"""
    with open(path, encoding="utf-8") as f:
        m = re.search(r"様式名：(.*)", f.read())
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""


def sheets(path: str, form: str) -> list[str]:
    """様式の中のシート（KOA020-1 など）と、その注記の名前"""
    root = ET.parse(path).getroot()
    out = []
    for el in root.iter(XS + "element"):
        name = el.get("name") or ""
        if re.fullmatch(rf"{form}-\d+", name):
            info = el.find(f"{XS}annotation/{XS}appinfo")
            out.append(f"{name} {(info.text or '').strip().strip('\"') if info is not None else ''}".strip())
    return out


def main(rel: str):
    proc = os.path.join(SPEC, rel)
    folder = os.path.dirname(proc)
    with open(proc, encoding="utf-8") as f:
        ids = sorted(set(re.findall(r'ref="([A-Z]{3}\d{3})-', f.read())))
    for form in ids:
        files = sorted(x for x in os.listdir(folder) if x.startswith(form + "-"))
        if not files:
            print(f"{form}\t（XSD が無い）")
            continue
        path = os.path.join(folder, files[-1])
        print(f"{form}\t{form_name(path)}")
        parts = sheets(path, form)
        if len(parts) > 1:
            for p in parts:
                print(f"\t{p}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("使い方: python3 -I scripts/etax_procedure_forms.py shotoku/RKO0010-250.xsd")
    main(sys.argv[1])
