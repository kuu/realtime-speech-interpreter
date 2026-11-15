# Third-party notices

This project is MIT-licensed (see `LICENSE`). It depends on third-party software that
keeps its own license. Nothing below is copied into this repository: npm packages are
installed by `npm ci` from `app/package-lock.json` and `cdk/package-lock.json`, the other
components are pulled when you build or deploy. The licenses listed come from the lock
files (`license` field of each package) and the upstream projects. Check the versions
you actually deploy.

## Direct dependencies

| Component | Used by | License |
|---|---|---|
| AWS SDK for JavaScript v3 (`@aws-sdk/client-transcribe-streaming`, `-translate`, `-polly`, `-bedrock-runtime`) | app | Apache-2.0 |
| `livekit-server-sdk` | app | Apache-2.0 |
| `@livekit/rtc-node` (native Rust bindings, `@livekit/rtc-ffi-bindings-*`) | app | Apache-2.0 |
| `tsx`, `@types/node` | app (dev) | MIT |
| `typescript` | app and cdk (dev) | Apache-2.0 |
| `aws-cdk-lib`, `constructs`, `aws-cdk` (CLI) | cdk | Apache-2.0 |
| `ts-node` | cdk (dev) | MIT |

## Transitive npm dependencies (summary of the lock files)

| License | app | cdk |
|---|---|---|
| Apache-2.0 | 41 | 10 |
| MIT | 59 | 28 |
| ISC | 3 | 5 |
| BSD-3-Clause | 1 | 1 |
| 0BSD | 1 | 0 |
| BlueOak-1.0.0 | 0 | 1 |
| Apache-2.0 AND BSD-3-Clause (`@bufbuild/protobuf`) | 1 | 0 |
| MIT OR GPL-3.0-or-later (`case`, bundled in `aws-cdk-lib`; used here under MIT) | 0 | 1 |

Regenerate the table with:

```
node -e 'const p=require("./package-lock.json").packages;const c={};for(const[k,v]of Object.entries(p)){if(k)c[v.license||"none"]=(c[v.license||"none"]||0)+1}console.log(c)'
```

(run inside `app/` or `cdk/`).

## Components that are not part of this repository

| Component | How it is used | License |
|---|---|---|
| ffmpeg (with libsrt and libopus) | Installed from the Debian packages (`apt-get install ffmpeg`) while building the app Docker image (`app/Dockerfile`). Not redistributed here; the image you build contains it. Debian's ffmpeg build is licensed under GPL/LGPL terms (see the Debian package copyright file). The app runs it as a separate process. | LGPL-2.1+ / GPL-2+ (Debian build) |
| Debian `node:22-bookworm-slim` base image | Docker base image of the app | Mixed (Debian packages and Node.js MIT) |
| LiveKit server (`livekit/livekit-server`, tag set by `livekitImage` in `cdk/cdk.json`) | Container started on the EC2 instance | Apache-2.0 |
| Caddy (`caddy`, tag set by `caddyImage` in `cdk/cdk.json`) | TLS reverse proxy container on the same instance | Apache-2.0 |
| `livekit-client` (JavaScript SDK) | Loaded by the listener web page from the jsDelivr CDN at run time (`app/web/`) | Apache-2.0 |
| Amazon Linux 2023 | AMI of the LiveKit instance | Mixed open-source licenses |

## Trademarks

AWS, Amazon Transcribe, Amazon Translate, Amazon Polly, Amazon Bedrock, AWS Fargate and
AWS Elemental product names are trademarks of Amazon.com, Inc. or its affiliates. LiveKit
is a trademark of its owner. They are used only to name the products this project works
with. This project is not affiliated with, endorsed by or sponsored by them.
