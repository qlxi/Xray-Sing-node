#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Xray-Sing (Python)
Hysteria2 (UDP) + VLESS-WS (TCP) on one public port.
Optional Cloudflare Argo. Panel: http://HOST:PORT/sub

MIT License
"""

from __future__ import annotations

import base64
import json
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import unquote, urlparse


# ──────────────────────────── Config ────────────────────────────

def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, str(default)))
    except ValueError:
        return default


def _env_bool_off(key: str) -> bool:
    """True unless explicitly set to 0/false."""
    v = os.environ.get(key, "").lower()
    return v not in ("0", "false", "no", "off")


_PUBLIC_PORT = _env_int("SB_PORT", _env_int("SERVER_PORT", _env_int("PORT", 2705)))
_DEFAULT_UUID = _env("UUID") or str(uuid.uuid4())

CONFIG: Dict[str, Any] = {
    "UUID": _DEFAULT_UUID,
    "FILE_PATH": _env("FILE_PATH") or str(Path(os.environ.get("TMPDIR", "/tmp")) / "xray-sing"),
    "SUB_PATH": _env("SUB_PATH", "sub"),
    "PORT": _PUBLIC_PORT,
    "NAME": _env("NAME", "vless"),
    "CFIP": _env("CFIP", "www.kick.com"),
    "CFPORT": _env_int("CFPORT", 443),
    "ENABLE_ARGO": _env_bool_off("ENABLE_ARGO"),
    "ARGO_DOMAIN": _env("ARGO_DOMAIN"),
    "ARGO_AUTH": _env("ARGO_AUTH"),
    "ARGO_PORT": _env_int("ARGO_PORT", 8001),
    "SB_VERSION": _env("SB_VERSION", "1.11.15"),
    "SB_NAME": _env("SB_NAME", "HY2"),
    "SB_PORT": _PUBLIC_PORT,
    "VLESS_LOCAL_PORT": _env_int("VLESS_LOCAL_PORT", 12080),
    "SB_UUID": _env("SB_UUID") or _DEFAULT_UUID,
    "SB_SNI": _env("SB_SNI", "time.android.com"),
    "SB_MASS_PROXY": _env("SB_MASS_PROXY", "https://www.gstatic.com"),
    "SB_DOMAIN": _env("SB_DOMAIN") or _env("DOMAIN"),
    "SB_HOST": _env("SB_HOST", "127.0.0.1"),
    "SB_OBFS_PWD": _env("SB_OBFS_PWD"),
    "WS_PATH": _env("WS_PATH") or _env("SB_UUID") or _DEFAULT_UUID,
    "VLESS_NAME": _env("VLESS_NAME", "VLESS-WS"),
    "WEB_URL": _env("WEB_URL"),
    "BOT_URL": _env("BOT_URL"),
    "SB_URL": _env("SB_URL"),
}

_machine = platform.machine().lower()
ARCH = "arm64" if _machine in ("arm", "arm64", "aarch64") else "amd64"
TAR_NAME = f"sing-box-{CONFIG['SB_VERSION']}-linux-{ARCH}.tar.gz"
DOWNLOAD_URL = CONFIG["SB_URL"] or (
    f"https://github.com/SagerNet/sing-box/releases/download/v{CONFIG['SB_VERSION']}/{TAR_NAME}"
)

FILE_PATH = Path(CONFIG["FILE_PATH"])
PATHS = {
    "SB_BASE_DIR": FILE_PATH / "sb",
    "SB_CERT_DIR": FILE_PATH / "sb" / "cert",
    "SB_CERT_PATH": FILE_PATH / "sb" / "cert" / "cert.pem",
    "SB_KEY_PATH": FILE_PATH / "sb" / "cert" / "key.pem",
    "SB_JSON": FILE_PATH / "sb" / "sb.json",
    "SB_BIN": FILE_PATH / "sb" / "sb",
    "SB_LOG_FILE": FILE_PATH / "sb" / "sb.log",
    "X_CONFIG": FILE_PATH / "config.json",
    "BOOT_LOG": FILE_PATH / "boot.log",
}


class State:
    x_links: List[str] = []
    sbox_links: List[str] = []
    vless_ws_links: List[str] = []
    x_base64: str = ""
    sbox_base64: str = ""
    vless_ws_base64: str = ""
    sb_process: Optional[subprocess.Popen] = None


state = State()


# ──────────────────────────── Logger ────────────────────────────

class C:
    RESET = "\033[0m"
    BRIGHT = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"
    WHITE = "\033[37m"


class Log:
    quiet = os.environ.get("QUIET", "").lower() in ("1", "true", "yes")

    @classmethod
    def info(cls, msg: str) -> None:
        if not cls.quiet:
            print(f"{C.CYAN}ℹ {msg}{C.RESET}", flush=True)

    @classmethod
    def success(cls, msg: str) -> None:
        if not cls.quiet:
            print(f"{C.GREEN}✅ {msg}{C.RESET}", flush=True)

    @classmethod
    def warning(cls, msg: str) -> None:
        if not cls.quiet:
            print(f"{C.YELLOW}⚠ {msg}{C.RESET}", flush=True)

    @classmethod
    def error(cls, msg: str) -> None:
        print(f"{C.RED}❌ {msg}{C.RESET}", flush=True)

    @classmethod
    def step(cls, msg: str) -> None:
        if not cls.quiet:
            print(f"{C.BLUE}➤ {msg}{C.RESET}", flush=True)

    @classmethod
    def header(cls, msg: str) -> None:
        if not cls.quiet:
            line = "=" * 56
            print(f"\n{C.BRIGHT}{C.MAGENTA}{line}{C.RESET}", flush=True)
            print(f"{C.BRIGHT}{C.MAGENTA}  {msg}{C.RESET}", flush=True)
            print(f"{C.BRIGHT}{C.MAGENTA}{line}{C.RESET}\n", flush=True)

    @classmethod
    def config(cls, key: str, value: Any) -> None:
        if not cls.quiet:
            print(f"  {C.CYAN}{key}:{C.RESET} {C.YELLOW}{value}{C.RESET}", flush=True)

    @classmethod
    def clear_console(cls) -> None:
        try:
            sys.stdout.write("\033[2J\033[3J\033[H\033c")
            sys.stdout.flush()
        except Exception:
            pass
        print("\n" * 8, flush=True)


# ──────────────────────────── System utils ────────────────────────────

class SystemUtils:
    @staticmethod
    def ensure_dir(path: Path) -> None:
        path.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def get_public_ip() -> Optional[str]:
        ip_re = re.compile(
            r"\b((25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(?!$)|$)){4}\b"
        )
        urls = [
            "https://ifconfig.co",
            "https://api.ipify.org",
            "https://ifconfig.me/ip",
            "https://ifconfig.io/ip",
        ]
        for url in urls:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
                with urllib.request.urlopen(req, timeout=8) as resp:
                    text = resp.read().decode("utf-8", errors="ignore").strip()
                    m = ip_re.search(text)
                    if m:
                        return m.group(0)
            except Exception:
                continue
        try:
            out = subprocess.run(
                ["dig", "+short", "myip.opendns.com", "@resolver1.opendns.com"],
                capture_output=True,
                text=True,
                timeout=8,
            )
            if out.returncode == 0 and out.stdout:
                m = ip_re.search(out.stdout.strip())
                if m:
                    return m.group(0)
        except Exception:
            pass
        return None

    @staticmethod
    def sanitize_isp(s: str) -> str:
        s = re.sub(r"[^\w.\-]+", "_", s or "")
        s = re.sub(r"_+", "_", s).strip("_")
        return (s[:48] if s else "UNKNOWN")

    @staticmethod
    def get_isp_info() -> str:
        # Cloudflare meta
        try:
            req = urllib.request.Request(
                "https://speed.cloudflare.com/meta",
                headers={"User-Agent": "curl/8.0"},
            )
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode())
            org = data.get("asOrganization") or data.get("asn") or ""
            city = data.get("city") or data.get("colo") or ""
            label = "-".join(x for x in (org, city) if x)
            if label:
                return SystemUtils.sanitize_isp(label)
        except Exception:
            pass

        # ipinfo
        try:
            req = urllib.request.Request(
                "https://ipinfo.io/json", headers={"User-Agent": "curl/8.0"}
            )
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode())
            label = "-".join(
                x for x in (data.get("org"), data.get("city") or data.get("country")) if x
            )
            if label:
                return SystemUtils.sanitize_isp(label)
        except Exception:
            pass

        # ip-api
        try:
            req = urllib.request.Request(
                "http://ip-api.com/json/?fields=status,isp,org,as,city,country",
                headers={"User-Agent": "curl/8.0"},
            )
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode())
            if data.get("status") == "success":
                label = "-".join(
                    x
                    for x in (
                        data.get("isp") or data.get("org") or data.get("as"),
                        data.get("city") or data.get("country"),
                    )
                    if x
                )
                if label:
                    return SystemUtils.sanitize_isp(label)
        except Exception:
            pass

        return "UNKNOWN"

    @staticmethod
    def download_file(file_name: str, file_url: str, min_size: int = 1024) -> str:
        dest = FILE_PATH / file_name
        if file_name in ("web", "bot"):
            min_size = 500 * 1024
        if dest.exists() and dest.stat().st_size >= min_size:
            dest.chmod(0o755)
            Log.info(f"Already present, skip download: {file_name}")
            return file_name

        Log.step(f"Downloading {file_name}...")
        try:
            req = urllib.request.Request(file_url, headers={"User-Agent": "xray-sing/1.0"})
            with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as out:
                shutil.copyfileobj(resp, out)
            dest.chmod(0o755)
            Log.success(f"Downloaded: {file_name}")
            return file_name
        except Exception as e:
            if dest.exists():
                try:
                    dest.unlink()
                except OSError:
                    pass
            raise RuntimeError(f"Download error {file_name}: {e}") from e


# ──────────────────────────── sing-box ────────────────────────────

class SbManager:
    @staticmethod
    def get_server_host() -> str:
        if CONFIG["SB_DOMAIN"]:
            Log.info(f"Using domain: {CONFIG['SB_DOMAIN']}")
            return CONFIG["SB_DOMAIN"]
        public_ip = SystemUtils.get_public_ip()
        if public_ip:
            Log.info(f"Using public IP: {public_ip}")
            return public_ip
        Log.warning(f"Using fallback host: {CONFIG['SB_HOST']}")
        return CONFIG["SB_HOST"]

    @staticmethod
    def ensure_certificates() -> Tuple[Optional[str], Optional[str]]:
        SystemUtils.ensure_dir(PATHS["SB_CERT_DIR"])
        ext_cert = os.environ.get("EXTERNAL_CERT")
        ext_key = os.environ.get("EXTERNAL_KEY")
        if ext_cert and ext_key and Path(ext_cert).exists() and Path(ext_key).exists():
            Log.info("Using external TLS certificates")
            return ext_cert, ext_key

        cert, key = PATHS["SB_CERT_PATH"], PATHS["SB_KEY_PATH"]
        if not cert.exists() or not key.exists():
            Log.step("Generating self-signed TLS certificate")
            r = subprocess.run(
                [
                    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-subj", f"/CN={CONFIG['SB_SNI']}",
                    "-keyout", str(key),
                    "-out", str(cert),
                    "-days", "365",
                ],
                capture_output=True,
            )
            if r.returncode != 0:
                Log.error("Failed to generate TLS certificate")
                return None, None
            Log.success("TLS certificate generated")
        return str(cert), str(key)

    @staticmethod
    def ensure_binary() -> bool:
        if PATHS["SB_BIN"].exists():
            return True
        SystemUtils.ensure_dir(PATHS["SB_BASE_DIR"])
        Log.step(f"Downloading sing-box ({ARCH})")
        tar_path = PATHS["SB_BASE_DIR"] / TAR_NAME
        try:
            req = urllib.request.Request(DOWNLOAD_URL, headers={"User-Agent": "xray-sing/1.0"})
            with urllib.request.urlopen(req, timeout=120) as resp, open(tar_path, "wb") as out:
                shutil.copyfileobj(resp, out)
        except Exception as e:
            Log.error(f"Failed to download sing-box: {e}")
            return False

        try:
            with tarfile.open(tar_path, "r:gz") as tar:
                tar.extractall(PATHS["SB_BASE_DIR"])
        except Exception as e:
            Log.error(f"Failed to extract sing-box: {e}")
            return False

        extracted = PATHS["SB_BASE_DIR"] / f"sing-box-{CONFIG['SB_VERSION']}-linux-{ARCH}" / "sing-box"
        if extracted.exists():
            extracted.replace(PATHS["SB_BIN"])
            PATHS["SB_BIN"].chmod(0o755)
            try:
                tar_path.unlink(missing_ok=True)
                shutil.rmtree(extracted.parent, ignore_errors=True)
            except Exception:
                pass
            Log.success("sing-box installed")
            return True

        Log.error("sing-box binary not found in archive")
        return False

    @staticmethod
    def write_configuration(cert: str, key: str) -> None:
        Log.step("Creating sing-box configuration (Hysteria2 + VLESS-WS)")
        ws_path = CONFIG["WS_PATH"] if str(CONFIG["WS_PATH"]).startswith("/") else f"/{CONFIG['WS_PATH']}"

        config = {
            "log": {"level": "info", "timestamp": True},
            "inbounds": [
                {
                    "type": "hysteria2",
                    "tag": "hy2-in",
                    "listen": "::",
                    "listen_port": CONFIG["SB_PORT"],
                    "users": [{"password": CONFIG["SB_UUID"]}],
                    "tls": {
                        "enabled": True,
                        "server_name": CONFIG["SB_SNI"],
                        "alpn": ["h3"],
                        "certificate_path": cert,
                        "key_path": key,
                    },
                    "obfs": {"type": "salamander", "password": CONFIG["SB_OBFS_PWD"]},
                    "masquerade": {
                        "type": "proxy",
                        "url": CONFIG["SB_MASS_PROXY"],
                        "rewrite_host": True,
                    },
                    "ignore_client_bandwidth": False,
                    "up_mbps": 100,
                    "down_mbps": 100,
                },
                {
                    "type": "vless",
                    "tag": "vless-ws-in",
                    "listen": "127.0.0.1",
                    "listen_port": CONFIG["VLESS_LOCAL_PORT"],
                    "users": [{"uuid": CONFIG["SB_UUID"], "flow": ""}],
                    "tls": {"enabled": False},
                    "transport": {
                        "type": "ws",
                        "path": ws_path,
                        "max_early_data": 2560,
                        "early_data_header_name": "Sec-WebSocket-Protocol",
                    },
                },
            ],
            "outbounds": [
                {"type": "direct", "tag": "direct"},
                {"type": "block", "tag": "block"},
            ],
        }
        PATHS["SB_JSON"].write_text(json.dumps(config, indent=2), encoding="utf-8")
        Log.success(
            f"sb config: HY2 UDP :{CONFIG['SB_PORT']} + VLESS-WS 127.0.0.1:{CONFIG['VLESS_LOCAL_PORT']}"
        )

    @staticmethod
    def start() -> Optional[subprocess.Popen]:
        Log.step("Starting sing-box...")
        if not PATHS["SB_BIN"].exists():
            Log.error("sing-box binary not found")
            return None

        check = subprocess.run(
            [str(PATHS["SB_BIN"]), "check", "-c", str(PATHS["SB_JSON"])],
            capture_output=True,
            text=True,
        )
        if check.returncode != 0:
            Log.error(f"sing-box configuration error: {check.stderr}")
            return None
        Log.success("sing-box configuration validated")

        log_f = open(PATHS["SB_LOG_FILE"], "a", encoding="utf-8")
        proc = subprocess.Popen(
            [str(PATHS["SB_BIN"]), "run", "-c", str(PATHS["SB_JSON"])],
            stdout=log_f,
            stderr=log_f,
            start_new_session=True,
        )
        time.sleep(1.5)
        if proc.poll() is not None:
            Log.error(f"sing-box exited early with code {proc.returncode}")
            return None
        Log.success("sing-box started successfully")
        return proc

    @staticmethod
    def initialize() -> Optional[subprocess.Popen]:
        Log.header("SB CONFIGURATION")
        Log.config("Node Name", CONFIG["SB_NAME"])
        Log.config("Public port", CONFIG["SB_PORT"])
        Log.config("VLESS local", CONFIG["VLESS_LOCAL_PORT"])
        Log.config("UUID", CONFIG["SB_UUID"])
        Log.config("SNI (HY2)", CONFIG["SB_SNI"])
        ws = CONFIG["WS_PATH"]
        Log.config("WS Path", ws if str(ws).startswith("/") else f"/{ws}")
        Log.config("Domain", CONFIG["SB_DOMAIN"] or "Not set")
        Log.config("Version", CONFIG["SB_VERSION"])
        Log.config("Architecture", ARCH)

        cert, key = SbManager.ensure_certificates()
        if not cert or not key:
            Log.error("Certificate setup failed, skipping sb")
            return None
        if not SbManager.ensure_binary():
            Log.error("Binary download failed, skipping sb")
            return None
        SbManager.write_configuration(cert, key)
        return SbManager.start()

    @staticmethod
    def generate_links() -> None:
        isp = SystemUtils.get_isp_info()
        host = SbManager.get_server_host()
        insecure = "0" if os.environ.get("EXTERNAL_CERT") else "1"

        hy2 = (
            f"hysteria2://{CONFIG['SB_UUID']}@{host}:{CONFIG['SB_PORT']}/"
            f"?sni={CONFIG['SB_SNI']}&obfs=salamander&obfs-password={CONFIG['SB_OBFS_PWD']}"
            f"&insecure={insecure}#{CONFIG['SB_NAME']}-{isp}"
        )
        ws_for_link = str(CONFIG["WS_PATH"]).lstrip("/")
        from urllib.parse import quote

        vless = (
            f"vless://{CONFIG['SB_UUID']}@{host}:{CONFIG['SB_PORT']}"
            f"?encryption=none&security=none&type=ws&path={quote(ws_for_link, safe='')}"
            f"#{CONFIG['VLESS_NAME']}-{isp}"
        )

        state.sbox_links = [hy2]
        state.vless_ws_links = [vless]
        state.sbox_base64 = base64.b64encode(hy2.encode()).decode()
        state.vless_ws_base64 = base64.b64encode(vless.encode()).decode()


# ──────────────────────────── Xray / Argo ────────────────────────────

class XManager:
    @staticmethod
    def create_configuration() -> None:
        Log.step("Creating X configuration")
        config = {
            "log": {"access": "/dev/null", "error": "/dev/null", "loglevel": "none"},
            "inbounds": [
                {
                    "port": CONFIG["ARGO_PORT"],
                    "protocol": "vless",
                    "settings": {
                        "clients": [{"id": CONFIG["UUID"], "flow": "xtls-rprx-vision"}],
                        "decryption": "none",
                        "fallbacks": [
                            {"dest": 3001},
                            {"path": "/vless-argo", "dest": 3002},
                        ],
                    },
                    "streamSettings": {"network": "tcp"},
                },
                {
                    "port": 3001,
                    "listen": "127.0.0.1",
                    "protocol": "vless",
                    "settings": {
                        "clients": [{"id": CONFIG["UUID"]}],
                        "decryption": "none",
                    },
                    "streamSettings": {
                        "network": "ws",
                        "security": "none",
                        "wsSettings": {"path": "/vless-argo"},
                    },
                },
                {
                    "port": 3002,
                    "listen": "127.0.0.1",
                    "protocol": "vless",
                    "settings": {
                        "clients": [{"id": CONFIG["UUID"], "level": 0}],
                        "decryption": "none",
                    },
                    "streamSettings": {
                        "network": "ws",
                        "security": "none",
                        "wsSettings": {"path": "/vless-argo"},
                    },
                    "sniffing": {
                        "enabled": True,
                        "destOverride": ["http", "tls", "quic"],
                        "metadataOnly": False,
                    },
                },
            ],
            "dns": {"servers": ["https+local://8.8.8.8/dns-query"]},
            "outbounds": [
                {"protocol": "freedom", "tag": "direct"},
                {"protocol": "blackhole", "tag": "block"},
            ],
        }
        PATHS["X_CONFIG"].write_text(json.dumps(config, indent=2), encoding="utf-8")
        Log.success("X configuration created")

    @staticmethod
    def arch_key() -> str:
        return "arm" if ARCH == "arm64" else "amd"

    @staticmethod
    def files_for_arch() -> List[Dict[str, str]]:
        is_arm = XManager.arch_key() == "arm"
        web_default = (
            "https://arm64.ssss.nyc.mn/web" if is_arm else "https://amd64.ssss.nyc.mn/web"
        )
        bot_default = (
            "https://arm64.ssss.nyc.mn/2go" if is_arm else "https://amd64.ssss.nyc.mn/2go"
        )
        return [
            {"fileName": "web", "fileUrl": CONFIG["WEB_URL"] or web_default},
            {"fileName": "bot", "fileUrl": CONFIG["BOT_URL"] or bot_default},
        ]

    @staticmethod
    def purge_bad_binary(name: str, min_bytes: int = 500 * 1024) -> None:
        p = FILE_PATH / name
        try:
            if p.exists() and p.stat().st_size < min_bytes:
                p.unlink()
                Log.warning(f"Removed incomplete binary: {name}")
        except OSError:
            pass

    @staticmethod
    def download_and_run() -> None:
        files = XManager.files_for_arch()
        XManager.purge_bad_binary("web")
        XManager.purge_bad_binary("bot")
        Log.step(f"Downloading files for {XManager.arch_key()} architecture")

        try:
            for f in files:
                SystemUtils.download_file(f["fileName"], f["fileUrl"])
            Log.success("All files downloaded successfully")
        except Exception as e:
            Log.warning(f"X components download failed: {e}")
            Log.warning("Continuing without Argo/X")
            return

        for name in ("web", "bot"):
            p = FILE_PATH / name
            if p.exists():
                p.chmod(0o755)

        try:
            subprocess.run(
                f'pkill -f "{FILE_PATH}/web" 2>/dev/null || true; '
                f'pkill -f "{FILE_PATH}/bot" 2>/dev/null || true',
                shell=True,
                check=False,
            )
        except Exception:
            pass

        web = FILE_PATH / "web"
        bot = FILE_PATH / "bot"
        if web.exists():
            XManager.start_x_core()
            time.sleep(2.5)
        else:
            Log.warning("X core binary missing — skipping X server")
            return

        if bot.exists():
            XManager.start_cloudflared()
        else:
            Log.warning("Cloudflared binary missing — skipping Argo tunnel")

    @staticmethod
    def start_x_core() -> None:
        web = FILE_PATH / "web"
        cmd = f'nohup "{web}" -c "{PATHS["X_CONFIG"]}" >/dev/null 2>&1 &'
        try:
            subprocess.Popen(cmd, shell=True)
            Log.success("X core started")
        except Exception as e:
            Log.error(f"Failed to start X core: {e}")

    @staticmethod
    def start_cloudflared() -> None:
        bot = FILE_PATH / "bot"
        if not bot.exists():
            return
        try:
            PATHS["BOOT_LOG"].write_text("", encoding="utf-8")
        except OSError:
            pass

        auth = CONFIG["ARGO_AUTH"] or ""
        if re.match(r"^[A-Z0-9a-z=]{120,250}$", auth):
            args = (
                f"tunnel --edge-ip-version auto --no-autoupdate --protocol http2 "
                f"run --token {auth}"
            )
        elif "TunnelSecret" in auth:
            args = (
                f'tunnel --edge-ip-version auto --config "{FILE_PATH}/tunnel.yml" run'
            )
        else:
            args = (
                f'tunnel --edge-ip-version auto --no-autoupdate --protocol http2 '
                f'--logfile "{PATHS["BOOT_LOG"]}" --loglevel info '
                f'--url http://127.0.0.1:{CONFIG["ARGO_PORT"]}'
            )

        cmd = f'nohup "{bot}" {args} >> "{PATHS["BOOT_LOG"]}" 2>&1 &'
        try:
            subprocess.Popen(cmd, shell=True)
            Log.success("Cloudflared tunnel started")
        except Exception as e:
            Log.error(f"Failed to start Cloudflared: {e}")

    @staticmethod
    def parse_argo_domain(content: str) -> Optional[str]:
        if not content:
            return None
        last = None
        for m in re.finditer(
            r"(?:https?://)?([a-z0-9-]+\.trycloudflare\.com)", content, re.I
        ):
            host = m.group(1).lower()
            if host not in ("fallback.trycloudflare.com", "trycloudflare.com"):
                last = host
        return last

    @staticmethod
    def wait_for_argo_domain(timeout_ms: int = 45000, interval_ms: int = 2000) -> Optional[str]:
        deadline = time.time() + timeout_ms / 1000.0
        while time.time() < deadline:
            try:
                if PATHS["BOOT_LOG"].exists():
                    content = PATHS["BOOT_LOG"].read_text(encoding="utf-8", errors="ignore")
                    domain = XManager.parse_argo_domain(content)
                    if domain:
                        return domain
            except Exception:
                pass
            time.sleep(interval_ms / 1000.0)
        return None

    @staticmethod
    def extract_domains() -> str:
        if CONFIG["ARGO_AUTH"] and CONFIG["ARGO_DOMAIN"]:
            domain = CONFIG["ARGO_DOMAIN"]
            Log.config("ARGO_DOMAIN", domain)
            XManager.generate_links(domain)
            return domain

        if CONFIG["ARGO_AUTH"] and not CONFIG["ARGO_DOMAIN"]:
            Log.warning("ARGO_AUTH set without ARGO_DOMAIN")

        Log.step("Waiting for Cloudflare quick tunnel domain...")
        domain = XManager.wait_for_argo_domain()
        if not domain:
            Log.warning("Argo domain not found in log — using fallback")
            domain = "fallback.trycloudflare.com"
        else:
            Log.config("Argo Domain", domain)
        XManager.generate_links(domain)
        return domain

    @staticmethod
    def generate_links(argo_domain: str) -> None:
        isp = SystemUtils.get_isp_info()
        link = (
            f"vless://{CONFIG['UUID']}@{CONFIG['CFIP']}:{CONFIG['CFPORT']}"
            f"?encryption=none&security=tls&sni={argo_domain}&type=ws"
            f"&host={argo_domain}&path=%2Fvless-argo%3Fed%3D2560"
            f"#{CONFIG['NAME']}-{isp}"
        )
        state.x_links = [link]
        state.x_base64 = base64.b64encode(link.encode()).decode()


# ──────────────────────────── HTTP panel + WS proxy ────────────────────────────

def _escape_html(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#039;")
    )


def _build_html() -> str:
    cards = []
    if state.sbox_links:
        cards.append(
            _protocol_card(
                "hy2",
                "Hysteria2",
                "High-speed UDP · Brutal congestion control",
                "fa-rocket",
                "hy2",
                ["UDP", "QUIC", f"Port {CONFIG['SB_PORT']}"],
                state.sbox_links[0],
                state.sbox_base64,
            )
        )
    if state.vless_ws_links:
        cards.append(
            _protocol_card(
                "vless",
                "VLESS-WS",
                "WebSocket over TCP · same public port",
                "fa-network-wired",
                "vless",
                ["TCP", "WebSocket", "No TLS"],
                state.vless_ws_links[0],
                state.vless_ws_base64,
            )
        )
    if state.x_links:
        cards.append(
            _protocol_card(
                "argo",
                "VLESS Argo",
                "Cloudflare Tunnel · CDN edge",
                "fa-cloud",
                "argo",
                ["TLS", "CDN", "Argo"],
                state.x_links[0],
                state.x_base64,
            )
        )

    active = len(cards)
    body_cards = "\n".join(cards) if cards else (
        '<div class="empty">No links generated yet. Wait a moment and refresh.</div>'
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0b0f19">
<title>Xray-Sing · Nodes</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" rel="stylesheet">
<style>{_CSS}</style>
</head>
<body>
<div class="bg-glow"></div>
<div class="wrap">
  <header class="hero">
    <div class="hero-top">
      <div class="logo">
        <span class="logo-mark"><i class="fas fa-shield-halved"></i></span>
        <div>
          <h1>Xray-Sing</h1>
          <p class="tagline">Multi-protocol edge node</p>
        </div>
      </div>
      <div class="status-pill online">
        <span class="dot"></span> Online · {active} protocol{"s" if active != 1 else ""}
      </div>
    </div>
    <p class="hero-desc">Copy a link into your client. Hysteria2 and VLESS-WS share public port <strong>{CONFIG['SB_PORT']}</strong>.</p>
  </header>
  <main class="grid">{body_cards}</main>
  <footer class="footer">
    <span>Port <code>{CONFIG['SB_PORT']}</code></span>
    <span class="sep">·</span>
    <span>HY2 UDP + VLESS TCP</span>
    <span class="sep">·</span>
    <span>Xray-Sing (Python)</span>
  </footer>
</div>
<div class="toast" id="toast"><i class="fas fa-check"></i> <span id="toast-text">Copied</span></div>
<script>
function copyText(text, btn) {{
  const done = () => {{
    const toast = document.getElementById('toast');
    document.getElementById('toast-text').textContent = 'Copied to clipboard';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1800);
    if (btn) {{
      const prev = btn.innerHTML;
      btn.classList.add('copied');
      btn.innerHTML = '<i class="fas fa-check"></i> Copied';
      setTimeout(() => {{ btn.classList.remove('copied'); btn.innerHTML = prev; }}, 1600);
    }}
  }};
  if (navigator.clipboard && window.isSecureContext) {{
    navigator.clipboard.writeText(text).then(done).catch(() => fallback(text, done));
  }} else fallback(text, done);
}}
function fallback(text, done) {{
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta); ta.select();
  try {{ document.execCommand('copy'); done(); }} catch (e) {{ alert('Copy failed'); }}
  document.body.removeChild(ta);
}}
function toggleBase64(id) {{
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}}
</script>
</body>
</html>"""


