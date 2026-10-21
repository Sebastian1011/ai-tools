FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download gopkg.in/yaml.v3
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /sumorp .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && addgroup -g 65532 app && adduser -D -H -u 65532 -G app app && mkdir /data && chown app:app /data
COPY --from=build /sumorp /usr/local/bin/sumorp
USER app
EXPOSE 8765
VOLUME /data
ENTRYPOINT ["/usr/local/bin/sumorp"]
CMD ["serve"]
