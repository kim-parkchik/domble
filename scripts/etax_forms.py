"""
e-Tax の XSD（spec/etax）から、domble が使う定義を作る。XSD を差し替えたら動かし直す
  - src/lib/etaxForms.ts：様式ごとの項目の並び（入れ子と順番。xtx は XSD の順番どおりに書く決まり）と版
  - src/constants/taxOffices.ts：税務署の一覧（国税局ごと）
使い方: python3 -I scripts/etax_forms.py
"""
import os
import re
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "spec", "etax")
XS = "{http://www.w3.org/2001/XMLSchema}"
# 消費税の申告（個人）で使う様式と XSD
FORMS = {
    "SHA010": "SHA010-010.xsd",  # 第一表・第二表（一般用）
    "SHA020": "SHA020-009.xsd",  # 第一表・第二表（簡易課税用）
    "SHB017": "SHB017-002.xsd",  # 付表1-3
    "SHB033": "SHB033-002.xsd",  # 付表2-3
    "SHB047": "SHB047-001.xsd",  # 付表4-3
    "SHB067": "SHB067-001.xsd",  # 付表5-3
    "SHB070": "SHB070-001.xsd",  # 付表6
}


def form_tree(path: str) -> tuple[str, str]:
    root = ET.parse(path).getroot()
    types = {t.get("name"): t for t in root.findall(XS + "complexType")}

    def walk(el) -> list[str]:
        out = []
        for child in el:
            if child.tag in (XS + "sequence", XS + "choice", XS + "all"):
                out += walk(child)
                continue
            if child.tag != XS + "element":
                continue
            ct = child.find(XS + "complexType")
            t = child.get("type") or ""
            kids = walk(ct) if ct is not None else walk(types[t]) if t in types else []
            # 中身のある要素だけを子に持つ型（グループ）は括弧で入れ子に。値の要素（金額・区分・参照）は名前だけ
            out.append(f"{child.get('name')}({' '.join(kids)})" if kids and not is_value_type(t) else child.get("name"))
        return out

    group = root.find(XS + "group")
    form = group.find(f"{XS}sequence/{XS}element")
    body = walk(form.find(XS + "complexType"))
    vr = root.find(f"{XS}simpleType[@name='{form.get('name')}-{vr_suffix(root, form.get('name'))}VRtype']")
    version = vr.find(f"{XS}restriction/{XS}enumeration").get("value")
    return " ".join(body), version


def is_value_type(t: str) -> bool:
    """区分（Rtype）・参照（IDREFtype・gen:*ref）・金額などは値の要素"""
    return t.endswith("Rtype") or t.endswith("IDREFtype") or t.startswith("gen:")


def vr_suffix(root, name: str) -> str:
    for st in root.findall(XS + "simpleType"):
        n = st.get("name") or ""
        if n.startswith(name + "-") and n.endswith("VRtype"):
            return n[len(name) + 1 : -len("VRtype")]
    raise SystemExit(f"{name} の版が見つかりません")


def write_forms():
    lines = [
        "/**",
        " * e-Tax の様式ごとの項目の並び（spec/etax の XSD から scripts/etax_forms.py で作ったもの。手で直さない）",
        " * 「タグ(子 子 …)」の入れ子。xtx は XSD の順番どおりに書く決まりのため、書き出しはこの順番に従う",
        " */",
        "export const FORM_TREES: Record<string, string> = {",
    ]
    versions = []
    for form, file in FORMS.items():
        tree, version = form_tree(os.path.join(SPEC, "shohi", file))
        lines.append(f'  {form}: "{tree}",')
        versions.append(f'{form}: "{version}"')
    lines.append("};")
    lines.append("")
    lines.append("/** 様式の版（VR 属性） */")
    lines.append(f"export const FORM_VERSIONS: Record<string, string> = {{ {', '.join(versions)} }};")
    write("src/lib/etaxForms.ts", lines)


def write_offices():
    text = open(os.path.join(SPEC, "general", "zeimusho.xsd"), encoding="utf-8").read()
    entries = re.findall(r"^(\d{5}):(.+?)\s*$", text, re.M)
    bureaus: dict[str, tuple[str, list[str]]] = {}
    for code, name in entries:
        region, num = code[:2], int(code[2:])
        if region == "00":
            continue
        if num == 1:
            bureaus[region] = ("沖縄国税事務所" if name == "沖縄" else f"{name}国税局", [])
        elif num >= 100:
            bureaus[region][1].append(f"{code} {name}")
    lines = [
        "/**",
        " * 税務署の一覧（国税局ごと。e-Tax の税務署番号と名前）",
        " * spec/etax/general/zeimusho.xsd から scripts/etax_forms.py で作ったもの。手で直さない",
        " */",
        "const RAW: [string, string][] = [",
    ]
    for bureau, offices in bureaus.values():
        lines.append(f'  ["{bureau}", "{",".join(offices)}"],')
    lines += [
        "];",
        "",
        "export interface TaxOffice {",
        "  /** 税務署番号（5桁） */",
        "  code: string;",
        "  name: string;",
        "  bureau: string;",
        "}",
        "",
        "export const TAX_BUREAUS: { bureau: string; offices: TaxOffice[] }[] = RAW.map(([bureau, list]) => ({",
        "  bureau,",
        '  offices: list.split(",").map((x) => ({ code: x.slice(0, 5), name: x.slice(6), bureau })),',
        "}));",
        "",
        "export const TAX_OFFICES: Map<string, TaxOffice> = new Map(TAX_BUREAUS.flatMap((b) => b.offices.map((o) => [o.code, o])));",
    ]
    write("src/constants/taxOffices.ts", lines)


def write(rel: str, lines: list[str]):
    with open(os.path.join(ROOT, rel), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("wrote", rel)


write_forms()
write_offices()
