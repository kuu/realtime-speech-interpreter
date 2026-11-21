import * as ec2 from "aws-cdk-lib/aws-ec2";

export interface LiveKitUserDataProps {
  region: string;
  /** Secrets Manager ARN holding JSON { apiKey, apiSecret }. Only the ARN is embedded. */
  livekitSecretArn: string;
  /** Public Elastic IP (token) advertised to WebRTC clients. */
  publicIp: string;
  /** Hostname Caddy obtains a Let's Encrypt cert for (e.g. <ip>.sslip.io). */
  hostname: string;
  logGroupName: string;
  livekitImage: string;
  caddyImage: string;
  tcpPort: number;
  udpPortStart: number;
  udpPortEnd: number;
  /** RTMPS input (inputSource=rtmps only). Absent: the boot script is exactly the SRT/browser one. */
  rtmps?: LiveKitRtmpsProps;
}

export interface LiveKitRtmpsProps {
  /** SNI name of the RTMPS route, rtmps.<ip>.sslip.io. */
  name: string;
  /** Venue CIDRs: only these source addresses may use the RTMPS route (checked by Caddy before TLS). */
  venueCidrs: string[];
  /** host:port of the plain RTMP upstream (the NLB TCP listener). */
  upstream: string;
  /** ECR image URI of the custom Caddy (caddy-l4); replaces caddyImage. */
  image: string;
}

/**
 * Caddyfile for the RTMPS input. Caddy's layer4 listener wrapper looks at the TLS ClientHello on :443 before
 * the normal HTTPS stack: a connection whose SNI is the RTMPS name (and whose ALPN is not the ACME TLS-ALPN-01
 * challenge) is taken by the RTMPS route; everything else, including the wss signaling name and every ACME
 * challenge, falls through to the HTTPS sites unchanged. Inside the route a source outside the venue CIDRs is
 * closed before the TLS handshake; the rest is decrypted and proxied as plain RTMP to the upstream.
 */
export function rtmpsCaddyfile(hostname: string, r: LiveKitRtmpsProps): string[] {
  return [
    "{",
    "  auto_https disable_redirects",
    "  servers :443 {",
    "    listener_wrappers {",
    "      layer4 {",
    "        @rtmps {",
    `          tls sni ${r.name}`,
    "          not tls alpn acme-tls/1",
    "        }",
    "        route @rtmps {",
    "          subroute {",
    `            @denied not remote_ip ${r.venueCidrs.join(" ")}`,
    "            route @denied {",
    "              close",
    "            }",
    "            route {",
    "              tls",
    `              proxy ${r.upstream}`,
    "            }",
    "          }",
    "        }",
    "      }",
    "      tls",
    "    }",
    "  }",
    "}",
    `${hostname}:443 {`,
    "  tls {",
    "    issuer acme {",
    "      disable_http_challenge",
    "    }",
    "  }",
    "  reverse_proxy 127.0.0.1:7880",
    "}",
    // Only here so Caddy obtains and renews the certificate of the RTMPS name; HTTPS requests get 404.
    `${r.name}:443 {`,
    "  tls {",
    "    issuer acme {",
    "      disable_http_challenge",
    "    }",
    "  }",
    "  respond 404",
    "}",
  ];
}

/**
 * Boot script for the LiveKit SFU host (Amazon Linux 2023):
 * - LiveKit signaling (7880) is bound to 127.0.0.1 only; Caddy terminates TLS on 443
 *   (Let's Encrypt via TLS-ALPN-01, so port 80 is never needed) and proxies to it.
 * - RTC media uses the TCP fallback port and the UDP range, advertised on the EIP.
 * - API key/secret are fetched from Secrets Manager at boot; no secret is in user data.
 */
export function buildLiveKitUserData(p: LiveKitUserDataProps): ec2.UserData {
  const r = p.rtmps;
  const ud = ec2.UserData.forLinux({ shebang: "#!/bin/bash" });
  const awslogs = (stream: string) =>
    `--log-driver awslogs --log-opt awslogs-region=${p.region} ` +
    `--log-opt awslogs-group=${p.logGroupName} --log-opt awslogs-stream=${stream}`;

  ud.addCommands(
    "set -euxo pipefail",
    "dnf install -y docker",
    "systemctl enable --now docker",
    // Fetch LiveKit API credentials (set +x so they never reach the console log).
    "set +x",
    `SECRET_JSON=$(aws secretsmanager get-secret-value --region ${p.region} --secret-id '${p.livekitSecretArn}' --query SecretString --output text)`,
    `API_KEY=$(printf '%s' "$SECRET_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["apiKey"])')`,
    `API_SECRET=$(printf '%s' "$SECRET_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["apiSecret"])')`,
    "unset SECRET_JSON",
    "mkdir -p /etc/livekit /etc/caddy",
    "umask 077",
    // Unquoted heredoc: only $API_KEY / $API_SECRET are expanded.
    "cat > /etc/livekit/livekit.yaml <<EOF",
    "port: 7880",
    'bind_addresses: ["127.0.0.1"]',
    "rtc:",
    `  tcp_port: ${p.tcpPort}`,
    `  port_range_start: ${p.udpPortStart}`,
    `  port_range_end: ${p.udpPortEnd}`,
    "  use_external_ip: false",
    `  node_ip: ${p.publicIp}`,
    "keys:",
    "  $API_KEY: $API_SECRET",
    "logging:",
    "  level: info",
    "EOF",
    "unset API_KEY API_SECRET",
    "set -x",
    "umask 022",
    "cat > /etc/caddy/Caddyfile <<'EOF'",
    ...(r
      ? rtmpsCaddyfile(p.hostname, r)
      : [
          "{",
          "  auto_https disable_redirects",
          "}",
          `${p.hostname}:443 {`,
          "  tls {",
          "    issuer acme {",
          "      disable_http_challenge",
          "    }",
          "  }",
          "  reverse_proxy 127.0.0.1:7880",
          "}",
        ]),
    "EOF",
    ...(r
      ? [
          // Custom Caddy from the CDK assets ECR repository (instance role: pull on that repository only).
          `CADDY_IMAGE='${r.image}'`,
          `aws ecr get-login-password --region ${p.region} | docker login --username AWS --password-stdin "\${CADDY_IMAGE%%/*}"`,
          'docker pull "$CADDY_IMAGE"',
          // set -e: a config Caddy rejects stops the boot here, before the container starts.
          'docker run --rm -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile',
        ]
      : []),
    // Container runs as root; the config file stays mode 600.
    `docker run -d --name livekit --restart unless-stopped --network host ${awslogs("livekit")} ` +
      `-v /etc/livekit/livekit.yaml:/etc/livekit.yaml:ro ${p.livekitImage} --config /etc/livekit.yaml`,
    `docker run -d --name caddy --restart unless-stopped --network host ${awslogs("caddy")} ` +
      `-v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro -v caddy_data:/data -v caddy_config:/config ${r ? '"$CADDY_IMAGE"' : p.caddyImage}`,
  );
  return ud;
}
