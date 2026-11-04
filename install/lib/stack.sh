# Talking to a started stack: health, the setup token, the first admin and the first box
# (docs/agent-boxes.md §12.1 steps 7-9). Everything goes to the API on 127.0.0.1:<api port>.

API=''

api_base() { API="http://127.0.0.1:$1"; }

# wait_health <seconds>
wait_health() {
    local deadline=$(( $(date +%s) + $1 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if curl -fsS -m 5 "$API/health" 2>/dev/null | grep -q '"ok"'; then return 0; fi
        sleep 3
    done
    return 1
}

# The setup token the API prints once at first start (src/instance/setup-token.ts)
setup_token() {
    local dir=$1 i tok
    for i in $(seq 1 30); do
        tok=$(compose_in "$dir" logs --no-color api 2>/dev/null | grep -A 2 'AGORA SETUP TOKEN' | grep -Eo '[a-f0-9]{64}' | tail -n 1 || true)
        [ -n "$tok" ] && { printf '%s' "$tok"; return 0; }
        sleep 2
    done
    return 1
}

initialized() { curl -fsS -m 5 "$API/instance/status" | json_get initialized; }

# api_call <method> <path> <token|-> [json body]: prints the body, then a last line with the status
api_call() {
    local method=$1 path=$2 token=$3 body=${4:-}
    local args=(-sS -m 30 -X "$method" -w '\n%{http_code}')
    [ "$token" = - ] || args+=(-H "Authorization: Bearer $token")
    # Fastify refuses an empty body with a JSON content type: only send the header with a body
    [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary @-)
    if [ -n "$body" ]; then printf '%s' "$body" | curl "${args[@]}" "$API$path"
    else curl "${args[@]}" "$API$path" < /dev/null; fi
}

status_of() { tail -n 1; }
body_of() { sed '$d'; }

# instance_setup <token> <user> <email> <password file>: prints the access token
instance_setup() {
    local reply status body pw
    pw=$(cat "$4")
    body="{\"setupToken\":\"$1\",\"username\":$(printf '%s' "$2" | json_str),\"email\":$(printf '%s' "$3" | json_str),\"password\":$(printf '%s' "$pw" | json_str),\"instanceName\":\"Agora\",\"registrationPolicy\":\"invite_only\"}"
    reply=$(api_call POST /instance/setup - "$body")
    status=$(printf '%s\n' "$reply" | status_of)
    [ "$status" = 201 ] || die "instance setup answered $status: $(printf '%s\n' "$reply" | body_of | json_get error)"
    printf '%s\n' "$reply" | body_of | json_get accessToken
}

# login <user> <password file>: prints an access token
login() {
    local reply body
    body="{\"login\":$(printf '%s' "$1" | json_str),\"password\":$(json_str < "$2")}"
    reply=$(api_call POST /auth/login - "$body")
    [ "$(printf '%s\n' "$reply" | status_of)" = 200 ] || return 1
    printf '%s\n' "$reply" | body_of | json_get accessToken
}

server_id() { curl -fsS -m 10 "$API/instance/status" | json_get instanceServerId; }

# general_channel <server id> <token>
general_channel() {
    curl -fsS -m 10 -H "Authorization: Bearer $2" "$API/servers/$1/channels" \
        | tr '{' '\n' | grep '"name":"general"' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n 1
}

# create_box <server> <channel> <token> <name> <adapter> [api key file]: prints the box id
create_box() {
    local body reply status key
    body="{\"name\":\"$4\",\"adapter\":\"$5\",\"homeChannelId\":\"$2\""
    if [ -n "${6:-}" ]; then
        key=$(tr -d '\r\n' < "$6")
        body="$body,\"auth\":\"api_key\",\"apiKey\":$(printf '%s' "$key" | json_str)"
    fi
    body="$body}"
    reply=$(api_call POST "/servers/$1/boxes" "$3" "$body")
    status=$(printf '%s\n' "$reply" | status_of)
    [ "$status" = 201 ] || die "creating the box answered $status: $(printf '%s\n' "$reply" | body_of | json_get error)"
    printf '%s\n' "$reply" | body_of | json_get id
}

# box_state <server> <token> <box id>: "state lastError"
box_state() {
    curl -fsS -m 10 -H "Authorization: Bearer $2" "$API/servers/$1/boxes" | tr '{' '\n' | grep "\"id\":\"$3\"" \
        | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p' | head -n 1
}

box_error() {
    curl -fsS -m 10 -H "Authorization: Bearer $2" "$API/servers/$1/boxes" | tr '{' '\n' | grep "\"id\":\"$3\"" \
        | sed -n 's/.*"lastError":"\([^"]*\)".*/\1/p' | head -n 1
}

# wait_box_running <server> <token> <box id> <seconds>
wait_box_running() {
    local deadline=$(( $(date +%s) + $4 )) s
    while [ "$(date +%s)" -lt "$deadline" ]; do
        s=$(box_state "$1" "$2" "$3" || true)
        case "$s" in
            running) return 0 ;;
            failed) die "the box failed to start: $(box_error "$1" "$2" "$3")" ;;
        esac
        sleep 5
    done
    die "the box is still '${s:-unknown}' after $4 seconds (is boxd running? docker compose ... logs boxd)"
}
