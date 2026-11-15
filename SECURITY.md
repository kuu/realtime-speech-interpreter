# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

1. Use GitHub's private vulnerability reporting: the **Security** tab of
   https://github.com/kuu/realtime-speech-interpreter, then **Report a vulnerability**.
2. If that is not available, write to miyazaqui@gmail.com.

This is a personal project maintained in spare time. There is no response-time guarantee, but reports are read.

## Scope

Reports about this repository's code and CDK templates are welcome. Problems in AWS services, LiveKit or other
dependencies belong to their own maintainers. See [docs/security.md](docs/security.md) for the exposure model
(public listener page, SRT limited to the venue IP, secrets in Secrets Manager).

## Never post in an issue

Account IDs, access keys, SRT passphrases, LiveKit keys, venue IP addresses, or recordings.
