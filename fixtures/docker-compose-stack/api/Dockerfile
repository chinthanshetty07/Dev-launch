FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -o /hello .

FROM alpine:3.20
COPY --from=build /hello /hello
EXPOSE 8080
CMD ["/hello"]
