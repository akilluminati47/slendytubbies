#!/usr/bin/env python3
"""Static dev server that never lets the browser cache anything.

`python -m http.server` sends Last-Modified and no Cache-Control, so browsers
happily reuse ES modules across reloads - you edit a file, reload, and run the
old code. That is a miserable way to debug a game, so: no-store on everything.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Only shout about failures; 200s for 500 assets are pure noise.
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8322
    server = ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler)
    print(f"serving {sys.path[0] or '.'} on http://localhost:{port} (no-store)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
