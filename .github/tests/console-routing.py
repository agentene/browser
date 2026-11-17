#!/usr/bin/env python3
"""Public web/CDP boundaries across service modes, TLS and desktop prefixes."""
import http.client
import http.cookiejar
import json
import os
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

IMAGE = sys.argv[1]
TLS = ssl._create_unverified_context()  # disposable self-signed test certificates


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.STDOUT).strip()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def client():
    return urllib.request.build_opener(
        NoRedirect(), urllib.request.HTTPSHandler(context=TLS),
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(opener, url, status=200, method="GET", body=None, headers=None):
    headers = dict(headers or {})
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, method=method, headers=headers,
                                 data=None if body is None else json.dumps(body).encode())
    try:
        response = opener.open(req, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        assert response.status == status, (url, response.status, raw[:300])
        return response.headers, raw


def websocket(url, status, cookie="", origin=None):
    parsed = urllib.parse.urlsplit(url)
    connection = (http.client.HTTPSConnection(parsed.netloc, context=TLS, timeout=3)
                  if parsed.scheme == "https" else http.client.HTTPConnection(parsed.netloc, timeout=3))
    try:
        headers = {"Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13",
                   "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Cookie": cookie}
        if origin is not None:
            headers["Origin"] = origin
        connection.request("GET", parsed.path, headers=headers)
        response = connection.getresponse()
        assert response.status == status, (url, response.status)
    finally:
        connection.close()


def free_ports():
    sockets = [socket.socket() for _ in range(3)]
    try:
        for item in sockets:
            item.bind(("127.0.0.1", 0))
        return [item.getsockname()[1] for item in sockets]
    finally:
        for item in sockets:
            item.close()


def smoke(label, stream, cdp, prefix, user, https, auth, backend="wayland", host=False, console_prefix="/console"):
    name = f"console-routing-{os.getpid()}-{label}"
    console_path = "/" + console_prefix.strip("/") if console_prefix.strip("/") else ""
    auth_path = console_path + "/__auth/"
    http_port, https_port, cdp_port = free_ports() if host else (18080, 18443, 19222)
    args = ["run", "-d", "--name", name, "--shm-size=512m",
            "-e", f"ENABLE_SELKIES={str(stream).lower()}", "-e", f"ENABLE_CDP={str(cdp).lower()}",
            "-e", f"ENABLE_HTTPS={str(https).lower()}", "-e", f"ENABLE_AUTH={str(auth).lower()}",
            "-e", f"SELKIES_SUBFOLDER={prefix}", "-e", f"CONSOLE_SUBFOLDER={console_prefix}", "-e", f"RUN_USER={user}", "-e", f"DISPLAY_BACKEND={backend}",
            "-e", "AUTH_SETUP_CODE=routing-test", "-e", f"NGINX_LISTEN_HTTP_PORT={http_port}",
            "-e", f"NGINX_LISTEN_HTTPS_PORT={https_port}", "-e", f"CDP_LISTEN_PORT={cdp_port}"]
    if host:
        args += ["--network", "host", "-e", "NGINX_LISTEN_ADDR=127.0.0.1"]
    else:
        for port in [http_port, https_port, cdp_port]:
            args += ["-p", f"127.0.0.1::{port}"]
    docker(*args, IMAGE)
    try:
        info = json.loads(docker("inspect", name))[0]
        def endpoint(port, scheme="http"):
            published = port if host else info["NetworkSettings"]["Ports"][f"{port}/tcp"][0]["HostPort"]
            return f"{scheme}://127.0.0.1:{published}"
        web, browser = endpoint(http_port), endpoint(cdp_port)
        viewer, anonymous = client(), client()
        for _ in range(240):
            try:
                request(anonymous, web + console_path + "/", 401 if auth else 200)
                break
            except (OSError, AssertionError):
                time.sleep(0.25)
        else:
            raise AssertionError("console did not become ready")
        if auth:
            _, page = request(anonymous, web + console_path + "/", 401)
            assert f'data-base="{auth_path}"'.encode() in page and b'data-mode="setup"' in page
            request(viewer, web + auth_path + "api/setup", method="POST", body={
                "code": "routing-test", "username": "admin", "password": "routing-password"})
        for origin in [web] + ([endpoint(https_port, "https")] if https else []):
            cookie = ""
            if auth:
                headers, _ = request(viewer, origin + auth_path + "api/login", method="POST",
                                     body={"username": "admin", "password": "routing-password"})
                cookie = headers["Set-Cookie"].split(";", 1)[0]
                if origin.startswith("https:"):
                    assert "Secure" in headers["Set-Cookie"]
                request(viewer, origin + auth_path + "api/renew", method="POST", body={})
                headers, _ = request(viewer, origin + auth_path.rstrip("/"), 301)
                assert headers["Location"] == auth_path
                _, account = request(viewer, origin + auth_path)
                assert f'data-home="{console_path}/"'.encode() in account
            if console_path:
                headers, _ = request(viewer, origin + console_path + "?view=settings", 302)
                assert headers["Location"] == console_path + "/?view=settings"
            _, console_page = request(viewer, origin + console_path + "/")
            bootstrap = f'src="{auth_path}client.js"'.encode()
            assert console_page.count(bootstrap) == (1 if auth else 0)
            for asset in ["i18n.js", "settings-ui.js", "panel.js", "overlay.js"]:
                request(viewer, origin + console_path + "/" + asset)
            _, raw = request(viewer, origin + console_path + "/api/settings")
            capabilities = json.loads(raw)["capabilities"]
            assert capabilities["browser"] == cdp and capabilities["stream"] == stream
            request(viewer, origin + console_path + "/api/nope", 403, method="DELETE")
            websocket(origin + console_path + "/ws", 101, cookie, origin)
            websocket(origin + console_path + "/ws", 403, cookie, "https://evil.example")
            if auth:
                websocket(origin + console_path + "/ws", 401)
            websocket(origin + console_path + "/overlay", 101 if cdp and stream else 404, cookie, origin)
            request(viewer, origin + console_path + "/json/version", 404)
            websocket(origin + console_path + "/devtools/browser/x", 404, cookie, origin)
            if stream:
                _, page = request(viewer, origin + prefix + "/")
                assert f'src="{console_path}/panel.js"'.encode() in page
                assert (f'src="{console_path}/overlay.js"'.encode() in page) == cdp
                assert page.count(bootstrap) == (1 if auth else 0)
                request(viewer, origin + prefix + "/api/sessions")
            else:
                if console_path:
                    headers, _ = request(viewer, origin + "/", 302)
                    assert headers["Location"] == console_path + "/"
                else:
                    request(viewer, origin + "/")
                request(viewer, origin + prefix + "/", 404)
        docker("exec", name, "test", "-S", "/tmp/agentene/console.sock")
        if cdp:
            key = {"X-API-Key": "routing-api-key"} if auth else {}
            if auth:
                # Use HTTPS after a secure session cookie was issued.
                origin = endpoint(https_port, "https") if https else web
                request(viewer, origin + auth_path + "api/apikey", method="PUT", body={
                    "currentPassword": "routing-password", "apiKey": "routing-api-key"})
                request(viewer, browser + "/json/version", 401)
                request(anonymous, origin + console_path + "/", 401, headers=key)
            _, raw = request(anonymous, browser + "/json/version", headers=key)
            assert json.loads(raw)["webSocketDebuggerUrl"].startswith(browser.replace("http:", "ws:") + "/devtools/")
            for route in [console_path + "/", console_path + "/api/settings", auth_path, auth_path + "api/setup", "/__auth/"]:
                _, raw = request(viewer, browser + route, 404, headers=key)
                assert b"<html" not in raw.lower()
            docker("exec", name, "test", "-S", "/tmp/agentene/cdp-gateway.sock")
        else:
            docker("exec", name, "test", "!", "-S", "/tmp/agentene/cdp-gateway.sock")
        docker("exec", name, "/usr/local/lib/docker-entrypoint/helpers/healthcheck.sh")
        assert not docker("exec", name, "sh", "-c", "pgrep -x chrome || true"), "console and health probes must not start Chrome"
        if not host:
            observed = docker("exec", name, "python3", "-c",
                              "from pathlib import Path; print(' '.join(sorted({str(int(line.split()[1].split(':')[1],16)) for f in ['/proc/net/tcp','/proc/net/tcp6'] for line in Path(f).read_text().splitlines()[1:] if line.split()[3]=='0A'})))")
            expected = {http_port} | ({https_port} if https else set()) | ({cdp_port} if cdp else set())
            assert set(map(int, observed.split())) == expected, observed
        print(f"Console routing OK: {label}", flush=True)
    except BaseException:
        subprocess.run(["docker", "logs", name], check=False)
        subprocess.run(["docker", "exec", name, "cat", "/tmp/nginx/error.log", "/tmp/cdp-gateway.log"], check=False)
        raise
    finally:
        docker("rm", "-f", name)


for console_prefix, desktop_prefix in [("/console", "/console"), ("/console", "/console/api"),
                                       ("/desk/api/admin", "/desk"), ("", ""), ("", "/__auth"), ("", "/api"),
                                       ("/index.html", ""), ("/api/admin", ""), ("/assets", ""),
                                       ("/bad/../path", "/browser"), ("/bad//path", "/browser"), ("/bad path", "/browser")]:
    result = subprocess.run(["docker", "run", "--rm", "-e", f"SELKIES_SUBFOLDER={desktop_prefix}",
                             "-e", f"CONSOLE_SUBFOLDER={console_prefix}", IMAGE], capture_output=True, text=True, check=False)
    assert result.returncode != 0 and "ERROR" in result.stdout + result.stderr, result.stdout + result.stderr
result = subprocess.run(["docker", "run", "--rm", "-e", "ENABLE_SELKIES=false", "-e", "CDP_LISTEN_PORT=80", IMAGE], capture_output=True, text=True, check=False)
assert result.returncode != 0 and "used more than once" in result.stdout + result.stderr, result.stdout + result.stderr
result = subprocess.run(["docker", "run", "--rm", "-e", "ENABLE_SELKIES=false", "-e", "ENABLE_CDP=false", IMAGE], capture_output=True, text=True, check=False)
assert result.returncode != 0 and "nothing to start" in result.stdout + result.stderr, result.stdout + result.stderr

smoke("root", True, True, "", "browser", False, True)
smoke("settings-x11", True, False, "/browser", "1002:1002", False, True, backend="x11")
smoke("nested-tls", True, True, "/tools/desk", "browser", True, True, console_prefix="tools/admin///")
smoke("console-tls", False, True, "/browser", "0", True, True, console_prefix="/admin")
smoke("host", False, True, "/browser", "browser", False, False, host=True, console_prefix="/control")
smoke("root-console", True, True, "/browser", "browser", False, True, console_prefix="")
smoke("root-only", False, True, "/browser", "browser", False, False, console_prefix="/")
smoke("nested-console", True, True, "/tools/browser", "browser", False, True, console_prefix="/tools/browser/control")
smoke("nested-desktop", True, True, "/tools/browser", "browser", False, True, console_prefix="/tools")
