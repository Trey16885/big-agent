#!/usr/bin/env python3
"""
Big Agent relay — run this in a terminal, then point the page at it.

Why this exists
---------------
TokenRouter answers the browser's CORS preflight with 403 and no
Access-Control-Allow-Origin header. The browser therefore refuses to send the
request at all and fetch() reports the useless "Failed to fetch". No web page
can call that API directly, on any host.

This relay sits in the middle. It runs on your machine, where CORS does not
apply, so it can call the API freely — and it answers the browser with the CORS
headers the browser wants. It also keeps your API key on your machine instead
of in a public page: the browser only ever sends the relay token.

    browser  --relay token-->  relay (your terminal)  --API key-->  TokenRouter

Quick start
-----------
    python3 relay.py

That prints a relay address and a relay token. Paste both into the page's
Settings. Nothing to install — Python 3.8+ and its standard library is all.

Options
-------
    --port 8787        port to listen on
    --host 127.0.0.1   use 0.0.0.0 to accept connections from other machines
    --token TOKEN      fixed relay token (default: generated, printed below)
    --key KEY          TokenRouter API key (default: $TOKENROUTER_API_KEY, else prompt)
    --no-serve         do not serve the page's files, only relay the API

By default the relay also serves the files in its own folder, so you can open
the page at the relay's own address and skip cross-origin questions entirely.
"""

import argparse
import hmac
import json
import os
import secrets
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "https://api.tokenrouter.com"
ALLOWED_PATHS = ("/v1/chat/completions",)

# The eyes model runs on the Google AI API instead of TokenRouter, so the relay
# keeps two upstreams and picks between them by model name. Google's
# OpenAI-compatible endpoint takes the same request the page already sends,
# image data URLs included, so nothing needs translating.
GOOGLE_UPSTREAM = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"

# The relay remembers the Google key so there is nothing to enter for the vision
# model after the first run. It is kept in a file beside this script rather than
# written into it: GitHub's push protection blocks commits containing a key like
# this, and rightly so — a key in the repo is a key anyone can spend. google.key
# is gitignored.
KEY_FILE = "google.key"

API_KEY = ""
GOOGLE_KEY = ""
RELAY_TOKEN = ""
SERVE_FILES = True


class Relay(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---------- CORS ----------
    def end_headers(self):
        """Every response carries CORS headers, including the static files."""
        origin = self.headers.get("Origin")
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")
        # Chrome's Private Network Access: an https:// page reaching 127.0.0.1
        # counts as public -> private, and the preflight is refused without this.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- helpers ----------
    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self):
        sent = self.headers.get("Authorization", "")
        if sent.lower().startswith("bearer "):
            sent = sent[7:]
        # compare_digest keeps a wrong token from being guessed a byte at a time
        return hmac.compare_digest(sent.strip(), RELAY_TOKEN)

    # ---------- routes ----------
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            # Unauthenticated on purpose: the page calls this to check the
            # address before it has a token to prove anything with.
            return self._json(200, {"ok": True, "relay": "big-agent", "serving": SERVE_FILES})
        if path == "/verify":
            # Checks the token without spending a request upstream, so the
            # page's Test button stays instant even when the API is congested.
            if not self._authorised():
                return self._json(401, {"ok": False, "error": "bad relay token"})
            return self._json(200, {"ok": True, "upstream": UPSTREAM})
        if not SERVE_FILES:
            return self._json(404, {"error": "this relay only handles /v1/* and /health"})
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]

        # Read the body before anything can return early. On a keep-alive
        # connection an unread body is left in the socket and the next parse
        # mistakes it for a request line, so a 401 would poison the reply
        # after it.
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, {"error": "bad Content-Length"})
        body = self.rfile.read(length) if length else b""

        if path not in ALLOWED_PATHS:
            return self._json(404, {"error": f"relay does not forward {path}"})
        if not self._authorised():
            return self._json(401, {"error": "bad or missing relay token — check Settings in the page"})

        status, payload = forward(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def handle_one_request(self):
        # Pressing Stop in the page aborts the fetch mid-flight, which drops the
        # socket while the relay is still writing. Without this the terminal
        # fills with BrokenPipeError tracebacks for an entirely normal action.
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            sys.stderr.write("  (client went away)\n")

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def route(body):
    """Which upstream owns this request. Gemma is the vision model on Google."""
    try:
        model = (json.loads(body or b"{}").get("model") or "").lower()
    except (ValueError, AttributeError):
        model = ""
    if "gemma" in model:
        return GOOGLE_UPSTREAM, GOOGLE_KEY, "google"
    return UPSTREAM + "/v1/chat/completions", API_KEY, "tokenrouter"


def forward(body):
    """Call the real API with the real key. No CORS out here."""
    url, key, name = route(body)
    if not key:
        return 500, json.dumps({"error": f"relay has no API key for {name}"}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # DNS, TLS, timeout, offline
        return 502, json.dumps({"error": f"relay could not reach {name}: {e}"}).encode()


def key_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), KEY_FILE)


