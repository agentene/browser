# shellcheck shell=bash
# nginx.sh — the public front door: web HTTP/HTTPS + CDP endpoint (nginx_start).
#
# One nginx instance serves every public port, on these container ports
# (NGINX_LISTEN_HTTP_PORT / NGINX_LISTEN_HTTPS_PORT / CDP_LISTEN_PORT):
#   ${NGINX_LISTEN_HTTP_PORT}  -> ${SELKIES_SOCKET}      web UI, HTTP (always)
#   ${NGINX_LISTEN_HTTPS_PORT} -> ${SELKIES_SOCKET}      web UI, TLS (optional)
#   ${CDP_LISTEN_PORT} -> ${CDP_GATEWAY_SOCKET}  CDP gateway (which talks
#                         to the browsers on their DevTools pipes)
# The services behind it are on unix sockets (config.sh: no TCP port a page
# in the browser could open the origin of).
# With the CDP console panel (CDP_CONSOLE_PANEL_ACTIVE, config.sh) the web UI
# also gets the sidebar script injected into its entry page and
# <subfolder>/cdp-console/ proxied to the gateway's /console/; with the
# built-in login, the session keepalive script too.
# plus one listener per PORT_FORWARDS entry (same-network peers, see
# nginx_parse_port_forwards). Every proxy is WebSocket-capable (CDP and
# Selkies signaling both need it).
# With the built-in login (ENABLE_AUTH, auth.sh) every web UI request and the
# CDP port's /console are checked with the auth service first (auth_request:
# a session, else its setup/login form in place), the CDP API with its API
# key; <subfolder>/__auth/ (web) and /__auth/ (CDP port) proxy to its pages
# and API. PORT_FORWARDS listeners are not covered.
# With ALLOWED_HOSTS the web and CDP listeners answer only to those host names
# (plus IP addresses and localhost); any other Host gets 421 (DNS rebinding).
#
# There is no static config: it is generated into NGINX_CONF at every start
# and checked with `nginx -t` before nginx runs.

NGINX_CONF=/tmp/nginx/nginx.conf

# Listener plan + PORT_FORWARDS validation, run right after config_load: a
# port clash or a malformed forward stops the container before any service
# starts.
nginx_prepare() {
    nginx_plan_ports
    nginx_parse_port_forwards
    nginx_check_port_collisions
}

nginx_start() {
    tls_prepare
    nginx_write_config

    local nginx_out
    if ! nginx_out="$(nginx -t -c "${NGINX_CONF}" 2>&1)"; then
        die "nginx config invalid: ${nginx_out}"
    fi

    local fronts="" i
    [ "${ENABLE_SELKIES}" = "true" ] && fronts="http:${NGINX_LISTEN_HTTP_PORT}"
    [ -n "${TLS_CERT}" ] && fronts="${fronts} https:${NGINX_LISTEN_HTTPS_PORT}"
    [ "${ENABLE_CDP}" = "true" ] && fronts="${fronts} cdp:${CDP_LISTEN_PORT}"
    for i in "${!FORWARD_LISTEN_PORTS[@]}"; do
        fronts="${fronts} fwd:${FORWARD_LISTEN_PORTS[$i]}->${FORWARD_TARGETS[$i]}"
    done
    log "starting nginx (${fronts:-no listeners}; host-side publishing is up to docker)"
    start_service - nginx -c "${NGINX_CONF}"
}

# The built-in listeners, into LISTEN_PORTS.
nginx_plan_ports() {
    LISTEN_PORTS=()
    if [ "${ENABLE_SELKIES}" = "true" ]; then
        LISTEN_PORTS+=("${NGINX_LISTEN_HTTP_PORT}")
        if [ "${ENABLE_HTTPS}" = "true" ]; then
            LISTEN_PORTS+=("${NGINX_LISTEN_HTTPS_PORT}")
        fi
    elif [ "${ENABLE_HTTPS}" = "true" ]; then
        log "NOTE: ENABLE_HTTPS=true ignored: the web UI is disabled (ENABLE_SELKIES=false)"
    fi
    if [ "${ENABLE_CDP}" = "true" ]; then
        LISTEN_PORTS+=("${CDP_LISTEN_PORT}")
    fi
    return 0
}

