"""Noninteractive local TTS supervisor. Secrets stay in the existing profile/.env."""
import argparse
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

import psutil

LOG = logging.getLogger("tts-service")
FUNCTIONS = ["toytalk-stream-handler-lambda", "toytalk-api-stream-for-esp32-lambda",
             "toytalker-backchannel-for-app-lambda", "toytalker-backchannel-for-esp32-lambda",
             "toytalker-tts-only-lambda",
             "toytalker-device-setting-lambda"]   # clone-voice registration (/v1/speakers/register); missed until 2026-09-13


def get_json(url):
    # Local and public health checks must not inherit an interactive shell's proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    # Cloudflare's browser integrity check rejects the default "Python-urllib" User-Agent with 403.
    headers = {"ngrok-skip-browser-warning": "1", "User-Agent": "toytalker-supervisor/1.0"}
    # Edge passphrase checked by a Cloudflare WAF custom rule (ZAKICORP_EDGE_KEY comes from scripts/.env).
    if os.environ.get("ZAKICORP_EDGE_KEY"):
        headers["X-Zakicorp-Edge-Key"] = os.environ["ZAKICORP_EDGE_KEY"]
    req = urllib.request.Request(url, headers=headers)
    with opener.open(req, timeout=10) as response:
        return json.load(response)