def _protocol_card(
    cid: str,
    title: str,
    subtitle: str,
    icon: str,
    accent: str,
    badges: List[str],
    link: str,
    b64: str,
) -> str:
    badges_html = "".join(
        f'<span class="badge{" accent" if i == 0 else ""}">{_escape_html(b)}</span>'
        for i, b in enumerate(badges)
    )
    link_js = json.dumps(link or "")
    b64_js = json.dumps(b64 or "")
    link_html = _escape_html(link) if link else "Not available"
    b64_section = ""
    if b64:
        b64_section = f"""
  <div class="base64-wrap">
    <button class="base64-toggle" type="button" onclick="toggleBase64('b64-{cid}')">
      <span><i class="fas fa-chevron-down"></i> Show Base64 / subscription</span>
    </button>
    <div class="base64-panel" id="b64-{cid}">
      <code>{_escape_html(b64)}</code>
      <button class="btn btn-ghost" type="button" onclick="copyText({b64_js}, this)">
        <i class="fas fa-copy"></i> Copy Base64
      </button>
    </div>
  </div>"""

    actions = (
        f"""
        <button class="btn btn-primary" type="button" onclick="copyText({link_js}, this)">
          <i class="fas fa-copy"></i> Copy link
        </button>
        <button class="btn btn-ghost" type="button" onclick="copyText({b64_js}, this)" {"disabled" if not b64 else ""}>
          <i class="fas fa-code"></i> Copy Base64
        </button>"""
        if link
        else '<span class="card-sub">Waiting for generation…</span>'
    )

    return f"""
<article class="card {accent}">
  <div class="card-head">
    <div class="card-icon"><i class="fas {icon}"></i></div>
    <div>
      <div class="card-title">{_escape_html(title)}</div>
      <div class="card-sub">{_escape_html(subtitle)}</div>
    </div>
  </div>
  <div class="badges">{badges_html}</div>
  <div>
    <div class="section-label">Connection link</div>
    <div class="link-box">
      <div class="link-text">{link_html}</div>
      <div class="link-actions">{actions}</div>
    </div>
  </div>
  {b64_section}
</article>"""


