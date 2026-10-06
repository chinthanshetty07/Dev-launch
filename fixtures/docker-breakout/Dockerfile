FROM alpine:3.20
# busybox-extras carries httpd, which plain Alpine's busybox does not.
RUN apk add --no-cache busybox-extras
# Probes from a build step and again from the running container. A target that answers or
# refuses within the timeout was REACHED; one that times out was BLOCKED by a rule.
RUN printf '#!/bin/sh\nfor t in 169.254.169.254 172.17.0.1 172.31.250.1 10.0.0.1 192.168.1.1; do s=$(date +%%s); nc -z -w 4 $t 80; e=$(( $(date +%%s) - s )); if [ $e -ge 4 ]; then echo "$1 BLOCKED $t"; else echo "$1 REACHED $t"; fi; done\n' > /probe && chmod +x /probe
RUN /probe BUILD
EXPOSE 8080
CMD ["sh", "-c", "/probe RUN; mkdir -p /www && echo ok > /www/index.html && exec httpd -f -p 8080 -h /www"]
