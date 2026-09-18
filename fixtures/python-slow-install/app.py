# Serves only after a long install, which is the case readiness used to misjudge.
import http.server, os, socketserver

PORT = int(os.environ.get("PORT", 8000))

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok": true, "fixture": "python-slow-install"}')
    def log_message(self, *args):
        pass

print(f"serving on 0.0.0.0:{PORT}", flush=True)
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
    httpd.serve_forever()
