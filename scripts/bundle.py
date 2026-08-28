#!/usr/bin/env python3
"""
Inline the app and its data into one self-contained HTML file.

index.html loads data/players.js as a separate script, which is right for local
use. For publishing or handing the file to someone else, everything has to
travel in a single document. Emits dist/draft-board.html.

Run:  python3 scripts/bundle.py [--fragment]

--fragment strips the document wrapper (doctype/html/head/body), for hosts that
supply their own shell.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, os.pardir)
SRC = os.path.join(ROOT, "index.html")
DATA = os.path.join(ROOT, "data", "players.js")
OUT_DIR = os.path.join(ROOT, "dist")


def main():
    fragment = "--fragment" in sys.argv

    with open(SRC) as f:
        html = f.read()
    with open(DATA) as f:
        data = f.read()

    tag = '<script src="data/players.js"></script>'
    if tag not in html:
        print("ERROR: could not find the data script tag in index.html", file=sys.stderr)
        return 1
    html = html.replace(tag, "<script>\n" + data + "</script>")

    if fragment:
        # Keep <title>, <link>, <style> and the body markup; drop the wrapper.
        head = re.search(r"<head[^>]*>(.*?)</head>", html, re.S)
        body = re.search(r"<body[^>]*>(.*?)</body>", html, re.S)
        if not head or not body:
            print("ERROR: could not split head/body", file=sys.stderr)
            return 1
        inner = head.group(1).strip()
        inner = re.sub(r'<meta[^>]*>\s*', "", inner)
        html = inner + "\n" + body.group(1).strip() + "\n"

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, "draft-board.html")
    with open(out, "w") as f:
        f.write(html)

    kb = os.path.getsize(out) / 1024
    print(f"Wrote {os.path.relpath(out)} ({kb:.0f} KB, single file"
          + (", fragment" if fragment else "") + ")", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
