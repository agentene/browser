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
LEGACY = "CHROMIUM_AUTOSTART CHROMIUM_IDLE_TIMEOUT CHROMIUM_START_URL CHROMIUM_LANG CHROMIUM_HEADLESS CHROMIUM_GPU CDP_CONTEXTS_MAX CDP_CONTEXTS_OVERFLOW CDP_CONTEXTS_HIBERNATED_MAX CDP_INPUT_OVERLAY SCREEN_GEOMETRY SELKIES_ENABLE_RESIZE SELKIES_AUDIO_ON_START SELKIES_MANUAL_RESOLUTION SELKIES_MANUAL_WIDTH SELKIES_MANUAL_HEIGHT".split()


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


def run(backend, cdp=True, stream=True):
    name = f"settings-{os.getpid()}-{backend}"
    scratch = Path.cwd() / ".docker-tmp"
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="settings-smoke-", dir=scratch) as data:
        Path(data).chmod(0o755)
        settings_dir = Path(data) / "settings"
        settings_dir.mkdir()
        (settings_dir / "settings.json").write_text(json.dumps({
            "browser": {"idleTimeout": 1, "autostart": True, "headless": True, "gpu": "off", "startUrl": "https://removed.invalid/"},
            "desktop": {"width": 1600, "height": 900, "resize": False, "resizeLocked": True},
            "media": {"audioOnStart": False, "audioLocked": True},
        }))
        profile = Path(data) / "user-data" / "Default"
        profile.mkdir(parents=True)
        (profile / "Preferences").write_text(json.dumps({"session": {"restore_on_startup": 4, "startup_urls": ["chrome://version/"]}}))
        args = ["run", "-d", "-e", "LISTEN_ADDR=0.0.0.0", "--name", name, "--shm-size=512m", "-p", "127.0.0.1::80", "-p", "127.0.0.1::9222",
                "-v", f"{data}:/browser", "-e", f"DISPLAY_BACKEND={'x11' if backend.endswith('x11') else 'wayland'}",
                "-e", f"ENABLE_SELKIES={str(stream).lower()}", "-e", f"ENABLE_CDP={str(cdp).lower()}",
                "-e", "BROWSER_SUBPATH=/desk", "-e", "AUTH_SETUP_CODE=settings-smoke-code",
                "-e", "RUN_USER=1002:1002",
                "-e", "SELKIES_EXTRA_ARGS=--enable-resize=false --manual-resolution=true --manual-width=640 --manual-height=480 --audio-on-start=false|locked"]
        for key in LEGACY:
            args += ["-e", f"{key}=legacy-must-be-ignored"]
        docker(*args, IMAGE)
        try:
            ports = json.loads(docker("inspect", name))[0]["NetworkSettings"]["Ports"]
            web = f"http://127.0.0.1:{ports['80/tcp'][0]['HostPort']}"
            browser = f"http://127.0.0.1:{ports['9222/tcp'][0]['HostPort']}"
            base = web
            api = base + "/console/api"
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

            def request(url, method="GET", body=None, status=200, language=None):
                headers = {"X-CDP-Console": "1"}
                if language is not None:
                    headers["Accept-Language"] = language
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
                with opener.open(base + "/console/__auth/api/state", timeout=5) as response:
                    return response.status == 200

            wait_for(lambda: "all services up" in docker("logs", name))
            wait_for(ready)
            request(api + "/settings", status=401)
            request(base + "/console/__auth/api/setup", "POST", {"code": "settings-smoke-code", "username": "admin", "password": "settings-test-password"})
            initial = request(api + "/settings")
            assert initial["values"]["browser"]["language"] == "auto"
            assert initial["fields"]["browser"]["language"]["options"][0] == "auto"
            assert initial["fields"]["browser"]["language"]["available"] is True
            assert request(api + "/settings", language="zh-CN;q=0.2,en-US;q=1")["autoLanguage"] == "zh-CN"
            assert request(api + "/settings", language="ja-JP,zh-CN;q=0.9")["autoLanguage"] == "ja-JP"
            assert set(initial["fields"]["browser"]) == {"language"}
            assert set(initial["fields"]["desktop"]) == {"raiseNewWindows", "resolution"}
            assert initial["values"]["desktop"]["resolution"] == "1600x900"
            assert "media" not in initial["fields"] and "media" not in initial["values"]
            assert initial["values"]["contexts"]["maxRunning"] == 4
            assert initial["capabilities"]["browser"] == cdp
            assert initial["capabilities"]["desktop"] is True
            assert initial["capabilities"]["stream"] == stream
            for key in LEGACY:
                assert f"{key} is ignored" in docker("logs", name)
            assert not docker("exec", name, "sh", "-c", "pgrep -x chrome || true"), "main browser must stay stopped even with old autostart=true"
            before = initial["revision"]
            request(api + "/settings", "PATCH", {"revision": before, "patch": {"desktop": {"resolution": "-1x720"}}}, status=400)
            assert request(api + "/settings")["revision"] == before

            def patch(values, status=200, **extra):
                return request(api + "/settings", "PATCH", {"revision": request(api + "/settings")["revision"], "patch": values, **extra}, status)

            def page_value(target, expression):
                probe = "const ws = new WebSocket(process.argv[1]); ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:process.argv[2],returnByValue:true}})); ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){console.log(JSON.stringify(m.result.result.value));ws.close();}}; ws.onerror=()=>process.exit(1);"
                return json.loads(subprocess.check_output(["node", "-e", probe, target["webSocketDebuggerUrl"], expression], text=True, timeout=10))

            def page_language(target):
                return page_value(target, "navigator.language")

            def native_startup():
                targets = wait_for(lambda: request(browser + "/json/list"))
                assert len([t for t in targets if t["type"] == "page"]) == 1, targets
                target = next(t for t in targets if t["url"].startswith("chrome://version"))
                return target

            def new_browser(language=None):
                existing = {t["id"] for t in request(browser + "/json/list")}
                created = request(api + "/browsers", "POST", status=201, language=language)["name"]
                target = next(t for t in request(browser + "/json/list") if t["type"] == "page" and t["id"] not in existing)
                assert target["url"] == "about:blank", target
                return created, target

            def main_language():
                target = request(browser + "/json/new?about:blank", "PUT")
                try:
                    return page_language(target)
                finally:
                    request(browser + "/json/close/" + target["id"])

            if cdp:
                if backend == "cdp-wayland":
                    # A persisted one-minute timeout from an older image must not
                    # close an unattended browser. Listings do not keep it busy.
                    request(api + "/main/start", "POST")
                    pid = docker("exec", name, "pgrep", "-o", "-x", "chrome")
                    for _ in range(16):
                        time.sleep(5)
                        assert docker("exec", name, "pgrep", "-o", "-x", "chrome") == pid
                    request(api + "/main/stop", "POST")
                    assert not docker("exec", name, "sh", "-c", "pgrep -x chrome || true")
                    print("Unattended main browser survives the retired idle timeout; manual Stop still works", flush=True)
                # Locale changes affect new processes, including wake and main
                # relaunch, without touching existing browsers or the container.
                started_at = json.loads(docker("inspect", name))[0]["State"]["StartedAt"]
                request(api + "/main/start", "POST")
                assert page_value(native_startup(), "[screen.width, screen.height]") == [1600, 900]
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

                patch({"browser": {"language": "auto"}})
                chinese, chinese_target = new_browser("zh-CN;q=0.2,en-US;q=1")
                french, french_target = new_browser("fr-FR,zh-CN;q=0.9")
                assert page_language(chinese_target) == "zh-CN"
                assert page_language(french_target) == "fr-FR"
                request(api + "/" + chinese + "/hibernate", "POST")
                request(api + "/" + chinese + "/wake", "POST", language="ja-JP,en-US;q=0.9")
                assert page_language(chinese_target) == "ja-JP"
                assert page_language(french_target) == "fr-FR"
                request(api + "/main/stop", "POST")
                request(api + "/main/start", "POST", language="zh-CN,en-US;q=0.9")
                assert main_language() == "zh-CN"
                request(api + "/" + chinese, "DELETE")
                request(api + "/" + french, "DELETE")
                assert request(api + "/settings")["values"]["browser"]["language"] == "auto"
                print(f"Auto language follows each creation/wake/start request header: {backend}", flush=True)

            if cdp:
                result = patch({"contexts": {"maxRunning": 2}})
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
                pending = patch({"browser": {"language": "zh-CN"}})
                assert "browser.language" not in pending["pendingRestart"]
            else:
                assert patch({"browser": {"language": "zh-CN"}})["values"]["browser"]["language"] == "zh-CN"
                assert patch({"browser": {"language": "auto"}})["values"]["browser"]["language"] == "auto"
                request(api + "/main/start", "POST", status=403)
                assert request(api + "/browsers")["enabled"] is False
                # The browser API is also refused on the internal socket.
                code = docker("exec", name, "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--unix-socket", "/tmp/agentene/console.sock", "http://gateway/json/version")
                assert code == "404"
                docker("exec", name, "test", "!", "-S", "/tmp/agentene/cdp-gateway.sock")
                assert "cdp:9222" not in docker("logs", name)
            pending = patch({"desktop": {"resolution": "1280x720"}})
            assert pending["pendingRestart"] == ["desktop.resolution"]
            if stream:
                if cdp:
                    for mode in ["off", "keys", "text"]:
                        assert patch({"overlay": {"mode": mode}})["effective"]["overlay"]["mode"] == mode
                    assert b"/console/overlay.js" in request(web + "/desk/")
            else:
                assert initial["fields"]["desktop"]["resolution"]["available"]
                assert not initial["fields"]["overlay"]["mode"]["available"]
            desired = request(api + "/settings")["values"]
            docker("restart", name)
            ports = json.loads(docker("inspect", name))[0]["NetworkSettings"]["Ports"]
            web = f"http://127.0.0.1:{ports['80/tcp'][0]['HostPort']}"
            browser = f"http://127.0.0.1:{ports['9222/tcp'][0]['HostPort']}"
            base = web
            api = base + "/console/api"
            wait_for(ready)
            restored = request(api + "/settings")
            assert restored["values"] == desired
            assert restored["pendingRestart"] == []
            assert restored["errors"] == {}
            assert not docker("exec", name, "sh", "-c", "pgrep -x chrome || true")
            if cdp:
                request(api + "/main/start", "POST")
                target = native_startup()
                assert page_value(target, "[screen.width, screen.height]") == [1280, 720]
                assert page_language(target) == "zh-CN"
                prefs = json.loads(docker("exec", name, "cat", "/browser/user-data/Default/Preferences"))
                assert "zh-CN" in prefs["intl"]["accept_languages"]
                flags = docker("exec", name, "cat", "/tmp/cdp-gateway-main-flags")
                assert "--headless" not in flags
                assert "--enable-unsafe-swiftshader" in flags
                assert "removed.invalid" not in flags
                # The actual process, including in CDP-only mode, has a desktop.
                command = page_value(target, "document.querySelector('#command_line').textContent")
                assert "--headless" not in command, command
                assert ("--ozone-platform=wayland" if not backend.endswith("x11") else "--window-position=0,0") in command, command
            else:
                assert not docker("exec", name, "sh", "-c", "pgrep -x chrome || true")
            if stream:
                # Inspect Selkies' actual argv/environment, not just our JSON.
                details = docker("exec", "--user", "1002:1002", name, "python3", "-c", "from pathlib import Path; import json; out=[]\nfor p in Path('/proc').glob('[0-9]*'):\n try:\n  a=(p/'cmdline').read_bytes().split(b'\\0'); e=(p/'environ').read_bytes().split(b'\\0')\n  if b'--enable-resize=true|locked' in a: out.append({'args':[x.decode() for x in a], 'audio':[x.decode() for x in e if x.startswith(b'SELKIES_AUDIO_ON_START=')]})\n except (OSError,PermissionError): pass\nprint(json.dumps(out))")
                observed = json.loads(details)
                assert observed and observed[0]["audio"] == [], observed
                args = [arg for arg in observed[0]["args"] if arg]
                assert args.index("--enable-resize=true|locked") > args.index("--enable-resize=false")
                assert "--manual-resolution=false|locked" in args, args
                assert args.index("--manual-width=0") > args.index("--manual-width=640"), args
                assert args.index("--manual-height=0") > args.index("--manual-height=480"), args
                # Fixed on by default, without locking the viewer's audio toggle.
                assert args.index("--audio-on-start=true") > args.index("--audio-on-start=false|locked"), args
            print(f"Settings smoke OK: {backend}, CDP={cdp}, stream={stream}, authenticated, subpath, UID=1002", flush=True)
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


for mode in sys.argv[2:] or ["wayland", "x11", "desktop-only", "cdp-wayland", "cdp-x11"]:
    run(mode, cdp=mode != "desktop-only", stream=not mode.startswith("cdp-"))
