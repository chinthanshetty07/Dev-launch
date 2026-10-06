# docker-compose-stack

A compose project DevLaunch runs from its compose file: a Go API built from source, the
official postgres:16 and redis:7 images, started in depends_on order. The API answers 200
only when it reaches both by their compose names.
