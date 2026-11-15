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
}

/**
 * Boot script for the LiveKit SFU host (Amazon Linux 2023):
 * - LiveKit signaling (7880) is bound to 127.0.0.1 only; Caddy terminates TLS on 443
 *   (Let's Encrypt via TLS-ALPN-01, so port 80 is never needed) and proxies to it.
 * - RTC media uses the TCP fallback port and the UDP range, advertised on the EIP.
 * - API key/secret are fetched from Secrets Manager at boot; no secret is in user data.
 */
export function buildLiveKitUserData(p: LiveKitUserDataProps): ec2.UserData {
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
    "EOF",
    // Container runs as root; the config file stays mode 600.
    `docker run -d --name livekit --restart unless-stopped --network host ${awslogs("livekit")} ` +
      `-v /etc/livekit/livekit.yaml:/etc/livekit.yaml:ro ${p.livekitImage} --config /etc/livekit.yaml`,
    `docker run -d --name caddy --restart unless-stopped --network host ${awslogs("caddy")} ` +
      `-v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro -v caddy_data:/data -v caddy_config:/config ${p.caddyImage}`,
  );
  return ud;
}
