#!/usr/bin/env bash
# Rewrites the <mxfile> metadata of draw.io files (.drawio and .svg exported with
# "Include a copy of my diagram"): host becomes app.diagrams.net, and the agent, etag and
# modified attributes are removed. Files are edited in place. No dependencies except python3.
#
#   scripts/scrub-drawio.sh docs/architecture.svg docs/architecture.drawio
set -euo pipefail
if [ "$#" -eq 0 ]; then
  echo "usage: $0 FILE.drawio|FILE.svg [...]" >&2
  exit 2
fi
python3 - "$@" <<'PY'
import re, sys
# In .drawio the tag is `<mxfile ...>`; in an SVG it is HTML-escaped inside content="...": `&lt;mxfile ...&gt;`.
OPEN = r'(?:<|&lt;)mxfile\b'
def fix_tag(m):
    tag = m.group(0)
    q = r'(?:"[^"]*"|&quot;.*?&quot;|\'[^\']*\')'
    tag = re.sub(r'\s+(?:agent|etag|modified)=' + q, '', tag)
    tag = re.sub(r'(\bhost=)(?:"[^"]*"|&quot;.*?&quot;|\'[^\']*\')',
                 lambda h: h.group(1) + ('&quot;app.diagrams.net&quot;' if '&quot;' in h.group(0) else '"app.diagrams.net"'), tag)
    return tag
for path in sys.argv[1:]:
    s = open(path, encoding="utf-8").read()
    # the tag ends at the first `>` (plain) or `&gt;` (escaped), whichever starts the closing delimiter
    t = re.sub(OPEN + r'[^>]*?(?=&gt;|>)', fix_tag, s)
    if t != s:
        open(path, "w", encoding="utf-8").write(t)
        print(f"scrubbed {path}")
    else:
        print(f"unchanged {path}")
PY
