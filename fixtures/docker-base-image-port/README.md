# docker-base-image-port

A Dockerfile with no EXPOSE of its own, on a base image (nginx) that declares port 80.
DevLaunch must read the port from the built image and serve it, not treat it as a worker.
