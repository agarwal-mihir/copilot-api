#!/bin/sh
set -eu

test "$(uname -s)" = "Darwin" || {
  echo "This setup script supports macOS only." >&2
  exit 1
}

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
bun_path=$(command -v bun) || {
  echo "Bun is required: https://bun.sh" >&2
  exit 1
}
codex_path=$(command -v codex) || {
  echo "Codex CLI is required." >&2
  exit 1
}
chatgpt_app="/Applications/ChatGPT.app"
test -x "$chatgpt_app/Contents/MacOS/ChatGPT" || {
  echo "Install the official ChatGPT/Codex desktop app first." >&2
  exit 1
}
if /usr/bin/curl \
  --noproxy "*" \
  --silent \
  --max-time 1 \
  --output /dev/null \
  "http://127.0.0.1:4141/"; then
  echo "Stop the existing service on 127.0.0.1:4141 before setup." >&2
  exit 1
fi

gateway_home="$HOME/.local/share/copilot-api"
gateway_config="$gateway_home/config.json"
copilot_home="$HOME/.codex-copilot"
bin_dir="$HOME/.local/bin"
runtime_dir="$HOME/.local/state/copilot-api"
launcher_dir="$gateway_home/launchers"
applications_dir="$HOME/Applications"

umask 077
mkdir -p \
  "$gateway_home" \
  "$copilot_home" \
  "$bin_dir" \
  "$runtime_dir" \
  "$launcher_dir" \
  "$applications_dir"

cd "$repo_root"
"$bun_path" install --frozen-lockfile
"$bun_path" run build

COPILOT_API_CONFIG="$gateway_config" /usr/bin/python3 <<'PY'
import json
import os
import secrets
import tempfile

path = os.environ["COPILOT_API_CONFIG"]
try:
    with open(path) as file:
        raw = file.read().strip()
except FileNotFoundError:
    raw = ""

config = json.loads(raw) if raw else {}
if not isinstance(config, dict):
    raise SystemExit("Gateway config must be a JSON object.")

auth = config.get("auth")
if auth is None:
    auth = {}
elif not isinstance(auth, dict):
    raise SystemExit("Gateway auth config must be a JSON object.")

keys = auth.get("apiKeys")
if not isinstance(keys, list):
    keys = []
keys = [key.strip() for key in keys if isinstance(key, str) and key.strip()]
if not keys:
    keys = [f"gw_{secrets.token_urlsafe(32)}"]

auth["apiKeys"] = list(dict.fromkeys(keys))
config.update(
    {
        "auth": auth,
        "copilotOnly": True,
        "copilotAllowedModels": [
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "claude-opus-5",
        ],
        "smallModel": "gpt-5.6-luna",
        "alphaSearchCodexPriority": False,
        "alphaSearchModel": "gpt-5.6-luna",
        "messageApiWebSearchModel": "gpt-5.6-luna",
        "modelMappings": {},
    }
)

directory = os.path.dirname(path)
fd, temporary = tempfile.mkstemp(dir=directory)
try:
    with os.fdopen(fd, "w") as file:
        json.dump(config, file, indent=2)
        file.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY

if test ! -f "$copilot_home/config.toml"; then
  gateway_config_toml=$(
    /usr/bin/python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' \
      "$gateway_config"
  )
  cat >"$copilot_home/config.toml" <<EOF
model = "gpt-5.6-sol"
model_provider = "copilot_api"
model_context_window = 272000
model_auto_compact_token_limit = 244800
model_reasoning_effort = "max"

[model_providers.copilot_api]
name = "OpenAI"
base_url = "http://127.0.0.1:4141"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

[model_providers.copilot_api.auth]
command = "/usr/bin/plutil"
args = ["-extract", "auth.apiKeys.0", "raw", "-o", "-", $gateway_config_toml]
timeout_ms = 5000
refresh_interval_ms = 300000

[features]
remote_compaction_v2 = true
apps = false
use_agent_identity = false

[analytics]
enabled = false

[tui.model_availability_nux]
"gpt-5.5" = 4
EOF
  chmod 600 "$copilot_home/config.toml"
else
  echo "Preserving existing $copilot_home/config.toml"
fi

shell_quote() {
  /usr/bin/python3 -c 'import shlex, sys; print(shlex.quote(sys.argv[1]))' "$1"
}

repo_root_q=$(shell_quote "$repo_root")
bun_path_q=$(shell_quote "$bun_path")
codex_path_q=$(shell_quote "$codex_path")

cat >"$bin_dir/codex-copilot" <<EOF
#!/bin/sh
set -eu

