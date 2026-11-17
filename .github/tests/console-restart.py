#!/usr/bin/env python3
"""Container restart API smoke test; Docker and Python's standard library only."""

import http.cookiejar
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def wait_for(check, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (OSError, ValueError, AssertionError, subprocess.CalledProcessError):
            pass
        time.sleep(0.5)
    raise AssertionError("service did not become ready")


# Internal probes use the gateway's socket, including when a CDP key is set.
COOKIE_PROBE = r"""
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from '/usr/local/lib/cdp-gateway/node_modules/ws/wrapper.mjs';
const socketPath = '/tmp/agentene/cdp-gateway.sock';
const version = await new Promise((resolve, reject) => {
  http.get({ socketPath, path: '/json/version' }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject);
});
const ws = new WebSocket('ws+unix://' + socketPath + ':' + new URL(version.webSocketDebuggerUrl).pathname);
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
const timer = setTimeout(() => { throw new Error('cookie probe timed out'); }, 10000);
const command = (method, params = {}) => new Promise((resolve, reject) => {
  ws.once('message', (frame) => {
    const message = JSON.parse(frame);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  ws.send(JSON.stringify({ id: 1, method, params }));
});
if (process.env.MODE === 'set') {
  await command('Storage.setCookies', { cookies: [{ name: 'console_restart', value: 'saved', domain: 'example.com', path: '/', expires: Date.now() / 1000 + 3600 }] });
} else {
  assert.ok((await command('Storage.getCookies')).cookies.some((c) => c.name === 'console_restart' && c.value === 'saved'));
}
clearTimeout(timer);
ws.close();
"""


def smoke(image, user):
    name = f"console-restart-{os.getpid()}-{user}"
    # Ask the OS for free ports, then publish them explicitly: Docker may
    # allocate different ports after a restart for an empty host-port binding.
    with socket.socket() as web_socket, socket.socket() as cdp_socket:
        web_socket.bind(("127.0.0.1", 0))
        cdp_socket.bind(("127.0.0.1", 0))
        web_port = web_socket.getsockname()[1]
        cdp_port = cdp_socket.getsockname()[1]
    started = time.monotonic()
    docker("run", "-d", "--name", name, "--restart", "always", "--shm-size=512m",
           "-p", f"127.0.0.1:{web_port}:80", "-p", f"127.0.0.1:{cdp_port}:9222",
           "-e", f"RUN_USER={user}", "-e", "AUTH_SETUP_CODE=restart-smoke",
           "-e", "SELKIES_SUBFOLDER=/remote", image)
    try:
        info = json.loads(docker("inspect", name))[0]
        ports = info["NetworkSettings"]["Ports"]
        web = "http://127.0.0.1:" + ports["80/tcp"][0]["HostPort"]
        cdp = "http://127.0.0.1:" + ports["9222/tcp"][0]["HostPort"]
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

        def request(url, method="GET", body=None, headers=None, status=200):
            headers = dict(headers or {})
            if body is not None:
                headers["Content-Type"] = "application/json"
            req = urllib.request.Request(url, method=method, headers=headers,
                                         data=None if body is None else json.dumps(body).encode())
            try:
                res = opener.open(req, timeout=5)
            except urllib.error.HTTPError as error:
                res = error
            with res:
                data = res.read()
                assert res.status == status, (url, res.status, data[:200])
                return json.loads(data) if "application/json" in res.headers.get("Content-Type", "") else data

        wait_for(lambda: urllib.request.urlopen(cdp + "/json/version", timeout=2).status == 200)
        console = web + "/console/api"
        write = {"X-CDP-Console": "1"}
        request(console + "/restart", "POST", headers=write, status=401)
        request(web + "/console/__auth/api/setup", "POST", {"code": "restart-smoke", "username": "admin", "password": "smoke-password"})
        assert request(console + "/restart") == {"enabled": True}
        request(console + "/restart", "POST", status=403)
        request(console + "/restart", "DELETE", headers=write, status=405)
        # Session cookies protect the console even if the CDP API needs a key.
        request(web + "/console/__auth/api/apikey", "PUT", {"currentPassword": "smoke-password", "apiKey": "restart-smoke-api-key"})
        request(console + "/settings", "PATCH", {"revision": request(console + "/settings")["revision"], "patch": {"desktop": {"raiseNewWindows": False}}}, write)
        request(console + "/browsers", "POST", headers=write, status=201)
        # Docker begins monitoring restart policy after a successful 10s run.
        time.sleep(max(0, 10 - (time.monotonic() - started)))
        docker("exec", "-e", "MODE=set", name, "node", "--input-type=module", "-e", COOKIE_PROBE)
        before = json.loads(docker("inspect", name))[0]["State"]["StartedAt"]
        assert request(console + "/restart", "POST", headers=write, status=202) == {"ok": True}

        def restarted():
            now = json.loads(docker("inspect", name))[0]
            return now["RestartCount"] == 1 and now["State"]["Running"] and now["State"]["StartedAt"] != before

        wait_for(restarted)
        wait_for(lambda: request(web + "/console/__auth/api/state").get("authorized"))
        assert request(console + "/settings")["values"]["desktop"]["raiseNewWindows"] is False
        assert request(console + "/restart") == {"enabled": True}
        assert b"<html" in request(web + "/remote/")
        assert b"settings-page" in request(web + "/console/")
        request(cdp + "/json/version", status=401)
        assert request(cdp + "/json/version", headers={"Authorization": "Bearer restart-smoke-api-key"})["Browser"]
        docker("exec", "-e", "MODE=check", name, "node", "--input-type=module", "-e", COOKIE_PROBE)
        assert json.loads(docker("exec", name, "node", "-e", "console.log(JSON.stringify(require('fs').readdirSync('/browser/contexts')))")) == []
        assert json.loads(docker("inspect", name))[0]["RestartCount"] == 1
        print(f"Console container restart OK (RUN_USER={user}, login, API key, cookie, settings, subfolder)", flush=True)
    except Exception:
        subprocess.run(["docker", "logs", name], check=False)
        subprocess.run(["docker", "exec", name, "cat", "/tmp/cdp-gateway.log"], check=False)
        raise
    finally:
        docker("rm", "-f", name)


if __name__ == "__main__":
    for run_user in ["browser", "0"]:
        smoke(sys.argv[1], run_user)
