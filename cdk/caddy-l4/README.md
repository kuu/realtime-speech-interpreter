# Custom Caddy image (RTMPS input only)

`Dockerfile` builds official Caddy with the [caddy-l4](https://github.com/mholt/caddy-l4) (layer4) plugin using
`xcaddy`. The stack builds it as a CDK `DockerImageAsset` and stores it in the CDK assets ECR repository **only when
`-c inputSource=rtmps`**. With `srt` or `browser` the LiveKit host runs the official `caddyImage` from `cdk.json` and
this folder is not used. Design: [docs/alternative-inputs.md](../../docs/alternative-inputs.md).

## What is pinned

| Pin | Where | Value |
|---|---|---|
| Caddy version | `ARG CADDY_VERSION` | `v2.11.7`, must equal the tag of `caddyImage` in `cdk/cdk.json` (a test checks it) |
| caddy-l4 commit | `ARG CADDY_L4_COMMIT` | full 40-character commit (caddy-l4 has no release tag for this Caddy version) |
| builder image | first `FROM` | `caddy:<version>-builder@sha256:...` (multi-architecture index digest) |
| runtime image | second `FROM` | `caddy:<version>@sha256:...` (multi-architecture index digest) |

The Go modules are verified against the Go checksum database (`sum.golang.org`), so they are fixed by the two version
pins above.

## Rebuild duty

You own this image. The official `caddy` image gets rebuilt by Docker Hub; this one changes only when you edit the pins.
When Caddy, caddy-l4 or Go publish a security release:

1. Find the digests of the new images (no pull needed):
   `docker buildx imagetools inspect caddy:<version>-builder` and `docker buildx imagetools inspect caddy:<version>`
   (use the top `Digest:` line, the multi-architecture index).
2. Update both `FROM` lines and `CADDY_VERSION`. Update `caddyImage` in `cdk/cdk.json` to the same tag. For caddy-l4,
   pick a commit on its default branch that builds with that Caddy version and update `CADDY_L4_COMMIT`.
3. Build and check locally for the instance architecture (c6i is x86_64):
   `docker build --platform linux/amd64 -t caddy-l4:test cdk/caddy-l4`, then
   `docker run --rm caddy-l4:test caddy version` and
   `docker run --rm caddy-l4:test caddy list-modules | grep layer4`.
4. `cd cdk && npm test`, then deploy with `-c inputSource=rtmps`. The new image gets a new asset hash, so the LiveKit
   instance is replaced (short outage, the Elastic IP stays).

Also watch caddy-l4's own notes: it is not part of the Caddy organization's official repositories and its README warns
that it is still in development and may change incompatibly.

## Build notes

- The Go compiler runs on the build machine's platform (`--platform=$BUILDPLATFORM`) and cross-compiles for the target,
  so an Apple Silicon Mac builds the x86_64 image without emulating Go. The first build takes several minutes (module
  download and compile); Docker caches it afterwards.
- The build downloads Go modules from `proxy.golang.org`. If that host is unreachable from your machine, set
  `CADDY_GOPROXY` for the deploy, for example `CADDY_GOPROXY="https://<your proxy>,direct" npx cdk deploy ...`. The stack
  passes it as the `GOPROXY` build argument (it changes the asset hash). The checksum database still verifies every
  module.
