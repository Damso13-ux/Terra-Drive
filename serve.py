"""Serveur de developpement.

`python -m http.server` ne gere PAS les requetes de plage (`Range`). Tant qu'on
ne sert que des modules et des images, cela ne se voit pas — mais une archive
PMTiles se lit exclusivement par plages, et le defaut se manifeste par un echec
silencieux, sans message d'erreur exploitable.

Ce serveur ajoute donc :
  - le support des requetes de plage (206 Partial Content) ;
  - les en-tetes CORS, pour servir les tuiles depuis un autre port ;
  - le type MIME des archives .pmtiles ;
  - l'absence de cache, pour ne plus recharger d'anciens modules pendant la mise
    au point (le pire piege du developpement sans etape de construction).

    python serve.py            # port 8123
    python serve.py 8200 tiles # autre port, autre dossier
"""

import os
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RANGE = re.compile(r"bytes=(\d*)-(\d*)")


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".pmtiles": "application/octet-stream",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "range, if-match")
        self.send_header("Access-Control-Expose-Headers", "content-range, content-length, etag")
        self.send_header("Accept-Ranges", "bytes")
        # Pendant la mise au point, un module en cache est une source d'erreurs
        # impossibles a diagnostiquer : on refuse tout cache.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def send_head(self):
        """Sert une plage quand le client en demande une, le fichier entier sinon."""
        header = self.headers.get("Range")
        if not header:
            return super().send_head()

        match = RANGE.match(header)
        if not match:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        size = os.fstat(f.fileno()).st_size
        first, last = match.group(1), match.group(2)

        if first == "":  # suffixe : les N derniers octets
            length = min(int(last or 0), size)
            start = size - length
            end = size - 1
        else:
            start = int(first)
            end = int(last) if last else size - 1
            end = min(end, size - 1)

        if start >= size or start > end:
            f.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None

        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        return RangeFile(f, end - start + 1)

    def log_message(self, fmt, *args):
        # une ligne par requete de plage noierait la console
        if "Range" not in self.headers:
            super().log_message(fmt, *args)


class RangeFile:
    """Enveloppe qui limite la lecture a la longueur de la plage demandee."""

    def __init__(self, f, remaining):
        self.f = f
        self.remaining = remaining

    def read(self, amount=-1):
        if self.remaining <= 0:
            return b""
        if amount < 0 or amount > self.remaining:
            amount = self.remaining
        data = self.f.read(amount)
        self.remaining -= len(data)
        return data

    def close(self):
        self.f.close()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    root = sys.argv[2] if len(sys.argv) > 2 else "."
    handler = partial(Handler, directory=root)
    print(f"Terra Drive — http://localhost:{port}  (dossier : {os.path.abspath(root)})")
    print("Requetes de plage : oui.  Cache : desactive.")
    # ThreadingHTTPServer et non HTTPServer : le navigateur garde des connexions
    # ouvertes, et un serveur mono-thread se retrouve alors incapable de servir
    # quoi que ce soit d'autre. Le symptome est un blocage total, sans erreur.
    ThreadingHTTPServer(("0.0.0.0", port), handler).serve_forever()


if __name__ == "__main__":
    main()
