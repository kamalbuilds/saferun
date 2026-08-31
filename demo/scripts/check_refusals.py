"""Check every refusal string in the blog table against the TypeScript source.

The gate messages are built with template-literal concatenation across lines
(`"a " + "b"`), so the source is normalised by removing the concatenation
joints before comparing.
"""
import pathlib
import re

post = pathlib.Path("demo/BLOG-POST.md").read_text()
src = (
    pathlib.Path("mcp-server/src/simulate.ts").read_text()
    + pathlib.Path("mcp-server/src/execute.ts").read_text()
)

JOINT = re.compile(r"`\s*\+\s*\n?\s*`")
joined = JOINT.sub("", src)


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


srcn = norm(joined)
rows = re.findall(r"\| `(REFUSED:[^`]+)` \|", post)
print(f"{len(rows)} refusal strings found in the blog table\n")
bad = 0
for r in rows:
    ok = norm(r) in srcn
    bad += not ok
    print(("OK   " if ok else "MISS ") + r[:100])
print(f"\n{len(rows) - bad}/{len(rows)} match the source verbatim")
raise SystemExit(1 if bad else 0)
