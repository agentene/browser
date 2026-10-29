# shellcheck shell=bash
# tls.sh — the HTTPS certificate: reuse any valid pair, self-sign only when
# needed (tls_prepare).
#
# "Valid" = parseable certificate + parseable key + the two belong together
# (same public key). Self-signed pairs are perfectly valid. An existing pair
# that fails validation is a configuration error and stops the container
# rather than being silently replaced.
#
# Sets TLS_CERT / TLS_KEY (empty = no HTTPS listener).

# tls_pair_issue <cert> <key>: prints the problem (if any); silent when valid.
tls_pair_issue() {
    if ! openssl x509 -noout -in "$1" >/dev/null 2>&1; then
        echo "certificate is not parseable (openssl x509 rejected $1)"
        return 1
    fi
    if ! openssl pkey -noout -in "$2" >/dev/null 2>&1; then
        echo "private key is not parseable (openssl pkey rejected $2)"
        return 1
    fi
    local cert_pub key_pub
    cert_pub="$(openssl x509 -in "$1" -noout -pubkey 2>/dev/null \
        | openssl pkey -pubin -outform DER 2>/dev/null | openssl sha256 2>/dev/null)"
    key_pub="$(openssl pkey -in "$2" -pubout -outform DER 2>/dev/null | openssl sha256 2>/dev/null)"
    if [ -z "${cert_pub}" ] || [ "${cert_pub}" != "${key_pub}" ]; then
        echo "certificate $1 does not match private key $2"
        return 1
    fi
    return 0
}

# tls_valid_for_nginx <cert> <key>: quick re-check used right before start.
tls_valid_for_nginx() {
    [ -s "$1" ] && [ -s "$2" ] && tls_pair_issue "$1" "$2" >/dev/null
}

# tls_log_reuse <cert>: describe the certificate being (re)used.
tls_log_reuse() {
    local end
    end="$(openssl x509 -noout -enddate -in "$1" 2>/dev/null | cut -d= -f2-)"
    if openssl x509 -noout -checkend 0 -in "$1" >/dev/null 2>&1; then
        log "HTTPS: reusing existing certificate $1 (valid until ${end:-unknown})"
    else
        log "HTTPS: WARNING: certificate $1 is EXPIRED (${end:-unknown}); reusing it anyway — delete it to force a new one"
    fi
}

tls_prepare() {
    TLS_CERT=""
    TLS_KEY=""
    if [ "${ENABLE_SELKIES}" != "true" ] || [ "${ENABLE_HTTPS}" != "true" ]; then
        return 0
    fi

    local issue
    if [ -s "${TLS_CERT_FILE}" ] && [ -s "${TLS_KEY_FILE}" ]; then
        # A pair is present (mounted, or generated into a writable TLS_CERT_DIR
        # on an earlier start): reuse it as long as it is valid.
        issue="$(tls_pair_issue "${TLS_CERT_FILE}" "${TLS_KEY_FILE}")" \
            || die "HTTPS: refusing to start with a broken certificate pair: ${issue}. Fix or delete ${TLS_CERT_FILE} / ${TLS_KEY_FILE} (a valid pair is reused as-is; a deleted pair is regenerated self-signed)."
        TLS_CERT="${TLS_CERT_FILE}"
        TLS_KEY="${TLS_KEY_FILE}"
        tls_log_reuse "${TLS_CERT}"
    elif [ -e "${TLS_CERT_FILE}" ] || [ -e "${TLS_KEY_FILE}" ]; then
        # Half a pair (e.g. a certificate dropped in without its key) is as
        # broken as a mismatched one: never paper over it with a self-signed
        # pair the user did not ask for.
        die "HTTPS: refusing to start with an incomplete certificate pair: ${TLS_CERT_FILE} and ${TLS_KEY_FILE} must both exist and be non-empty. Add the missing file, or delete both to have a self-signed pair generated."
    elif tls_valid_for_nginx "${TLS_FALLBACK_DIR}/fullchain.pem" "${TLS_FALLBACK_DIR}/privkey.pem"; then
        # Pair from an earlier start of this same container (TLS_CERT_DIR was
        # not writable then). Reuse instead of generating a new one.
        TLS_CERT="${TLS_FALLBACK_DIR}/fullchain.pem"
        TLS_KEY="${TLS_FALLBACK_DIR}/privkey.pem"
        tls_log_reuse "${TLS_CERT}"
    else
        tls_generate_self_signed
    fi
}

# No usable pair anywhere -> generate a self-signed one. Prefer TLS_CERT_DIR
# (a bind mount there persists the pair across container recreation, so it
# is generated only once); fall back to the container-local dir when
# TLS_CERT_DIR is read-only. (TLS_CERT_FILE / TLS_KEY_FILE do not exist here:
# tls_prepare stops on any present or partial pair.)
tls_generate_self_signed() {
    local gen_dir
    if mkdir -p "${TLS_CERT_DIR}" 2>/dev/null \
        && touch "${TLS_CERT_DIR}/.write-test" 2>/dev/null \
        && rm -f "${TLS_CERT_DIR}/.write-test"; then
        gen_dir="${TLS_CERT_DIR}"
    else
        mkdir -p "${TLS_FALLBACK_DIR}"
        gen_dir="${TLS_FALLBACK_DIR}"
    fi
    TLS_CERT="${gen_dir}/fullchain.pem"
    TLS_KEY="${gen_dir}/privkey.pem"
    log "HTTPS: no valid certificate found -> generating self-signed ${TLS_CERT} (CN=${TLS_SELF_SIGNED_CN})"
    rm -f "${TLS_CERT}" "${TLS_KEY}"
    openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
        -keyout "${TLS_KEY}" -out "${TLS_CERT}" \
        -subj "/CN=${TLS_SELF_SIGNED_CN}" \
        -addext "subjectAltName=DNS:${TLS_SELF_SIGNED_CN},DNS:localhost,IP:127.0.0.1" \
        >/dev/null 2>&1 || die "self-signed certificate generation failed"
    tls_valid_for_nginx "${TLS_CERT}" "${TLS_KEY}" \
        || die "generated self-signed pair failed its own validation check"
}