# --- extra port forwards (PORT_FORWARDS) --------------------------------------
# PORT_FORWARDS="3080=peer:80 6080=other:6080" (space or comma separated) makes
# nginx also listen on each LISTEN port and reverse-proxy it to HOST:PORT —
# typically a sibling container on the same docker network, reached by
# container name. Deliberate properties:
#   * same nginx instance & lifecycle as every other listener (no extra
#     process, no extra image dependency, dies with the container);
#   * the http-level proxy defaults apply: WebSocket upgrade, 24h read/write
#     timeouts, 50m bodies — forwarded apps that speak WS just work;
#   * the peer hostname is resolved PER REQUEST via docker's embedded DNS
#     (resolver below), not at config-parse time: this container starts fine
#     while the peer is still down, and picks up its new IP after a recreate
#     (valid=10s) — requests 502 until the peer answers, instead of the whole
#     front door failing `nginx -t`;
#   * HTTP reverse proxy, not a raw TCP pipe; an https:// upstream would need
#     proxy_ssl on (not exposed as a knob — none of our peers speak TLS).
# Sets FORWARD_LISTEN_PORTS / FORWARD_TARGETS and the FORWARD_SERVERS blocks.
nginx_parse_port_forwards() {
    FORWARD_SERVERS=""
    FORWARD_LISTEN_PORTS=()
    FORWARD_TARGETS=()
    [ -n "${PORT_FORWARDS}" ] || return 0

    # nginx's resolver needs an explicit DNS server: take the container's own
    # (/etc/resolv.conf) — docker's embedded 127.0.0.11 on user-defined
    # networks, the host's resolver with network_mode: host or the default
    # bridge.
    local resolver spec fwd_listen fwd_target
    resolver="$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf 2>/dev/null)"
    case "${resolver}" in
        '') resolver="127.0.0.11" ;;
        *%*) die "PORT_FORWARDS: nameserver '${resolver}' in /etc/resolv.conf has a zone id nginx cannot use" ;;
        *:*) resolver="[${resolver}]" ;;
    esac

    for spec in $(printf '%s\n' "${PORT_FORWARDS}" | tr ',' ' '); do
        [ -n "${spec}" ] || continue
        case "${spec}" in
            *=*) : ;;
            *) die "PORT_FORWARDS entry '${spec}' must be LISTEN=HOST:PORT" ;;
        esac
        fwd_listen="${spec%%=*}"
        fwd_target="${spec#*=}"
        case "${fwd_listen}" in
            ''|*[!0-9]*) die "PORT_FORWARDS listen port '${fwd_listen}' is not a number (entry '${spec}')" ;;
        esac
        case "${fwd_target}" in
            *:*) : ;;
            *) die "PORT_FORWARDS target '${fwd_target}' must be HOST:PORT (entry '${spec}')" ;;
        esac
        FORWARD_LISTEN_PORTS+=("${fwd_listen}")
        FORWARD_TARGETS+=("${fwd_target}")
        FORWARD_SERVERS="${FORWARD_SERVERS}
$(nginx_forward_server "${fwd_listen}" "${fwd_target}" "${resolver}")"
    done
}

# Two listeners on one port would make nginx fail at bind time with a
# cryptic error; fail fast with a clear one.
nginx_check_port_collisions() {
    local all_ports=("${LISTEN_PORTS[@]}" "${FORWARD_LISTEN_PORTS[@]}")
    local i j
    for i in "${!all_ports[@]}"; do
        for j in "${!all_ports[@]}"; do
            if [ "${i}" -lt "${j}" ] && [ "${all_ports[$i]}" = "${all_ports[$j]}" ]; then
                die "port ${all_ports[$i]} is used more than once (listen: ${LISTEN_PORTS[*]:-none}; forwards: ${FORWARD_LISTEN_PORTS[*]:-none})"
            fi
        done
    done
}

# --- config rendering -----------------------------------------------------------

