#!/usr/bin/env python3
"""Minimal git "dumb HTTP" server that behaves like a real GitHub mirror.

Why this exists
---------------
Verifying downloader layer 4 needs github.com to be unreachable, which cannot be
forced reliably (real connectivity here is intermittent). So instead we point the
downloader at a local mirror and use a host that cannot resolve.

A real mirror (gh-proxy et al.) receives a URL like

    https://gh-proxy.com/https://github.com/owner/repo.git

i.e. the original URL is appended to the mirror base, and the mirror STRIPS its
own prefix before fetching. That is exactly what this server does: it removes the
leading "/https:/<host>/" or "/https://<host>/" segment and serves the remainder
from a local directory.

This is also why the filesystem does not need a directory literally named
"https:" - which Windows would reject anyway.

Usage: gitmirror.py <port> <serve_dir> [--strip-prefix /https:/HOST/]
"""

import http.server
import os
import posixpath
import socketserver
import sys
import urllib.parse


class Handler(http.server.SimpleHTTPRequestHandler):
    strip_prefixes: list[str] = []
    quiet = False

    def __init__(self, *args, **kwargs):
        # SimpleHTTPRequestHandler derives its `directory` from the process CWD
        # unless one is passed, which would silently override the serve root set
        # on the class. Pass it through explicitly.
        kwargs["directory"] = Handler.directory
        super().__init__(*args, **kwargs)

    def translate_path(self, path: str) -> str:
        path = path.split("?", 1)[0].split("#", 1)[0]
        path = urllib.parse.unquote(path)

        # Emulate a mirror: drop its own prefix, i.e. "/https:/".
        original = path
        for prefix in self.strip_prefixes:
            if path.startswith(prefix):
                path = "/" + path[len(prefix):]
                break

        # What remains is "<host>/<owner>/<repo>.git/...". A real mirror resolves
        # the host itself and serves <owner>/<repo>.git, so drop the host segment.
        segments = [p for p in path.split("/") if p]
        if segments:
            segments = segments[1:]

        if not self.quiet:
            sys.stderr.write(f"[gitmirror] {original} -> {segments}\n")
            sys.stderr.flush()
        return os.path.join(self.directory, *segments)

    def log_message(self, fmt, *args):
        if not self.quiet:
            sys.stderr.write("[gitmirror] %s\n" % (fmt % args))
            sys.stderr.flush()


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    port = int(sys.argv[1])
    directory = os.path.abspath(sys.argv[2])
    Handler.directory = directory
    Handler.strip_prefixes = ["/https:/", "/https://", "/http:/", "/http://"]
    Handler.quiet = os.environ.get("GITMIRROR_QUIET") == "1"

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler) as httpd:
        print(f"gitmirror serving {directory} on http://127.0.0.1:{port}", flush=True)
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