_CSS = """
:root {
  --bg:#0b0f19;--surface:#121826;--surface2:#1a2234;--border:rgba(255,255,255,0.08);
  --text:#e8edf7;--muted:#8b95a8;--primary:#6366f1;--primary2:#818cf8;
  --hy2:#22d3ee;--vless:#a78bfa;--argo:#34d399;--ok:#10b981;--radius:16px;
  --font:'Inter',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;line-height:1.55}
.bg-glow{position:fixed;inset:0;pointer-events:none;z-index:0;
  background:radial-gradient(ellipse 80% 50% at 20% -10%,rgba(99,102,241,.18),transparent 50%),
  radial-gradient(ellipse 60% 40% at 90% 10%,rgba(34,211,238,.1),transparent 45%)}
.wrap{position:relative;z-index:1;max-width:1100px;margin:0 auto;padding:2rem 1.25rem 3rem}
.hero{margin-bottom:2rem}
.hero-top{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}
.logo{display:flex;align-items:center;gap:.9rem}
.logo-mark{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;
  background:linear-gradient(135deg,#6366f1,#22d3ee);color:#fff;font-size:1.25rem}
.logo h1{font-size:1.5rem;font-weight:700}
.tagline{color:var(--muted);font-size:.85rem}
.status-pill{display:inline-flex;align-items:center;gap:.45rem;padding:.4rem .85rem;border-radius:999px;
  font-size:.8rem;font-weight:600;background:rgba(16,185,129,.12);color:var(--ok);
  border:1px solid rgba(16,185,129,.25)}
.status-pill .dot{width:7px;height:7px;border-radius:50%;background:var(--ok)}
.hero-desc{color:var(--muted);font-size:.95rem;max-width:42rem}
.hero-desc strong{color:var(--text)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1.25rem}
.empty{grid-column:1/-1;text-align:center;padding:3rem;color:var(--muted);background:var(--surface);
  border:1px dashed var(--border);border-radius:var(--radius)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:1.35rem;box-shadow:0 20px 50px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:1rem}
.card:hover{border-color:rgba(99,102,241,.45)}
.card-head{display:flex;gap:.9rem}
.card-icon{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;font-size:1.1rem}
.card.hy2 .card-icon{background:rgba(34,211,238,.12);color:var(--hy2)}
.card.vless .card-icon{background:rgba(167,139,250,.12);color:var(--vless)}
.card.argo .card-icon{background:rgba(52,211,153,.12);color:var(--argo)}
.card-title{font-size:1.15rem;font-weight:650}
.card-sub{color:var(--muted);font-size:.82rem;margin-top:.15rem}
.badges{display:flex;flex-wrap:wrap;gap:.4rem}
.badge{font-size:.7rem;font-weight:600;padding:.2rem .55rem;border-radius:6px;
  background:var(--surface2);color:var(--muted);border:1px solid var(--border)}
.card.hy2 .badge.accent{color:var(--hy2);border-color:rgba(34,211,238,.3);background:rgba(34,211,238,.08)}
.card.vless .badge.accent{color:var(--vless);border-color:rgba(167,139,250,.3);background:rgba(167,139,250,.08)}
.card.argo .badge.accent{color:var(--argo);border-color:rgba(52,211,153,.3);background:rgba(52,211,153,.08)}
.section-label{font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:.5rem}
.link-box{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:.85rem}
.link-text{font-family:var(--mono);font-size:.72rem;line-height:1.5;word-break:break-all;color:#c5d0e6;
  max-height:4.5em;overflow:hidden;margin-bottom:.75rem}
.link-actions{display:flex;gap:.5rem;flex-wrap:wrap}
.btn{border:none;cursor:pointer;display:inline-flex;align-items:center;gap:.4rem;
  font-family:var(--font);font-size:.82rem;font-weight:600;padding:.55rem .9rem;border-radius:10px}
.btn-primary{background:var(--primary);color:#fff}
.btn-primary:hover{background:var(--primary2)}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
.btn.copied{background:var(--ok)!important;color:#fff!important}
.base64-toggle{width:100%;justify-content:space-between;background:transparent;border:1px solid var(--border);
  color:var(--muted);border-radius:10px;padding:.55rem .85rem;font-size:.8rem;font-weight:600;cursor:pointer;
  display:flex;align-items:center}
.base64-panel{display:none;margin-top:.6rem;background:#0a0e16;border:1px solid var(--border);border-radius:10px;padding:.75rem}
.base64-panel.open{display:block}
.base64-panel code{font-family:var(--mono);font-size:.68rem;word-break:break-all;color:#9aa8c2;display:block;margin-bottom:.65rem}
.footer{margin-top:2.5rem;text-align:center;color:var(--muted);font-size:.8rem;
  display:flex;justify-content:center;flex-wrap:wrap;gap:.35rem}
.footer code{font-family:var(--mono);background:var(--surface2);padding:.1rem .4rem;border-radius:4px;color:var(--text)}
.toast{position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%) translateY(120%);
  background:#0f172a;color:#fff;border:1px solid rgba(16,185,129,.4);padding:.75rem 1.25rem;border-radius:12px;
  display:flex;align-items:center;gap:.5rem;font-weight:600;opacity:0;transition:.25s;z-index:1000}
.toast.show{transform:translateX(-50%) translateY(0);opacity:1}
.toast i{color:var(--ok)}
@media(max-width:640px){.wrap{padding:1.25rem 1rem 2rem}.link-actions .btn{flex:1}}
"""


