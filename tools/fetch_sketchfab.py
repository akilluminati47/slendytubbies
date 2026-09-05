#!/usr/bin/env python3
"""Download the curated Slendytubbies model set from Sketchfab as glTF.

Sketchfab's download endpoint is authenticated, so you need your own API token:
  https://sketchfab.com/settings/password  ->  "API Token" (not your password)

Then:
  set SKETCHFAB_TOKEN=<token>        (PowerShell: $env:SKETCHFAB_TOKEN="<token>")
  python tools/fetch_sketchfab.py            # everything in curated.json
  python tools/fetch_sketchfab.py enemy/     # only roles starting with "enemy/"

Each model lands in assets/models/<role>/ with the glTF unzipped alongside a
LICENSE.txt recording author + licence (required by CC-BY).
"""
import json, os, sys, time, urllib.request, urllib.error, zipfile, io, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
CURATED = ROOT / "assets" / "catalog" / "curated.json"
OUT = ROOT / "assets" / "models"
TOKEN = os.environ.get("SKETCHFAB_TOKEN")


def api(url, attempts=5):
    """Sketchfab rate-limits the download endpoint hard; back off rather than fail."""
    for n in range(attempts):
        req = urllib.request.Request(url, headers={
            "Authorization": f"Token {TOKEN}",
            "User-Agent": "slendytubbies-fangame/0.1",
        })
        try:
            return json.load(urllib.request.urlopen(req))
        except urllib.error.HTTPError as e:
            if e.code != 429 or n == attempts - 1:
                raise
            wait = int(e.headers.get("Retry-After") or 0) or 15 * (n + 1)
            print(f"       429 - waiting {wait}s")
            time.sleep(wait)


def fetch(entry):
    dest = OUT / entry["role"]
    if (dest / ".done").exists():
        print(f"  skip (already have) {entry['role']}")
        return
    try:
        links = api(f"https://api.sketchfab.com/v3/models/{entry['uid']}/download")
    except urllib.error.HTTPError as e:
        print(f"  FAIL {entry['role']}: HTTP {e.code} {e.reason}")
        if e.code == 401:
            print("       -> token missing/invalid")
        elif e.code == 403:
            print("       -> author disabled download, or licence needs manual accept")
        return
    src = links.get("gltf") or links.get("glb") or links.get("usdz") or links.get("source")
    if not src:
        print(f"  FAIL {entry['role']}: no downloadable format ({list(links)})")
        return
    dest.mkdir(parents=True, exist_ok=True)
    print(f"  get  {entry['role']:<24} {src.get('size', 0)/1e6:.1f} MB")
    blob = urllib.request.urlopen(src["url"]).read()
    try:
        zipfile.ZipFile(io.BytesIO(blob)).extractall(dest)
    except zipfile.BadZipFile:
        (dest / "model.bin").write_bytes(blob)
    (dest / "LICENSE.txt").write_text(
        f"{entry['name']}\nby {entry['author']} ({entry['url']})\n"
        f"Licence: {entry['license']}\n", encoding="utf8")
    (dest / ".done").write_text(entry["uid"], encoding="utf8")


def main():
    if not TOKEN:
        sys.exit("SKETCHFAB_TOKEN is not set - see the docstring at the top of this file.")
    prefix = sys.argv[1] if len(sys.argv) > 1 else ""
    entries = [e for e in json.loads(CURATED.read_text(encoding="utf8"))
               if e["role"].startswith(prefix)]
    print(f"{len(entries)} model(s) to fetch into {OUT}")
    for e in entries:
        fetch(e)
        time.sleep(3)   # stay under the rate limit instead of racing into it


if __name__ == "__main__":
    main()
