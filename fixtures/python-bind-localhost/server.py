# Listens on loopback only, whatever DevLaunch asks: Docker cannot forward to it. Python
# runners get no loopback bridge (the Node runner's), so this still fails, and has to be
# named PORT_BOUND_TO_LOCALHOST rather than "not listening".
import http.server
import os

port = int(os.environ.get("PORT", "8000"))
print(f"bound to 127.0.0.1:{port}", flush=True)
http.server.HTTPServer(("127.0.0.1", port), http.server.SimpleHTTPRequestHandler).serve_forever()
