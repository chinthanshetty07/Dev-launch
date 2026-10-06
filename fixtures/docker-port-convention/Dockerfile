FROM alpine:3.20
RUN apk add --no-cache busybox-extras
# No EXPOSE anywhere: the server listens on $PORT, as hosted runtimes expect.
CMD ["sh", "-c", "mkdir -p /www && echo 'listening on PORT' > /www/index.html && exec httpd -f -p ${PORT:-9999} -h /www"]
