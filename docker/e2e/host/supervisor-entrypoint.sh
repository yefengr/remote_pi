#!/bin/sh
set -eu

export HOME="${HOME:-/home/pi}"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
export PI_CODING_AGENT_SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-$PI_CODING_AGENT_DIR/sessions}"
export PI_OFFLINE=1
export PI_TELEMETRY=0
export REMOTE_PI_ALLOW_FILE_IDENTITY=1
# REMOTE_PI_HOME is the root that contains .pi; HOME already supplies this
# default and avoids creating a duplicated ~/.pi/.pi supervisor socket.
unset REMOTE_PI_HOME

mkdir -p "$HOME/.pi/remote" "$PI_CODING_AGENT_DIR" "$PI_CODING_AGENT_SESSION_DIR" /workspace
cat > "$PI_CODING_AGENT_DIR/settings.json" <<'EOF'
{
  "packages": ["/opt/remote-pi"]
}
EOF

exec node /opt/remote-pi/dist/bin/supervisord.js
