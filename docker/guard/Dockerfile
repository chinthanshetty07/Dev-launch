# DevLaunch's guard: keeps the network rules and the build process cap in place on the
# machine that runs Docker, on any engine (Colima, Docker Desktop, OrbStack, Linux).
# DevLaunch's own code only — never a repository's — and it is given no Docker socket.
FROM alpine:3.20
RUN apk add --no-cache iptables iptables-legacy util-linux-misc
COPY guard.sh /usr/local/bin/devlaunch-guard
RUN chmod 755 /usr/local/bin/devlaunch-guard
ENTRYPOINT ["/usr/local/bin/devlaunch-guard"]