# ALLOWED_HOSTS: $agentene_host_allowed is 1 for a listed host name (a
# leading dot or *. = its subdomains too), an IP address or localhost.
# Nothing when the list is empty (or *): every Host is answered.
nginx_host_map() {
    local entry entries=""
    for entry in $(printf '%s\n' "${ALLOWED_HOSTS}" | tr ',' ' '); do
        [ "${entry}" = "*" ] && return 0
        entries="${entries}
        $(printf '%s' "${entry}" | tr '[:upper:]' '[:lower:]') 1;"
    done
    [ -n "${entries}" ] || return 0
    cat <<EOF

    # ALLOWED_HOSTS (DNS rebinding: a site pointing its own name here)
    map \$host \$agentene_host_allowed {
        hostnames;
        default 0;
        localhost 1;
        ~^[0-9.]+\$ 1;
        ~^\[?[0-9a-f:.]+\]?\$ 1;${entries}
    }
EOF
}

# The check every web / CDP server starts with (nginx_host_map).
nginx_host_guard() {
    [ -n "$(nginx_host_map)" ] || return 0
    cat <<'EOF'
        if ($agentene_host_allowed = 0) {
            return 421;
        }
EOF
}

nginx_write_config() {
    mkdir -p /tmp/nginx/client_body /tmp/nginx/proxy /tmp/nginx/fastcgi \
             /tmp/nginx/uwsgi /tmp/nginx/scgi
    # Workers buffer large request bodies through these temp dirs as their own
    # uid — hand them over when privileges are dropped (nobody, the compiled
    # default, cannot write into root-owned 0755 dirs either, but RUN_USER
    # should not inherit that wart).
    give_to_run_user -R /tmp/nginx

    # nginx workers as the RUN_USER (the `user` directive takes a NAME, which
    # is why numeric ids get a synthesized passwd entry in privileges.sh);
    # empty (RUN_USER=0) = compiled default nobody.
    local user_conf="" web_servers="" cdp_server="" host_map=""
    [ -n "${RUN_NGINX_USER}" ] && user_conf="user ${RUN_NGINX_USER};"
    host_map="$(nginx_host_map)"
    [ "${ENABLE_SELKIES}" = "true" ] && web_servers="$(nginx_web_servers)"
    [ "${ENABLE_CDP}" = "true" ] && cdp_server="$(nginx_cdp_server)"

    cat > "${NGINX_CONF}" <<EOF
# generated by docker-entrypoint.sh at container start — do not edit
daemon off;
${user_conf}
worker_processes auto;
pid /tmp/nginx/nginx.pid;
error_log /tmp/nginx/error.log warn;

events {
    worker_connections 1024;
}

http {
    access_log /tmp/nginx/access.log;

    # temp dirs on the container's writable /tmp
    client_body_temp_path /tmp/nginx/client_body;
    proxy_temp_path       /tmp/nginx/proxy;
    fastcgi_temp_path     /tmp/nginx/fastcgi;
    uwsgi_temp_path       /tmp/nginx/uwsgi;
    scgi_temp_path        /tmp/nginx/scgi;

    # WebSocket upgrade handling (needed by CDP and Selkies signaling)
    map \$http_upgrade \$connection_upgrade {
        default upgrade;
        ''      close;
    }
${host_map}

    # proxy defaults inherited by every server block below
    proxy_http_version 1.1;
    proxy_set_header Host \$http_host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    # idle DevTools/Selkies WebSocket sessions can outlive the 60s default
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
    client_max_body_size 50m;

${web_servers}
${cdp_server}
${FORWARD_SERVERS}
}
EOF
}

# The web UI: HTTP always, HTTPS when tls_prepare found/made a pair.
nginx_web_servers() {
    # Selkies serves every route under SELKIES_SUBFOLDER itself, so requests
    # pass through unmodified (no prefix stripping). With a subfolder, the
    # bare root and the slash-less prefix redirect to "<prefix>/": the web
    # client derives its API/WebSocket base from the page URL's directory.
    # Relative redirects keep working behind docker port mapping and an
    # outer reverse proxy, where nginx's own host:port would be wrong.
    local locations
    locations="        location / {
            proxy_pass http://unix:${SELKIES_SOCKET};
        }
$(nginx_web_entry_locations)"
    [ "${CDP_CONSOLE_PANEL_ACTIVE}" = "true" ] && locations="${locations}
$(nginx_cdp_console_location)"
    if [ -n "${SELKIES_SUBFOLDER}" ]; then
        locations="${locations}
        location = / {
            absolute_redirect off;
            return 302 ${SELKIES_SUBFOLDER}/;
        }
        location = ${SELKIES_SUBFOLDER} {
            absolute_redirect off;
            return 301 ${SELKIES_SUBFOLDER}/;
        }"
    fi
    if [ "${ENABLE_AUTH}" = "true" ]; then
        locations="        # built-in login: a session for everything but the auth pages
        auth_request /.agentene-auth/web;
        error_page 401 = @agentene_login;
