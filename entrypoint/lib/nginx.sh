# shellcheck shell=bash
# nginx.sh — the public front door: web HTTP/HTTPS + CDP endpoint (nginx_start).
#
# One nginx instance serves every public port, on these container ports
# (NGINX_LISTEN_HTTP_PORT / NGINX_LISTEN_HTTPS_PORT / CDP_LISTEN_PORT):
#   ${NGINX_LISTEN_HTTP_PORT}  -> 127.0.0.1:${SELKIES_INTERNAL_PORT}  web UI, HTTP (always)
#   ${NGINX_LISTEN_HTTPS_PORT} -> 127.0.0.1:${SELKIES_INTERNAL_PORT}  web UI, TLS (optional)
#   ${CDP_LISTEN_PORT} -> 127.0.0.1:${CDP_GATEWAY_INTERNAL_PORT}     CDP gateway
#                         (which talks to chromium on ${CDP_INTERNAL_PORT})
# With the CDP console panel (CDP_CONSOLE_PANEL_ACTIVE, config.sh) the web UI
# also gets the sidebar script injected into its entry page and
# <subfolder>/cdp-console/ proxied to the gateway's /console/.
# plus one listener per PORT_FORWARDS entry (same-network peers, see
# nginx_parse_port_forwards). Every proxy is WebSocket-capable (CDP and
# Selkies signaling both need it).
#
# There is no static config: it is generated into NGINX_CONF at every start
# and checked with `nginx -t` before nginx runs.

NGINX_CONF=/tmp/nginx/nginx.conf

# Port plan + PORT_FORWARDS validation, run right after config_load: a port
# clash or a malformed forward stops the container before any service starts.
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

# The built-in listeners and the loopback upstreams behind them, into
# LISTEN_PORTS / UPSTREAM_PORTS.
nginx_plan_ports() {
    LISTEN_PORTS=()
    UPSTREAM_PORTS=()
    if [ "${ENABLE_SELKIES}" = "true" ]; then
        LISTEN_PORTS+=("${NGINX_LISTEN_HTTP_PORT}")
        UPSTREAM_PORTS+=("${SELKIES_INTERNAL_PORT}")
        if [ "${ENABLE_HTTPS}" = "true" ]; then
            LISTEN_PORTS+=("${NGINX_LISTEN_HTTPS_PORT}")
        fi
    elif [ "${ENABLE_HTTPS}" = "true" ]; then
        log "NOTE: ENABLE_HTTPS=true ignored: the web UI is disabled (ENABLE_SELKIES=false)"
    fi
    if [ "${ENABLE_CDP}" = "true" ]; then
        LISTEN_PORTS+=("${CDP_LISTEN_PORT}")
        UPSTREAM_PORTS+=("${CDP_INTERNAL_PORT}" "${CDP_GATEWAY_INTERNAL_PORT}")
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

# A listener colliding with a loopback upstream would make nginx fail at bind
# time with a cryptic error; fail fast with a clear one.
nginx_check_port_collisions() {
    local all_ports=("${LISTEN_PORTS[@]}" "${UPSTREAM_PORTS[@]}" "${FORWARD_LISTEN_PORTS[@]}")
    local i j
    for i in "${!all_ports[@]}"; do
        for j in "${!all_ports[@]}"; do
            if [ "${i}" -lt "${j}" ] && [ "${all_ports[$i]}" = "${all_ports[$j]}" ]; then
                die "port ${all_ports[$i]} is used more than once (listen: ${LISTEN_PORTS[*]:-none}; upstream: ${UPSTREAM_PORTS[*]:-none}; forwards: ${FORWARD_LISTEN_PORTS[*]:-none})"
            fi
        done
    done
}

# --- config rendering -----------------------------------------------------------

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
    # empty = compiled default nobody, the historical behavior.
    local user_conf="" web_servers="" cdp_server=""
    [ -n "${RUN_NGINX_USER}" ] && user_conf="user ${RUN_NGINX_USER};"
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
    local locations="        location / {
            proxy_pass http://127.0.0.1:${SELKIES_INTERNAL_PORT};
        }"
    [ "${CDP_CONSOLE_PANEL_ACTIVE}" = "true" ] && locations="${locations}
$(nginx_cdp_console_locations)"
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
    cat <<EOF
    # web UI over plain HTTP (always on)
    server {
        listen ${LISTEN_PREFIX}${NGINX_LISTEN_HTTP_PORT};
        server_name _;
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
${locations}
    }
EOF
}

# The CDP console sidebar on the web UI (CDP_CONSOLE_PANEL_ACTIVE): inject
# cdp-gateway/panel.js into the Selkies entry page only (the /api/files/
# browser is HTML too), and proxy cdp-console/ next to it to the gateway's
# console. Both paths are relative to the subfolder, like the page's own.
# proxy_set_header is all-or-nothing per level, so each location repeats the
# http-level forwarding headers (selkies checks WebSocket Origins against
# Host, the gateway its console's), Upgrade/Connection included where a
# location upgrades (the console's live state WebSocket, cdp-console/ws).
nginx_cdp_console_locations() {
    local prefix="${SELKIES_SUBFOLDER}" fwd_headers entry
    fwd_headers="            proxy_set_header Host \$http_host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;"
    # Selkies entry page + the sidebar script (sub_filter only sees
    # uncompressed, complete pages: no gzip, no 304s from upstream)
    for entry in "${prefix}/" "${prefix}/index.html"; do
        cat <<EOF
        location = ${entry} {
${fwd_headers}
            proxy_set_header Accept-Encoding "";
            proxy_set_header If-None-Match "";
            proxy_set_header If-Modified-Since "";
            sub_filter_once on;
            sub_filter_types text/html;
            sub_filter '</head>' '<script src="cdp-console/panel.js" defer></script></head>';
            add_header Cache-Control "no-cache" always;
            proxy_pass http://127.0.0.1:${SELKIES_INTERNAL_PORT};
        }
EOF
    done
    cat <<EOF
        # the sidebar's script, API and live state WebSocket, served by the
        # CDP gateway's console; the marker header makes the gateway require
        # Selkies' master password
        location ${prefix}/cdp-console/ {
${fwd_headers}
            proxy_set_header X-CDP-Console-Via web;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection \$connection_upgrade;
            proxy_pass http://127.0.0.1:${CDP_GATEWAY_INTERNAL_PORT}/console/;
        }
EOF
}

# The CDP listener, through the CDP gateway.
nginx_cdp_server() {
    cat <<EOF
    # public CDP endpoint, via the CDP gateway
    server {
        listen ${LISTEN_PREFIX}${CDP_LISTEN_PORT};
        server_name _;
        location / {
            # The CDP gateway talks to the main chromium (and to every
            # context browser) itself: it rewrites the Host header to the
            # loopback upstream and the ws:// URLs in JSON bodies back to
            # the Host the client dialed — so pass that Host through as-is.
            # The console marker of the web UI's cdp-console/ proxy must not
            # be forgeable from here (the CDP port has no login anyway), and
            # setting it drops the http-level headers, so repeat those.
            proxy_set_header X-CDP-Console-Via "";
            proxy_set_header Host \$http_host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection \$connection_upgrade;
            proxy_pass http://127.0.0.1:${CDP_GATEWAY_INTERNAL_PORT};
        }
    }
EOF
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
