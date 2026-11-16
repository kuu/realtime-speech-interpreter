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

## Artwork

The venue microphone in `docs/architecture.drawio.svg` is the "microphone-2" icon from
[Tabler Icons](https://github.com/tabler/tabler-icons), redrawn as a draw.io stencil.

```
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Trademarks

AWS, Amazon Transcribe, Amazon Translate, Amazon Polly, Amazon Bedrock, AWS Fargate and
AWS Elemental product names are trademarks of Amazon.com, Inc. or its affiliates. LiveKit
is a trademark of its owner. They are used only to name the products this project works
with. This project is not affiliated with, endorsed by or sponsored by them.
