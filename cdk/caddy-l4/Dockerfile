# Custom Caddy for the RTMPS input (-c inputSource=rtmps only): official Caddy plus the caddy-l4 (layer4)
# plugin, built with xcaddy. Every input is pinned: the Caddy version, the caddy-l4 commit and both base
# images by digest. CDK builds this as a DockerImageAsset and stores it in the CDK assets ECR repository;
# the LiveKit instance pulls it. With srt or browser the stack keeps the official caddy image instead.
# Rebuild duty and how to bump the pins: README.md next to this file.
#
# The Go compiler runs on the build machine's platform and cross-compiles for the target (an Apple
# Silicon Mac builds the x86_64 image without emulating Go).
FROM --platform=$BUILDPLATFORM caddy:2.11.7-builder@sha256:c4cd20eaa0b69112fd5d4f721ffc9671687e1d5d0b155c8620cf7546dbef94c0 AS build
ARG CADDY_VERSION=v2.11.7
ARG CADDY_L4_COMMIT=1353123db5e20715b645f93874218821b42630a9
# Go module source, Go's own default. Where proxy.golang.org is unreachable, pass another proxy at build
# time (CDK: the CADDY_GOPROXY environment variable, see README.md); the checksum database
# (sum.golang.org) still verifies every module whichever proxy serves it.
ARG GOPROXY=https://proxy.golang.org,direct
ARG TARGETOS
ARG TARGETARCH
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH GOPROXY=$GOPROXY \
    xcaddy build $CADDY_VERSION \
    --with github.com/mholt/caddy-l4@$CADDY_L4_COMMIT \
    --output /usr/bin/caddy

FROM caddy:2.11.7@sha256:36c24ad91a7ff7bc4c87fe22bfa8df3c4b18da0773d73fc12ee2c52b98c0bb7e
COPY --from=build /usr/bin/caddy /usr/bin/caddy
