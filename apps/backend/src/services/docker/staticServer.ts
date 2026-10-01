/**
 * DevLaunch's static file server: Python's `http.server`, with one difference.
 *
 * A browser asks every site for `/favicon.ico` on its own, whether the page links one or
 * not. A repository of plain HTML with no icon — most of them — then showed
 * `favicon.ico: 404 (File not found)` in the console of a page that was working, for a
 * request the page never made. DevLaunch chose the server, so the answer is DevLaunch's
 * to give: when the file is absent, `204 No Content` — nothing to show, and nothing failed.
 *
 * Nothing else changes. A `favicon.ico` the repository has is served as `http.server`
 * serves it, and every other missing file is still an honest 404; the listing, the bind
 * (every interface) and the request log are `http.server`'s own. No icon is invented: a
 * page without one keeps the browser's blank tab.
 *
 * Installed beside the wrapper and after the repository, like the generated requirements
 * file, so a repository cannot shadow it; and only when the plan's start command names
 * it, so a plan cannot use the path to carry anything else.
 */
export const STATIC_SERVER_SCRIPT = `"""DevLaunch's static file server: http.server, answering a missing /favicon.ico with 204."""
import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path == "/favicon.ico" and not os.path.isfile(self.translate_path(path)):
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        return super().send_head()


if __name__ == "__main__":
    http.server.test(HandlerClass=Handler, port=int(sys.argv[1]) if len(sys.argv) > 1 else 8000)
`;