${locations}
$(nginx_auth_locations "${SELKIES_SUBFOLDER}/__auth/" "${SELKIES_SUBFOLDER}/")"
    fi
    cat <<EOF
    # web UI over plain HTTP (always on)
    server {
        listen ${LISTEN_PREFIX}${NGINX_LISTEN_HTTP_PORT};
        server_name _;
$(nginx_host_guard)
${locations}
    }
EOF
    [ -n "${TLS_CERT}" ] || return 0
    cat <<EOF
    # web UI over HTTPS (ENABLE_HTTPS=true)
    server {
        listen ${LISTEN_PREFIX}${NGINX_LISTEN_HTTPS_PORT} ssl;
        server_name _;
        ssl_certificate ${TLS_CERT};
        ssl_certificate_key ${TLS_KEY};
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 1d;
$(nginx_host_guard)
${locations}
    }
EOF
}

# proxy_set_header is all-or-nothing per level, so a location that sets one
# repeats the http-level forwarding headers (selkies checks WebSocket Origins
# against Host, the gateway its console's).
nginx_fwd_headers() {
    cat <<'EOF'
            proxy_set_header Host $http_host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
EOF
}

# The Selkies entry page with scripts injected before </head>: the CDP
# console sidebar (cdp-gateway/panel.js, CDP_CONSOLE_PANEL_ACTIVE) and the
# login's session keepalive (auth-server/keepalive.js, ENABLE_AUTH). Only
# the entry page (the /api/files/ browser is HTML too); the paths are
# relative to the subfolder, like the page's own. Nothing to inject = no
# extra locations.
nginx_web_entry_locations() {
    local scripts="" entry
    if [ "${CDP_CONSOLE_PANEL_ACTIVE}" = "true" ]; then
        scripts='<script src="cdp-console/panel.js" defer></script>'
    fi
    if [ "${ENABLE_AUTH}" = "true" ]; then
        scripts="${scripts}"'<script src="__auth/keepalive.js" defer></script>'
    fi
    [ -n "${scripts}" ] || return 0
    # sub_filter only sees uncompressed, complete pages: no gzip, no 304s
    # from upstream
    for entry in "${SELKIES_SUBFOLDER}/" "${SELKIES_SUBFOLDER}/index.html"; do
        cat <<EOF
        location = ${entry} {
$(nginx_fwd_headers)
            proxy_set_header Accept-Encoding "";
            proxy_set_header If-None-Match "";
            proxy_set_header If-Modified-Since "";
            sub_filter_once on;
            sub_filter_types text/html;
            sub_filter '</head>' '${scripts}</head>';
            add_header Cache-Control "no-cache" always;
            proxy_pass http://unix:${SELKIES_SOCKET};
        }
EOF
    done
}

# The CDP console sidebar's backend on the web UI (CDP_CONSOLE_PANEL_ACTIVE):
# <subfolder>/cdp-console/ proxied to the gateway's console, Upgrade/
# Connection included (the console's live state WebSocket, cdp-console/ws).
nginx_cdp_console_location() {
    cat <<EOF
        # the sidebar's script, API and live state WebSocket, served by the
        # CDP gateway's console; the marker header makes the gateway require
        # Selkies' master password and serve its console only (never the
        # CDP API, which is the CDP port's)
        location ${SELKIES_SUBFOLDER}/cdp-console/ {
$(nginx_fwd_headers)
            proxy_set_header X-CDP-Console-Via web;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection \$connection_upgrade;
            proxy_pass http://unix:${CDP_GATEWAY_SOCKET}:/console/;
        }
EOF
}