def aws(config, *args):
    result = subprocess.run(
        [config["aws"], *args, "--region", "ap-northeast-1", "--output", "json", "--no-cli-pager"],
        capture_output=True, timeout=90, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        # CLI stderr may contain configuration/secrets; never copy it into service logs.
        raise RuntimeError(f"AWS {args[0]} {args[1]} failed (exit {result.returncode})")
    return json.loads(result.stdout)


def configure_environment(config):
    os.environ["USERPROFILE"] = config["profile"]
    os.environ["AWS_SHARED_CREDENTIALS_FILE"] = str(Path(config["profile"]) / ".aws/credentials")
    os.environ["AWS_CONFIG_FILE"] = str(Path(config["profile"]) / ".aws/config")
    os.environ["PYTHONUNBUFFERED"] = "1"
    os.environ["PYTHONIOENCODING"] = "utf-8"
    for line in (Path(config["root"]) / "scripts/.env").read_text(encoding="utf-8-sig").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip()
    if not os.environ.get("ZAKICORP_API_KEY"):
        raise RuntimeError("ZAKICORP_API_KEY is missing; refusing to start an unauthenticated API")


def find_process(executable, argument, root=None):
    matches = []
    for process in psutil.process_iter(["exe", "cmdline"]):
        try:
            if (os.path.normcase(process.info["exe"] or "") == os.path.normcase(executable)
                    and argument in (process.info["cmdline"] or [])
                    and (root is None or os.path.normcase(process.cwd()) == os.path.normcase(root))):
                matches.append(process)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    if len(matches) > 1:
        raise RuntimeError("Multiple matching processes; refusing to launch another")
    return matches[0] if matches else None


class Component:
    def __init__(self, name, command, match_arg, config):
        self.name, self.command, self.match_arg, self.config = name, command, match_arg, config
        self.process = None
        self.owned = False
        self.failed_since = None
        self.next_start = 0

    def ensure_running(self):
        if self.process is not None and self.process.is_running():
            return
        if self.process is not None:
            LOG.warning("%s exited; retry in 30 seconds", self.name)
            self.process = None
            self.next_start = time.monotonic() + 30
        if time.monotonic() < self.next_start:
            return
        self.process = find_process(self.command[0], self.match_arg,
                                    self.config["root"] if self.name == "api" else None)
        if self.process:
            self.owned = False
            LOG.info("%s adopting existing pid=%s", self.name, self.process.pid)
        else:
            with (Path(self.config["logs"]) / f"{self.name}.log").open("ab") as output:
                child = subprocess.Popen(self.command, cwd=self.config["root"], stdout=output,
                                         stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
            self.process = psutil.Process(child.pid)
            self.owned = True
            LOG.info("%s launched pid=%s", self.name, child.pid)
        self.failed_since = time.monotonic()

    def health(self, healthy):
        if healthy:
            if self.failed_since is not None:
                LOG.info("%s ready", self.name)
            self.failed_since = None
        elif self.process:
            if self.failed_since is None:
                LOG.warning("%s health unavailable", self.name)
                self.failed_since = time.monotonic()
            # Loading the model and a long inference can block /health. Allow 10 minutes.
            if self.owned and time.monotonic() - self.failed_since > 600:
                LOG.error("%s unhealthy for 600 seconds; restarting owned process", self.name)
                self.process.terminate()


def synchronize_urls(config, url):
    for name in FUNCTIONS:
        state = aws(config, "lambda", "get-function-configuration", "--function-name", name)
        variables = dict(state.get("Environment", {}).get("Variables", {}))
        if variables.get("ZAKICORP_TTS_URL") == url:
            continue
        variables["ZAKICORP_TTS_URL"] = url
        # Pass JSON without a shell and use RevisionId to avoid overwriting concurrent edits.
        aws(config, "lambda", "update-function-configuration", "--function-name", name,
            "--revision-id", state["RevisionId"], "--environment", json.dumps({"Variables": variables}))
        LOG.info("Updated TTS URL for %s", name)


def probe(config):
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable")
    torch.zeros(1, device="cuda").sum().item()
    health = get_json("http://127.0.0.1:8000/health")
    if health.get("status") != "ok":
        raise RuntimeError("Local TTS not ready")
    url = (config.get("public_url") or "").rstrip("/")
    if not url:
        tunnels = get_json("http://127.0.0.1:4040/api/tunnels")["tunnels"]
        url = next(t["public_url"] for t in tunnels if t["public_url"].startswith("https://"))
    if get_json(url + "/health").get("status") != "ok":
        raise RuntimeError("Public TTS not ready")
    aws(config, "lambda", "get-function-configuration", "--function-name", FUNCTIONS[0],
        "--query", "FunctionName")
    if not Path(config["ngrok_config"]).is_file():
        raise RuntimeError("ngrok config missing")
    LOG.info("PROBE PASSED: session=%s CUDA allocation, .env, local/public health, AWS read, ngrok config",
             psutil.Process().username())


def run(config):
    # "api_script" selects the API entry point in the TTS repo (api_server.py or api_server_batch.py).
    api_script = config.get("api_script", "api_server.py")
    api = Component("api", [sys.executable, "-u", api_script], api_script, config)
    public_url = (config.get("public_url") or "").rstrip("/") or None
    LOG.info("API entry point: %s; public URL: %s", api_script, public_url or "ngrok (dynamic)")
    # "public_url" (a Cloudflare Tunnel hostname served by its own Windows service) is a fixed address:
    # publish it to the Lambdas and do not run ngrok at all. Clearing public_url brings ngrok back
    # (see docs/tts-boot-recovery.md). ngrok is only used when public_url is unset.
    tunnel = None
    if public_url:
        stray = find_process(config["ngrok"], "8000")
        if stray:
            LOG.info("public_url is set; stopping standby ngrok pid=%s", stray.pid)
            stray.terminate()
    else:
        tunnel = Component("ngrok", [config["ngrok"], "http", "8000", "--config", config["ngrok_config"]], "8000", config)
    synced_url = None
    next_sync = 0
    last_error = None
    while True:
        try:
            api.ensure_running()
            try:
                healthy = get_json("http://127.0.0.1:8000/health").get("status") == "ok"
            except Exception:
                healthy = False
            api.health(healthy)
            if tunnel is not None:
                tunnel.ensure_running()
                try:
                    tunnels = get_json("http://127.0.0.1:4040/api/tunnels")["tunnels"]
                    url = next(t["public_url"] for t in tunnels if t["public_url"].startswith("https://"))
                except Exception:
                    url = None
                tunnel.health(bool(url))
            else:
                url = public_url
            if healthy and url and (url != synced_url or time.monotonic() >= next_sync):
                # Do not publish an endpoint until it actually responds through ngrok.
                if get_json(url + "/health").get("status") != "ok":
                    raise RuntimeError("Public TTS not ready")
                synchronize_urls(config, url)
                if url != synced_url:
                    LOG.info("Service ready; public health and Lambda URLs verified")
                synced_url, next_sync = url, time.monotonic() + 300
            last_error = None
        except Exception as error:
            message = f"{type(error).__name__}: {error}"
            if message != last_error:
                LOG.error("Recovery loop: %s", message)
            last_error = message
        time.sleep(15)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    Path(config["logs"]).mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=Path(config["logs"]) / ("probe.log" if args.probe else "supervisor.log"),
                        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        configure_environment(config)
        if args.probe:
            probe(config)
        else:
            LOG.info("Supervisor starting as %s", psutil.Process().username())
            run(config)
    except Exception as error:
        LOG.error("Startup failed: %s: %s", type(error).__name__, error)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