def _ws_path_norm() -> str:
    p = str(CONFIG["WS_PATH"])
    if not p.startswith("/"):
        p = "/" + p
    return p.rstrip("/") or "/"


class PanelHandler(BaseHTTPRequestHandler):
    server_version = "XraySing/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        return  # silence access log

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        sub = "/" + str(CONFIG["SUB_PATH"]).strip("/")
        if path in ("/", sub, "/sub"):
            body = _build_html().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/health":
            body = json.dumps(
                {
                    "ok": True,
                    "hy2": state.sb_process is not None and state.sb_process.poll() is None,
                    "port": CONFIG["SB_PORT"],
                    "vlessLocal": CONFIG["VLESS_LOCAL_PORT"],
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def handle_one_request(self) -> None:
        try:
            self.raw_requestline = self.rfile.readline(65537)
            if not self.raw_requestline:
                self.close_connection = True
                return
            if not self.parse_request():
                return

            upgrade = (self.headers.get("Upgrade") or "").lower()
            connection = (self.headers.get("Connection") or "").lower()
            if upgrade == "websocket" or "upgrade" in connection:
                self._proxy_websocket()
                return

            mname = "do_" + self.command
            if not hasattr(self, mname):
                self.send_error(501, f"Unsupported method ({self.command})")
                return
            getattr(self, mname)()
        except Exception:
            self.close_connection = True

    def _proxy_websocket(self) -> None:
        url_path = (self.path or "/").split("?")[0]
        url_path = unquote(url_path).rstrip("/") or "/"
        expected = _ws_path_norm()
        if url_path not in (expected, expected + "/"):
            try:
                self.connection.sendall(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.close_connection = True
            return

        try:
            target = socket.create_connection(
                ("127.0.0.1", int(CONFIG["VLESS_LOCAL_PORT"])), timeout=10
            )
        except OSError:
            try:
                self.connection.sendall(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.close_connection = True
            return

        # Rebuild request for backend
        req = f"{self.command} {self.path} HTTP/{self.request_version}\r\n"
        for k, v in self.headers.items():
            req += f"{k}: {v}\r\n"
        req += "\r\n"
        try:
            target.sendall(req.encode("utf-8", errors="ignore"))
        except OSError:
            target.close()
            self.close_connection = True
            return

        client = self.connection
        self.close_connection = True

        def pipe(src: socket.socket, dst: socket.socket) -> None:
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    dst.shutdown(socket.SHUT_WR)
                except OSError:
                    pass

        t1 = threading.Thread(target=pipe, args=(client, target), daemon=True)
        t2 = threading.Thread(target=pipe, args=(target, client), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        try:
            target.close()
        except OSError:
            pass


def start_http_server() -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("0.0.0.0", int(CONFIG["PORT"])), PanelHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    Log.success(f"HTTP panel + WS proxy on 0.0.0.0:{CONFIG['PORT']}")
    Log.info(f"Open: http://YOUR_IP:{CONFIG['PORT']}/{CONFIG['SUB_PATH']}")
    return server


# ──────────────────────────── Application ────────────────────────────

class Application:
    @staticmethod
    def initialize() -> None:
        SystemUtils.ensure_dir(FILE_PATH)
        SystemUtils.ensure_dir(PATHS["SB_BASE_DIR"])

        uuid_file = FILE_PATH / "uuid.txt"
        if not os.environ.get("UUID") and not os.environ.get("SB_UUID"):
            try:
                if uuid_file.exists():
                    saved = uuid_file.read_text(encoding="utf-8").strip()
                    if saved:
                        CONFIG["UUID"] = saved
                        CONFIG["SB_UUID"] = saved
                        if not os.environ.get("WS_PATH"):
                            CONFIG["WS_PATH"] = saved
                else:
                    uuid_file.write_text(CONFIG["UUID"], encoding="utf-8")
            except OSError:
                pass

        obfs_file = FILE_PATH / "obfs.txt"
        if CONFIG["SB_OBFS_PWD"]:
            try:
                obfs_file.write_text(CONFIG["SB_OBFS_PWD"], encoding="utf-8")
            except OSError:
                pass
        else:
            try:
                if obfs_file.exists():
                    CONFIG["SB_OBFS_PWD"] = obfs_file.read_text(encoding="utf-8").strip()
            except OSError:
                pass
            if not CONFIG["SB_OBFS_PWD"]:
                CONFIG["SB_OBFS_PWD"] = secrets.token_hex(16)
                try:
                    obfs_file.write_text(CONFIG["SB_OBFS_PWD"], encoding="utf-8")
                except OSError:
                    pass

    @staticmethod
    def print_all_links() -> None:
        host = SbManager.get_server_host()
        web_url = f"http://{host}:{CONFIG['PORT']}/{CONFIG['SUB_PATH']}"

        print("", flush=True)
        Log.header("READY")
        print(f"{C.BRIGHT}{C.GREEN}  All services are running{C.RESET}", flush=True)
        print("", flush=True)
        print(f"{C.BRIGHT}  Web panel{C.RESET}", flush=True)
        print(f"  {C.YELLOW}{web_url}{C.RESET}", flush=True)
        print("", flush=True)

        if state.sbox_links:
            print(f"{C.BRIGHT}  Hysteria2{C.RESET}", flush=True)
            for link in state.sbox_links:
                print(f"  {C.WHITE}{link}{C.RESET}", flush=True)
            print("", flush=True)

        if state.vless_ws_links:
            print(f"{C.BRIGHT}  VLESS-WS{C.RESET}", flush=True)
            for link in state.vless_ws_links:
                print(f"  {C.WHITE}{link}{C.RESET}", flush=True)
            print("", flush=True)

        if CONFIG["ENABLE_ARGO"] and state.x_links:
            print(f"{C.BRIGHT}  VLESS Argo{C.RESET}", flush=True)
            for link in state.x_links:
                print(f"  {C.WHITE}{link}{C.RESET}", flush=True)
            print("", flush=True)

        links_file = FILE_PATH / "links.txt"
        print(f"{C.DIM}  Links also saved to: {links_file}{C.RESET}", flush=True)
        print(f"{C.DIM}  Console will clear in 3 minutes...{C.RESET}", flush=True)
        print(f"{C.BRIGHT}{C.CYAN}{'━' * 56}{C.RESET}", flush=True)
        print("", flush=True)

        try:
            lines = [
                f"Web: {web_url}",
                "",
                "=== Hysteria2 ===",
                *state.sbox_links,
                "",
                "=== VLESS-WS ===",
                *state.vless_ws_links,
            ]
            if CONFIG["ENABLE_ARGO"] and state.x_links:
                lines.extend(["", "=== X/Argo ===", *state.x_links])
            links_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
        except OSError:
            pass

        def _clear() -> None:
            time.sleep(3 * 60)
            Log.clear_console()

        threading.Thread(target=_clear, daemon=True).start()

    @staticmethod
    def start() -> None:
        Log.header("Xray-Sing starting")
        Application.initialize()
        Log.success(f"Data directory: {FILE_PATH}")
        Log.info(
            f"Public port: {CONFIG['PORT']}  |  Argo: {'on' if CONFIG['ENABLE_ARGO'] else 'off'}"
        )

        Log.step("[1/3] Starting sing-box (Hysteria2 + VLESS-WS)...")
        state.sb_process = SbManager.initialize()
        if state.sb_process:
            SbManager.generate_links()
            Log.success("sing-box is running")
        else:
            Log.error("sing-box failed to start")

        Log.step("[2/3] Starting HTTP panel + WS proxy...")
        start_http_server()
        Log.success(f"Panel ready on port {CONFIG['PORT']}")

        if CONFIG["ENABLE_ARGO"]:
            Log.step("[3/3] Starting Xray + Cloudflare Argo...")
            XManager.create_configuration()
            XManager.download_and_run()
            time.sleep(3)
            XManager.extract_domains()
            if state.x_links:
                Log.success("Argo tunnel is ready")
            else:
                Log.warning("Argo link not ready (check boot.log)")
        else:
            Log.info("[3/3] Argo disabled (ENABLE_ARGO=0)")

        Application.print_all_links()

        # Keep main thread alive
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            shutdown()


def shutdown(*_args: Any) -> None:
    try:
        if state.sb_process and state.sb_process.poll() is None:
            state.sb_process.terminate()
            try:
                state.sb_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                state.sb_process.kill()
    except Exception:
        pass
    try:
        subprocess.run(
            f'pkill -f "{FILE_PATH}/web" 2>/dev/null || true; '
            f'pkill -f "{FILE_PATH}/bot" 2>/dev/null || true',
            shell=True,
            check=False,
        )
    except Exception:
        pass
    sys.exit(0)


def main() -> None:
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    try:
        Application.start()
    except Exception as e:
        Log.error(f"Application failed to start: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