# The CDP listener, through the CDP gateway. With the built-in login the
# CDP API needs the API key (if one is set) and /console a session, like the
# web UI.
nginx_cdp_server() {
    # The CDP gateway makes the ws:// URLs of its /json answers from the Host
    # the client dialed — so pass that Host through as-is. The console
    # marker of the web UI's
    # cdp-console/ proxy must not be forgeable from here, and setting it
    # drops the http-level headers, so repeat those.
    local gateway="            proxy_set_header X-CDP-Console-Via \"\";
            proxy_set_header Host \$http_host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection \$connection_upgrade;
            proxy_pass http://unix:${CDP_GATEWAY_SOCKET};"
    if [ "${ENABLE_AUTH}" != "true" ]; then
        cat <<EOF
    # public CDP endpoint, via the CDP gateway
    server {
        listen ${LISTEN_PREFIX}${CDP_LISTEN_PORT};
        server_name _;
$(nginx_host_guard)
        location / {
${gateway}
        }
    }
EOF
        return 0
    fi
    cat <<EOF
    # public CDP endpoint, via the CDP gateway
    server {
        listen ${LISTEN_PREFIX}${CDP_LISTEN_PORT};
        server_name _;
$(nginx_host_guard)
        # the CDP API (/json/*, /devtools/*): the API key, once one is set
        location / {
            auth_request /.agentene-auth/cdp;
            error_page 401 = @agentene_cdp_denied;
${gateway}
        }
        # the CDP console: a session, like the web UI (exactly /console and
        # what is under /console/; the gateway serves nothing else there and
        # refuses request paths it would read differently from nginx)
        location = /console {
            auth_request /.agentene-auth/web;
            error_page 401 = @agentene_login;
${gateway}
        }
        location /console/ {
            auth_request /.agentene-auth/web;
            error_page 401 = @agentene_login;
${gateway}
        }
        location @agentene_cdp_denied {
            default_type application/json;
            add_header WWW-Authenticate 'Bearer realm="CDP"' always;
            return 401 '{"error":"CDP API key missing or wrong: send it as Authorization: Bearer <key> or X-API-Key: <key>"}\n';
        }
$(nginx_auth_locations /__auth/ /console/)
    }
EOF
}

# nginx_auth_locations <public base> <home>: the auth service's locations in
# a server — its public pages + API under <base> (prefix stripped), the
# internal checks auth_request asks, and the setup/login form nginx serves
# in place of a page that needs a session (401; <home> is where its account
# page links back to). Every one of them is exempt from the server's own
# auth_request. The checks get the original request's headers (cookie,
# API key, Origin) without its body or WebSocket upgrade.
nginx_auth_locations() {
    local base="$1" home="$2" check
    local headers="            proxy_set_header Host \$http_host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_set_header Upgrade \"\";
            proxy_set_header Connection \"\";"
    cat <<EOF
        # built-in login (auth.sh): setup/login forms, account page, API, ui.js
        location ${base} {
            auth_request off;
${headers}
            proxy_set_header X-Auth-Base "${base}";
            proxy_set_header X-Auth-Home "${home}";
            proxy_pass http://unix:${AUTH_SOCKET}:/;
        }
        location @agentene_login {
            auth_request off;
${headers}
            proxy_set_header X-Auth-Base "${base}";
            proxy_set_header X-Auth-Home "${home}";
            proxy_pass_request_body off;
            proxy_set_header Content-Length "";
            rewrite ^ /page break;
            proxy_pass http://unix:${AUTH_SOCKET};
        }
EOF
    for check in web cdp; do
        cat <<EOF
        location = /.agentene-auth/${check} {
            internal;
            auth_request off;
${headers}
            proxy_set_header X-Original-Method \$request_method;
            proxy_set_header X-Original-Upgrade \$http_upgrade;
            proxy_pass_request_body off;
            proxy_set_header Content-Length "";
            proxy_pass http://unix:${AUTH_SOCKET}:/check/${check};
        }
EOF
    done
}

# nginx_forward_server <listen> <host:port> <resolver>: one PORT_FORWARDS block.
nginx_forward_server() {
    cat <<EOF
    # extra port forward $1 -> $2 (PORT_FORWARDS)
    server {
        listen ${LISTEN_PREFIX}$1;
        server_name _;
        # container DNS (docker's embedded 127.0.0.11 on compose networks);
        # per-request resolution keeps this listener (and the whole nginx)
        # up while the peer container is down
        resolver $3 valid=10s ipv6=off;
        location / {
            # variable target => resolved at request time via the resolver
            # above, NOT at config-parse time (nginx -t never needs the peer)
            set \$fwd_upstream $2;
            proxy_pass http://\$fwd_upstream;
        }
    }
EOF
}
