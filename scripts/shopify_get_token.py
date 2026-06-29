#!/usr/bin/env python3
"""
ONE-TIME LOCAL HELPER — mint a Shopify offline Admin API access token via OAuth.

You only run this once. It opens your browser, you approve the install, and it
prints a permanent (non-expiring) access token. Put that token in the GitHub
secret SHOPIFY_ADMIN_TOKEN and you're done — this script is never needed again.

Prereq (do this first in the Shopify Dev Dashboard for the "Inventory Pull" app):
    Add this exact redirect URL to the app's allowed redirect / callback URLs:
        http://localhost:8765/callback

Run it (PowerShell), filling in your values — paste these in the terminal, NOT in chat:
    $env:SHOPIFY_STORE="xproaccessories.myshopify.com"
    $env:SHOPIFY_CLIENT_ID="<the Client ID from the app Settings>"
    $env:SHOPIFY_CLIENT_SECRET="<the Secret from the app Settings>"
    python scripts/shopify_get_token.py
"""
import http.server
import os
import secrets
import sys
import urllib.parse
import webbrowser

import requests

STORE    = os.environ["SHOPIFY_STORE"].strip().replace("https://", "").replace("/", "")
CID      = os.environ["SHOPIFY_CLIENT_ID"].strip()
CSECRET  = os.environ["SHOPIFY_CLIENT_SECRET"].strip()
SCOPES   = os.getenv("SHOPIFY_SCOPES", "read_orders")
PORT     = 8765
REDIRECT = f"http://localhost:{PORT}/callback"
STATE    = secrets.token_hex(8)

_result: dict = {}


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404); self.end_headers(); return
        params = urllib.parse.parse_qs(parsed.query)
        _result["code"]  = params.get("code",  [None])[0]
        _result["state"] = params.get("state", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<h2>Got it. Close this tab and return to your terminal.</h2>")

    def log_message(self, *args):
        pass  # silence the default request logging


def main() -> None:
    authorize = f"https://{STORE}/admin/oauth/authorize?" + urllib.parse.urlencode({
        "client_id":    CID,
        "scope":        SCOPES,
        "redirect_uri": REDIRECT,
        "state":        STATE,
    })

    server = http.server.HTTPServer(("localhost", PORT), _Handler)
    print("\nOpening your browser to approve the install…")
    print(f"If it doesn't open, paste this URL into your browser:\n{authorize}\n")
    webbrowser.open(authorize)

    while "code" not in _result:
        server.handle_request()

    if _result.get("state") != STATE:
        sys.exit("ERROR: state mismatch — aborting for safety.")
    code = _result.get("code")
    if not code:
        sys.exit("ERROR: no authorization code returned.")

    resp = requests.post(
        f"https://{STORE}/admin/oauth/access_token",
        json={"client_id": CID, "client_secret": CSECRET, "code": code},
        timeout=30,
    )
    if not resp.ok:
        sys.exit(f"ERROR exchanging code ({resp.status_code}): {resp.text[:300]}")

    token = resp.json().get("access_token")
    print("\n" + "=" * 64)
    print("SUCCESS — your Shopify access token (put in GitHub secret SHOPIFY_ADMIN_TOKEN):")
    print(token)
    print("=" * 64)
    print("This token does not expire. Do not paste it into chat — only into the GitHub secret.")


if __name__ == "__main__":
    main()
