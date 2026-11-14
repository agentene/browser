#!/usr/bin/env python3
"""Persisted web settings across live apply, restart and service modes."""
import http.cookiejar
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

IMAGE = sys.argv[1]
LEGACY = "CHROMIUM_AUTOSTART CHROMIUM_IDLE_TIMEOUT CHROMIUM_START_URL CHROMIUM_LANG CHROMIUM_HEADLESS CHROMIUM_GPU CDP_CONTEXTS_MAX CDP_CONTEXTS_OVERFLOW CDP_CONTEXTS_HIBERNATED_MAX CDP_INPUT_OVERLAY SCREEN_GEOMETRY SELKIES_ENABLE_RESIZE SELKIES_AUDIO_ON_START".split()


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.STDOUT).strip()


def wait_for(fn, seconds=50):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        try:
            result = fn()
            if result:
                return result
        except (OSError, ValueError, subprocess.CalledProcessError) as error:
            last = error
        time.sleep(0.25)
    raise AssertionError(f"timed out: {last}")


def run(backend, cdp=True, desktop=True):
    name = f"settings-{os.getpid()}-{backend}"
    scratch = Path.cwd() / ".docker-tmp"
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="settings-smoke-", dir=scratch) as data:
        Path(data).chmod(0o755)
        settings_dir = Path(data) / "settings"
        settings_dir.mkdir()
        (settings_dir / "settings.json").write_text(json.dumps({"browser": {"autostart": False}}))
        args = ["run", "-d", "--name", name, "--shm-size=512m", "-p", "127.0.0.1::80", "-p", "127.0.0.1::9222",
                "-v", f"{data}:/browser", "-e", f"DISPLAY_BACKEND={'x11' if backend == 'x11' else 'wayland'}",
                "-e", f"ENABLE_SELKIES={str(desktop).lower()}", "-e", f"ENABLE_CDP={str(cdp).lower()}",
                "-e", "SELKIES_SUBFOLDER=/desk", "-e", "AUTH_SETUP_CODE=settings-smoke-code",
                "-e", "RUN_USER=1002:1002"]
        for key in LEGACY:
            args += ["-e", f"{key}=legacy-must-be-ignored"]
        docker(*args, IMAGE)
        try:
            ports = json.loads(docker("inspect", name))[0]["NetworkSettings"]["Ports"]
            web = f"http://127.0.0.1:{ports['80/tcp'][0]['HostPort']}/desk"
            browser = f"http://127.0.0.1:{ports['9222/tcp'][0]['HostPort']}"
            base = web if desktop else browser
            api = base + ("/cdp-console/api" if desktop else "/console/api")
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

            def request(url, method="GET", body=None, status=200):
                headers = {"X-CDP-Console": "1"}
                if body is not None:
                    headers["Content-Type"] = "application/json"
                req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
                try:
                    response = opener.open(req, timeout=5)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    raw = response.read()
                    assert response.status == status, (url, response.status, raw[:500])
                    return json.loads(raw) if "application/json" in response.headers.get("Content-Type", "") else raw

            def ready():
                # PID 1 logs readiness just after starting nginx; its listener
                # and auth upstream can still be opening on a fast CDP-only boot.
                with opener.open(base + "/__auth/api/state", timeout=5) as response:
                    return response.status == 200

            wait_for(lambda: "all services up" in docker("logs", name))
            wait_for(ready)
            request(api + "/settings", status=401)
            request(base + "/__auth/api/setup", "POST", {"code": "settings-smoke-code", "username": "admin", "password": "settings-test-password"})
            initial = request(api + "/settings")
            assert initial["values"]["browser"]["autostart"] is False
            assert initial["values"]["contexts"]["maxRunning"] == 4
            assert initial["capabilities"]["browser"] == cdp
            assert initial["capabilities"]["desktop"] == desktop
            for key in LEGACY:
                assert f"{key} is ignored" in docker("logs", name)
            assert not docker("exec", name, "sh", "-c", "pgrep -x chrome || true"), "autostart was ignored"
            before = initial["revision"]
            request(api + "/settings", "PATCH", {"revision": before, "patch": {"desktop": {"width": -1}}}, status=400)
            assert request(api + "/settings")["revision"] == before

            def patch(values, status=200, **extra):
                return request(api + "/settings", "PATCH", {"revision": request(api + "/settings")["revision"], "patch": values, **extra}, status)

            def page_language(target):
                probe = "const ws = new WebSocket(process.argv[1]); ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'navigator.language',returnByValue:true}})); ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){console.log(m.result.result.value);ws.close();}}; ws.onerror=()=>process.exit(1);"
                return subprocess.check_output(["node", "-e", probe, target["webSocketDebuggerUrl"]], text=True, timeout=10).strip()

            def new_browser():
                existing = {t["id"] for t in request(browser + "/json/list")}
                created = request(api + "/browsers", "POST", status=201)["name"]
                target = next(t for t in request(browser + "/json/list") if t["type"] == "page" and t["id"] not in existing)
                return created, target

            def main_language():
                target = request(browser + "/json/new?about:blank", "PUT")
                try:
                    return page_language(target)
                finally:
                    request(browser + "/json/close/" + target["id"])

            if cdp:
                # Locale changes affect new processes, including wake and main
                # relaunch, without touching existing browsers or the container.
                started_at = json.loads(docker("inspect", name))[0]["State"]["StartedAt"]
                request(api + "/main/start", "POST")
                assert main_language() == "en-US"
                old_name, old_target = new_browser()
                assert page_language(old_target) == "en-US"
                changed = patch({"browser": {"language": "zh-CN"}})
                assert "browser.language" not in changed["pendingRestart"]
                assert changed["fields"]["browser"]["language"]["type"] == "select"
                assert main_language() == "en-US"
                assert page_language(old_target) == "en-US"
                new_name, new_target = new_browser()
                assert page_language(new_target) == "zh-CN"
                request(api + "/" + old_name + "/hibernate", "POST")
                patch({"browser": {"language": "ja-JP"}})
                request(api + "/" + old_name + "/wake", "POST")
                assert page_language(old_target) == "ja-JP"
                assert page_language(new_target) == "zh-CN"
                request(api + "/main/stop", "POST")
                request(api + "/main/start", "POST")
                assert main_language() == "ja-JP"
                assert json.loads(docker("inspect", name))[0]["State"]["StartedAt"] == started_at
                assert request(api + "/settings")["revision"].split(":")[0] == before.split(":")[0]
                request(api + "/" + old_name, "DELETE")
                request(api + "/" + new_name, "DELETE")
                print(f"Browser language applies on new/woken/restarted processes without a container restart: {backend}", flush=True)

            if cdp:
                result = patch({"contexts": {"maxRunning": 2}, "browser": {"idleTimeout": 1}})
                assert result["effective"]["contexts"]["maxRunning"] == 2
                request(api + "/settings", "PATCH", {"revision": before, "patch": {"contexts": {"maxRunning": 1}}}, status=409)
                names = [request(api + "/browsers", "POST", status=201)["name"] for _ in range(3)]
                preview = patch({"contexts": {"maxHibernated": 0}}, status=409)
                assert preview["code"] == "confirm_evictions" and len(preview["evictions"]) == 1
                assert request(api + "/settings")["values"]["contexts"]["maxHibernated"] == 16
                patch({"contexts": {"maxHibernated": 0}}, confirmation=preview["confirmation"])
                removed = preview["evictions"][0]["name"]
                assert not (Path(data) / "contexts" / removed).exists()
                for item in names:
                    if item != removed:
                        request(api + "/" + item, "DELETE")
                pending = patch({"browser": {"language": "zh-CN", "gpu": "off", "headless": True, "startUrl": "data:text/html,%3Ctitle%3EConfigured%3C/title%3E"}})
                assert "browser.language" not in pending["pendingRestart"]
            else:
                request(api + "/main/start", "POST", status=403)
                assert request(api + "/browsers")["enabled"] is False
                # The browser API is also refused on the internal socket.
                code = docker("exec", name, "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--unix-socket", "/tmp/agentene/cdp-gateway.sock", "http://gateway/json/version")
                assert code == "404"
                assert "cdp:9222" not in docker("logs", name)
            if desktop:
                pending = patch({"desktop": {"width": 1280, "height": 720, "resize": False}, "media": {"audioOnStart": True, "audioLocked": True}})
                assert "desktop.width" in pending["pendingRestart"]
                if cdp:
                    for mode in ["off", "keys", "text"]:
                        assert patch({"overlay": {"mode": mode}})["effective"]["overlay"]["mode"] == mode
                    assert b"cdp-console/overlay.js" in request(web + "/")
            else:
                assert initial["capabilities"]["actualHeadless"] is True
                assert not initial["fields"]["desktop"]["width"]["available"]
            desired = request(api + "/settings")["values"]
            docker("restart", name)
            ports = json.loads(docker("inspect", name))[0]["NetworkSettings"]["Ports"]
            web = f"http://127.0.0.1:{ports['80/tcp'][0]['HostPort']}/desk"
            browser = f"http://127.0.0.1:{ports['9222/tcp'][0]['HostPort']}"
            base = web if desktop else browser
            api = base + ("/cdp-console/api" if desktop else "/console/api")
            wait_for(ready)
            restored = request(api + "/settings")
            assert restored["values"] == desired
            assert restored["pendingRestart"] == []
            assert restored["errors"] == {}
            if cdp:
                request(api + "/main/start", "POST")
                targets = wait_for(lambda: request(browser + "/json/list"))
                assert any(t["url"] == desired["browser"]["startUrl"] for t in targets), targets
                target = next(t for t in targets if t["url"] == desired["browser"]["startUrl"])
                assert page_language(target) == "zh-CN"
                prefs = json.loads(docker("exec", name, "cat", "/browser/user-data/Default/Preferences"))
                assert "zh-CN" in prefs["intl"]["accept_languages"]
                flags = docker("exec", name, "cat", "/tmp/cdp-gateway-main-flags")
                assert "--headless" in flags
            else:
                assert not docker("exec", name, "sh", "-c", "pgrep -x chrome || true")
            if desktop:
                # Inspect Selkies' actual argv/environment, not just our JSON.
                details = docker("exec", "--user", "1002:1002", name, "python3", "-c", "from pathlib import Path; import json; out=[]\nfor p in Path('/proc').glob('[0-9]*'):\n try:\n  a=(p/'cmdline').read_bytes().split(b'\\0'); e=(p/'environ').read_bytes().split(b'\\0')\n  if b'--enable-resize=false' in a: out.append({'args':[x.decode() for x in a], 'audio':[x.decode() for x in e if x.startswith(b'SELKIES_AUDIO_ON_START=')]})\n except (OSError,PermissionError): pass\nprint(json.dumps(out))")
                observed = json.loads(details)
                assert observed and observed[0]["audio"] == ["SELKIES_AUDIO_ON_START=true|locked"], observed
            print(f"Settings smoke OK: {backend}, CDP={cdp}, desktop={desktop}, authenticated, subfolder, UID=1002", flush=True)
        except BaseException:
            print(docker("logs", "--tail", "60", name), file=sys.stderr)
            try:
                print(docker("exec", name, "tail", "-50", "/tmp/cdp-gateway.log"), file=sys.stderr)
            except subprocess.CalledProcessError:
                pass
            raise
        finally:
            docker("rm", "-fv", name)
            # The custom runtime UID owns files created on this disposable mount.
            docker("run", "--rm", "--network", "none", "--entrypoint", "chown", "-v", f"{data}:/data", IMAGE, "-R", f"{os.getuid()}:{os.getgid()}", "/data")


for mode in ["wayland", "x11", "desktop-only", "cdp-only"]:
    run(mode, cdp=mode != "desktop-only", desktop=mode != "cdp-only")