repo_root=$repo_root_q
bun_path=$bun_path_q
codex_path=$codex_path_q
gateway_config="\$HOME/.local/share/copilot-api/config.json"
gateway_log="\$HOME/.local/state/copilot-api/server.log"
gateway_error_log="\$HOME/.local/state/copilot-api/server.err.log"
gateway_pid=""

if test "\$PWD" = "\$HOME"; then
  mkdir -p "\$HOME/.codex-copilot/workspace"
  cd "\$HOME/.codex-copilot/workspace"
fi

cleanup() {
  trap - EXIT HUP INT TERM
  if test -n "\$gateway_pid" && /bin/kill -0 "\$gateway_pid" 2>/dev/null; then
    /bin/kill "\$gateway_pid"
    wait "\$gateway_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

gateway_ready() {
  key=\$(/usr/bin/plutil -extract auth.apiKeys.0 raw -o - "\$gateway_config") || return 1
  printf 'url = "http://127.0.0.1:4141/v1/models"\nheader = "Authorization: Bearer %s"\n' "\$key" |
    /usr/bin/curl --config - --noproxy "*" --fail --silent --max-time 5 |
    /usr/bin/python3 -c 'import json, sys
expected = {"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "claude-opus-5"}
try:
    data = json.load(sys.stdin).get("data", [])
    actual = {item["id"] for item in data}
except (AttributeError, KeyError, TypeError, ValueError):
    raise SystemExit(1)
raise SystemExit(0 if actual == expected else 1)'
}

gateway_responding() {
  key=\$(/usr/bin/plutil -extract auth.apiKeys.0 raw -o - "\$gateway_config") || return 1
  printf 'url = "http://127.0.0.1:4141/v1/models"\nheader = "Authorization: Bearer %s"\n' "\$key" |
    /usr/bin/curl --config - --noproxy "*" --silent --max-time 2 --output /dev/null
}

if gateway_responding && ! gateway_ready; then
  echo "Port 4141 is occupied by an incompatible gateway. Stop it before continuing." >&2
  exit 1
fi

if ! gateway_ready; then
  "\$bun_path" --use-system-ca "\$repo_root/dist/main.js" start \
    >>"\$gateway_log" 2>>"\$gateway_error_log" &
  gateway_pid=\$!
fi

attempt=0
until gateway_ready; do
  attempt=\$((attempt + 1))
  if test "\$attempt" -ge 30; then
    echo "The local Copilot gateway did not become ready. See \$gateway_error_log" >&2
    exit 1
  fi
  /bin/sleep 1
done

CODEX_HOME="\$HOME/.codex-copilot" "\$codex_path" "\$@"
EOF

cat >"$bin_dir/codex-app-openai" <<EOF
#!/bin/sh
set -eu
exec /usr/bin/open -n -a "$chatgpt_app" --env "CODEX_HOME=\$HOME/.codex"
EOF

cat >"$bin_dir/copilot-usage" <<EOF
#!/bin/sh
set -eu
exec $bun_path_q --use-system-ca $repo_root_q/dist/main.js usage
EOF

cat >"$bin_dir/codex-app-copilot" <<EOF
#!/bin/sh
set -eu

repo_root=$repo_root_q
bun_path=$bun_path_q
gateway_config="\$HOME/.local/share/copilot-api/config.json"
gateway_log="\$HOME/.local/state/copilot-api/server.log"
gateway_error_log="\$HOME/.local/state/copilot-api/server.err.log"
gateway_pid=""

cleanup() {
  trap - EXIT HUP INT TERM
  if test -n "\$gateway_pid" && /bin/kill -0 "\$gateway_pid" 2>/dev/null; then
    /bin/kill "\$gateway_pid"
    wait "\$gateway_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

gateway_ready() {
  key=\$(/usr/bin/plutil -extract auth.apiKeys.0 raw -o - "\$gateway_config") || return 1
  printf 'url = "http://127.0.0.1:4141/v1/models"\nheader = "Authorization: Bearer %s"\n' "\$key" |
    /usr/bin/curl --config - --noproxy "*" --fail --silent --max-time 5 |
    /usr/bin/python3 -c 'import json, sys
expected = {"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "claude-opus-5"}
try:
    data = json.load(sys.stdin).get("data", [])
    actual = {item["id"] for item in data}
except (AttributeError, KeyError, TypeError, ValueError):
    raise SystemExit(1)
raise SystemExit(0 if actual == expected else 1)'
}

gateway_responding() {
  key=\$(/usr/bin/plutil -extract auth.apiKeys.0 raw -o - "\$gateway_config") || return 1
  printf 'url = "http://127.0.0.1:4141/v1/models"\nheader = "Authorization: Bearer %s"\n' "\$key" |
    /usr/bin/curl --config - --noproxy "*" --silent --max-time 2 --output /dev/null
}

if gateway_responding && ! gateway_ready; then
  echo "Port 4141 is occupied by an incompatible gateway. Stop it before continuing." >&2
  exit 1
fi

if ! gateway_ready; then
  "\$bun_path" --use-system-ca "\$repo_root/dist/main.js" start \
    >>"\$gateway_log" 2>>"\$gateway_error_log" &
  gateway_pid=\$!
fi

attempt=0
until gateway_ready; do
  attempt=\$((attempt + 1))
  if test "\$attempt" -ge 30; then
    echo "The local Copilot gateway did not become ready. See \$gateway_error_log" >&2
    exit 1
  fi
  /bin/sleep 1
done

/usr/bin/open -n -a "$chatgpt_app" --env "CODEX_HOME=\$HOME/.codex-copilot"

if test -n "\$gateway_pid"; then
  echo "Copilot gateway is running. Keep this window open; press Control-C when finished."
  wait "\$gateway_pid"
fi
EOF

chmod 700 \
  "$bin_dir/codex-copilot" \
  "$bin_dir/copilot-usage" \
  "$bin_dir/codex-app-openai" \
  "$bin_dir/codex-app-copilot"

cat >"$launcher_dir/ChatGPT OpenAI.command" <<EOF
#!/bin/sh
exec "\$HOME/.local/bin/codex-app-openai"
EOF
cat >"$launcher_dir/ChatGPT Copilot.command" <<EOF
#!/bin/sh
exec "\$HOME/.local/bin/codex-app-copilot"
EOF
chmod 700 \
  "$launcher_dir/ChatGPT OpenAI.command" \
  "$launcher_dir/ChatGPT Copilot.command"

create_shortcut() {
  shortcut_name=$1
  bundle_id=$2
  command_path=$3
  app_path="$applications_dir/$shortcut_name.app"

  existing_bundle_id=$(
    /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
      "$app_path/Contents/Info.plist" 2>/dev/null || true
  )
  if test -n "$existing_bundle_id"; then
    bundle_id=$existing_bundle_id
  fi

  rm -rf "$app_path"
  /usr/bin/osacompile -o "$app_path" \
    -e "do shell script \"/usr/bin/open \" & quoted form of \"$command_path\""
  /usr/libexec/PlistBuddy \
    -c "Add :CFBundleIdentifier string $bundle_id" \
    -c "Set :CFBundleName $shortcut_name" \
    -c "Add :CFBundleDisplayName string $shortcut_name" \
    -c "Add :LSUIElement bool true" \
    "$app_path/Contents/Info.plist"
  cp "$chatgpt_app/Contents/Resources/icon-chatgpt.icns" \
    "$app_path/Contents/Resources/applet.icns"
  /usr/bin/codesign --force --deep --sign - "$app_path" >/dev/null
}

create_shortcut \
  "ChatGPT OpenAI" \
  "com.github.copilot-api.chatgpt-openai" \
  "$launcher_dir/ChatGPT OpenAI.command"
create_shortcut \
  "ChatGPT Copilot" \
  "com.github.copilot-api.chatgpt-copilot" \
  "$launcher_dir/ChatGPT Copilot.command"

lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$lsregister" -f \
  "$applications_dir/ChatGPT OpenAI.app" \
  "$applications_dir/ChatGPT Copilot.app"
/usr/bin/mdimport \
  "$applications_dir/ChatGPT OpenAI.app" \
  "$applications_dir/ChatGPT Copilot.app"

/bin/sh -n \
  "$bin_dir/codex-copilot" \
  "$bin_dir/copilot-usage" \
  "$bin_dir/codex-app-openai" \
  "$bin_dir/codex-app-copilot"
/usr/bin/codesign --verify --deep --strict \
  "$applications_dir/ChatGPT OpenAI.app" \
  "$applications_dir/ChatGPT Copilot.app"

if test ! -s "$gateway_home/github_token"; then
  echo
  echo "GitHub Copilot login is still required:"
  echo "  cd $(shell_quote "$repo_root")"
  echo "  bun run start auth login --provider copilot"
fi

echo
echo "Installed:"
echo "  codex-copilot"
echo "  copilot-usage"
echo "  Spotlight: ChatGPT Copilot"
echo "  Spotlight: ChatGPT OpenAI"
echo "Original ~/.codex configuration and authorization were not modified."
