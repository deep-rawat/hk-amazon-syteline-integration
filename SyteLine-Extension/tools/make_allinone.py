"""Combine src/*.cs into dist/HubKor.AmazonSync.AllInOne.cs for SyteLine 'Build From Source'.

Run from anywhere:  python tools/make_allinone.py
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ["AmazonSyncExt.cs", "AmazonSpApiClient.cs", "AmazonConfig.cs", "Json.cs"]

usings, bodies = set(), []
for name in FILES:
    text = (ROOT / "src" / name).read_text(encoding="utf-8")
    usings.update(u.strip() for u in re.findall(r"^using [\w.]+;\s*$", text, flags=re.M))
    text = re.sub(r"^using [\w.]+;\s*\n", "", text, flags=re.M)
    body = re.search(r"namespace HubKor\.AmazonSync\s*\{\n(.*)\}\s*$", text, flags=re.S).group(1)
    bodies.append("    // ===== src/" + name + " =====\n" + body.rstrip())

out = ("// AUTO-GENERATED from src/*.cs for SyteLine 'Build From Source'. Edit src/, then run tools/make_allinone.py.\n"
       + "\n".join(sorted(usings)) + "\n\nnamespace HubKor.AmazonSync\n{\n" + "\n\n".join(bodies) + "\n}\n")
target = ROOT / "dist" / "HubKor.AmazonSync.AllInOne.cs"
target.parent.mkdir(exist_ok=True)
target.write_text(out, encoding="utf-8", newline="\n")
print("wrote", target, "-", out.count("\n"), "lines")
