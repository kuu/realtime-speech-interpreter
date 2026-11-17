// Fixed plain-string props for the LiveKit user-data golden (documentation addresses, no account id).
export const UD_PROPS = {
  region: "ap-northeast-1",
  livekitSecretArn: "arn:aws:secretsmanager:ap-northeast-1:ACCOUNT:secret:lk",
  publicIp: "203.0.113.20",
  hostname: "lk.example.test",
  logGroupName: "/simul-translation/livekit",
  livekitImage: "livekit/livekit-server:v1.13.11",
  caddyImage: "caddy:2.11.7",
  tcpPort: 7881,
  udpPortStart: 50000,
  udpPortEnd: 60000,
};