def load_google_key(explicit):
    """--google-key, then $GOOGLE_API_KEY, then the remembered file."""
    if explicit:
        return explicit.strip()
    env = os.environ.get("GOOGLE_API_KEY", "").strip()
    if env:
        return env
    try:
        with open(key_path()) as f:
            return f.read().strip()
    except OSError:
        return ""


def remember_google_key(key):
    """Written 0600 so it is not world-readable on a shared machine."""
    path = key_path()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(key + "\n")
        return True
    except OSError:
        return False


def main():
    global API_KEY, GOOGLE_KEY, RELAY_TOKEN, SERVE_FILES

    p = argparse.ArgumentParser(description="Big Agent relay")
    p.add_argument("--port", type=int, default=int(os.environ.get("RELAY_PORT", 8787)))
    p.add_argument("--host", default=os.environ.get("RELAY_HOST", "127.0.0.1"))
    p.add_argument("--token", default=os.environ.get("RELAY_TOKEN", ""))
    p.add_argument("--key", default=os.environ.get("TOKENROUTER_API_KEY", ""))
    p.add_argument("--google-key", default="")
    p.add_argument("--no-serve", action="store_true")
    args = p.parse_args()

    GOOGLE_KEY = load_google_key(args.google_key)
    if not GOOGLE_KEY:
        print("The vision model runs on the Google AI API. Paste its key once and")
        print("the relay will remember it in %s for every future run." % KEY_FILE)
        try:
            GOOGLE_KEY = input("Google AI API key: ").strip()
        except (EOFError, KeyboardInterrupt):
            GOOGLE_KEY = ""
        if GOOGLE_KEY and remember_google_key(GOOGLE_KEY):
            print("Saved to %s — you will not be asked again.\n" % KEY_FILE)

    API_KEY = args.key.strip()
    if not API_KEY:
        try:
            API_KEY = input("TokenRouter API key (starts with sk-): ").strip()
        except (EOFError, KeyboardInterrupt):
            sys.exit("\nNo API key, nothing to relay.")
    if not API_KEY:
        sys.exit("No API key, nothing to relay.")

    RELAY_TOKEN = args.token.strip() or secrets.token_urlsafe(24)
    SERVE_FILES = not args.no_serve

    address = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '') else args.host}:{args.port}"
    line = "-" * 62
    print(f"\n{line}\n  Big Agent relay is up\n{line}")
    print(f"  Relay address   {address}")
    print(f"  Relay token     {RELAY_TOKEN}")
    google_state = "remembered" if GOOGLE_KEY else "MISSING — vision will not work"
    print(f"\n  Routing        gemma*  ->  Google AI API   ({google_state})")
    print(f"                 others  ->  TokenRouter")
    print(f"\n  Paste those two into Settings in the page.")
    if SERVE_FILES:
        print(f"  Or just open {address} — the relay serves the page too,")
        print(f"  which sidesteps cross-origin rules completely.")
    print(f"\n  Your API key stays in this terminal. The page never sees it.")
    print(f"  Ctrl+C to stop.\n{line}\n")

    here = os.path.dirname(os.path.abspath(__file__))
    handler = lambda *a, **kw: Relay(*a, directory=here, **kw)
    try:
        with ThreadingHTTPServer((args.host, args.port), handler) as httpd:
            httpd.serve_forever()
    except OSError as e:
        sys.exit(f"Could not listen on {args.host}:{args.port} — {e}\nTry --port 8788")
    except KeyboardInterrupt:
        print("\nRelay stopped.")


if __name__ == "__main__":
    main()
