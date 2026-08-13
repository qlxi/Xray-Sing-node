/**
 * Xray-Sing — Hysteria2 (UDP) + VLESS-WS (TCP) on one public port.
 * Optional Cloudflare Argo. Panel: http://HOST:PORT/sub
 * MIT License
 */
const express = require("express");
const axios = require("axios");
const os = require("os");
const fs = require("fs");
const path = require("path");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const { exec, execSync, spawn, spawnSync } = require("child_process");

// ========== CONFIGURATION ==========
// Public port: TCP = HTTP panel + WS proxy; UDP = Hysteria2.
// VLESS-WS is local-only; Express proxies WebSocket upgrades to it.
const _publicPort = parseInt(process.env.SB_PORT || process.env.SERVER_PORT || process.env.PORT || "2705", 10);
const _defaultUuid = process.env.UUID || crypto.randomUUID();

const CONFIG = {
    UUID: _defaultUuid,
    FILE_PATH: process.env.FILE_PATH || path.join(os.tmpdir(), "xray-sing"),
    SUB_PATH: process.env.SUB_PATH || "sub",
    PORT: _publicPort,
    NAME: process.env.NAME || "vless",

    CFIP: process.env.CFIP || "www.kick.com",
    CFPORT: parseInt(process.env.CFPORT || "443", 10),

    // Argo enabled by default (set ENABLE_ARGO=0 to disable)
    ENABLE_ARGO: !(process.env.ENABLE_ARGO === "0" || process.env.ENABLE_ARGO === "false"),
    ARGO_DOMAIN: process.env.ARGO_DOMAIN || "",
    ARGO_AUTH: process.env.ARGO_AUTH || "",
    ARGO_PORT: parseInt(process.env.ARGO_PORT || "8001", 10),

    SB_VERSION: process.env.SB_VERSION || "1.11.15",
    SB_NAME: process.env.SB_NAME || "HY2",
    SB_PORT: _publicPort,
    VLESS_LOCAL_PORT: parseInt(process.env.VLESS_LOCAL_PORT || "12080", 10),
    SB_UUID: process.env.SB_UUID || _defaultUuid,
    SB_SNI: process.env.SB_SNI || "time.android.com",
    SB_MASS_PROXY: process.env.SB_MASS_PROXY || "https://www.gstatic.com",
    SB_DOMAIN: process.env.SB_DOMAIN || process.env.DOMAIN || "",
    SB_HOST: process.env.SB_HOST || "127.0.0.1",
    // Set in Application.initialize() — env or persisted file (stable across restarts)
    SB_OBFS_PWD: process.env.SB_OBFS_PWD || "",

    WS_PATH: process.env.WS_PATH || process.env.SB_UUID || _defaultUuid,
    VLESS_NAME: process.env.VLESS_NAME || "VLESS-WS",

    WEB_URL: process.env.WEB_URL || "",
    BOT_URL: process.env.BOT_URL || ""
};

// ========== CONSTANTS ==========
const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

// ========== SYSTEM VARIABLES ==========
const ARCH = (() => {
    const arch = os.arch();
    return (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') ? 'arm64' : 'amd64';
})();

const TAR_NAME = `sing-box-${CONFIG.SB_VERSION}-linux-${ARCH}.tar.gz`;
const DOWNLOAD_URL = process.env.SB_URL ||
    `https://github.com/SagerNet/sing-box/releases/download/v${CONFIG.SB_VERSION}/${TAR_NAME}`;

// File paths
const PATHS = {
    SB_BASE_DIR: path.join(CONFIG.FILE_PATH, "sb"),
    SB_CERT_DIR: path.join(CONFIG.FILE_PATH, "sb", "cert"),
    SB_CERT_PATH: path.join(CONFIG.FILE_PATH, "sb", "cert", "cert.pem"),
    SB_KEY_PATH: path.join(CONFIG.FILE_PATH, "sb", "cert", "key.pem"),
    SB_JSON: path.join(CONFIG.FILE_PATH, "sb", "sb.json"),
    SB_BIN: path.join(CONFIG.FILE_PATH, "sb", "sb"),
    SB_LOG_FILE: path.join(CONFIG.FILE_PATH, "sb", "sb.log"),
    X_CONFIG: path.join(CONFIG.FILE_PATH, 'config.json'),
    BOOT_LOG: path.join(CONFIG.FILE_PATH, 'boot.log')
};

// Global state
const state = {
    xLinks: [],
    sboxLinks: [],          // Hysteria2 links
    vlessWsLinks: [],       // VLESS-WS links (same port as HY2)
    xBase64: "",
    sboxBase64: "",
    vlessWsBase64: "",
    sbProcess: null
};

// ========== LOGGER ==========
// QUIET=1 — only errors. Default: normal progress output.
class Logger {
    static quiet = process.env.QUIET === "1" || process.env.QUIET === "true";

    static info(message) {
        if (!this.quiet) console.log(`${COLORS.cyan}ℹ ${message}${COLORS.reset}`);
    }

    static success(message) {
        if (!this.quiet) console.log(`${COLORS.green}✅ ${message}${COLORS.reset}`);
    }

    static warning(message) {
        if (!this.quiet) console.log(`${COLORS.yellow}⚠ ${message}${COLORS.reset}`);
    }

    static error(message) {
        console.log(`${COLORS.red}❌ ${message}${COLORS.reset}`);
    }

    static step(message) {
        if (!this.quiet) console.log(`${COLORS.blue}➤ ${message}${COLORS.reset}`);
    }

    static header(message) {
        if (!this.quiet) {
            console.log(`\n${COLORS.bright}${COLORS.magenta}${"=".repeat(56)}${COLORS.reset}`);
            console.log(`${COLORS.bright}${COLORS.magenta}  ${message}${COLORS.reset}`);
            console.log(`${COLORS.bright}${COLORS.magenta}${"=".repeat(56)}${COLORS.reset}\n`);
        }
    }

    static divider() {
        if (!this.quiet) console.log(`${COLORS.dim}${"─".repeat(56)}${COLORS.reset}`);
    }

    static config(key, value) {
        if (!this.quiet) console.log(`  ${COLORS.cyan}${key}:${COLORS.reset} ${COLORS.yellow}${value}${COLORS.reset}`);
    }

    /** Clear terminal (ANSI + fallback for panel log viewers) */
    static clearConsole() {
        try {
            if (typeof console.clear === "function") console.clear();
        } catch { /* ignore */ }
        try {
            process.stdout.write("\x1B[2J\x1B[3J\x1B[H\x1Bc");
        } catch { /* ignore */ }
        // Panels that ignore ANSI still get a visual break
        console.log("\n".repeat(8));
    }
}

// ========== SYSTEM UTILITIES ==========
class SystemUtils {
    /**
     * Get public IP address synchronously
     */
    static getPublicIpSync() {
        const ipRegex = /\b((25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(?!$)|$)){4}\b/;
        const curlCandidates = [
            "https://ifconfig.co",
            "https://ifconfig.me/ip",
            "https://api.ipify.org",
            "https://ifconfig.io/ip",
        ];

        for (const url of curlCandidates) {
            try {
                const result = spawnSync("curl", ["-sS", url], {
                    encoding: "utf8",
                    timeout: 8000,
                });
                if (result.status === 0 && result.stdout) {
                    const match = result.stdout.trim().match(ipRegex);
                    if (match) return match[0];
                }
            } catch {
                // Continue to next candidate
            }
        }

        try {
            const result = spawnSync("dig", ["+short", "myip.opendns.com", "@resolver1.opendns.com"], {
                encoding: "utf8",
                timeout: 8000,
            });
            if (result.status === 0 && result.stdout) {
                const match = result.stdout.trim().match(ipRegex);
                if (match) return match[0];
            }
        } catch {
            // Fall through
        }

        return null;
    }

    /**
     * Get ISP / location label for node name (e.g. OVH-France or AS16276-OVH)
     */
    static async getISPInfo() {
        const sanitize = (s) => String(s || '')
            .replace(/[^\w.\-]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .slice(0, 48) || 'UNKNOWN';

        // 1) Cloudflare speed meta (JSON)
        try {
            const r = spawnSync('curl', ['-sS', '--max-time', '6', 'https://speed.cloudflare.com/meta'], {
                encoding: 'utf8',
                timeout: 8000
            });
            if (r.status === 0 && r.stdout) {
                const j = JSON.parse(r.stdout);
                // Typical fields: colo, city, clientIp, asOrganization / asn
                const org = j.asOrganization || j.asn || j.clientAsn || '';
                const city = j.city || j.colo || '';
                const label = [org, city].filter(Boolean).join('-');
                if (label) return sanitize(label);
            }
        } catch {
            // continue
        }

        // 2) ipinfo.io
        try {
            const r = spawnSync('curl', ['-sS', '--max-time', '6', 'https://ipinfo.io/json'], {
                encoding: 'utf8',
                timeout: 8000
            });
            if (r.status === 0 && r.stdout) {
                const j = JSON.parse(r.stdout);
                const label = [j.org, j.city || j.country].filter(Boolean).join('-');
                if (label) return sanitize(label);
            }
        } catch {
            // continue
        }

        // 3) ip-api.com
        try {
            const r = spawnSync('curl', ['-sS', '--max-time', '6', 'http://ip-api.com/json/?fields=status,isp,org,as,city,country'], {
                encoding: 'utf8',
                timeout: 8000
            });
            if (r.status === 0 && r.stdout) {
                const j = JSON.parse(r.stdout);
                if (j.status === 'success') {
                    const label = [j.isp || j.org || j.as, j.city || j.country].filter(Boolean).join('-');
                    if (label) return sanitize(label);
                }
            }
        } catch {
            // continue
        }

        return 'UNKNOWN';
    }

    /**
     * Ensure directory exists
     */
    static ensureDirectory(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            Logger.success(`Directory created: ${dirPath}`);
        }
    }

    /**
     * Download file with progress
     */
    static downloadFile(fileName, fileUrl) {
        return new Promise((resolve, reject) => {
            const filePath = path.join(CONFIG.FILE_PATH, fileName);

            // Skip download only if a reasonably sized binary already exists
            try {
                const minSize = (fileName === "web" || fileName === "bot") ? 500 * 1024 : 1024;
                if (fs.existsSync(filePath) && fs.statSync(filePath).size >= minSize) {
                    fs.chmodSync(filePath, 0o755);
                    Logger.info(`Already present, skip download: ${fileName}`);
                    return resolve(fileName);
                }
            } catch {
                // continue to download
            }

            const writer = fs.createWriteStream(filePath);

            axios({
                method: 'get',
                url: fileUrl,
                responseType: 'stream',
                timeout: 30000
            })
            .then(response => {
                response.data.pipe(writer);

                writer.on('finish', () => {
                    writer.close();
                    fs.chmodSync(filePath, 0o755);
                    Logger.success(`Downloaded: ${fileName}`);
                    resolve(fileName);
                });

                writer.on('error', err => {
                    fs.unlink(filePath, () => {});
                    reject(`Download error ${fileName}: ${err.message}`);
                });
            })
            .catch(err => {
                reject(`Download error ${fileName}: ${err.message}`);
            });
        });
    }

    /**
     * Apply system optimizations for better performance
     */
    static applySystemOptimizations() {
        Logger.step("Applying system optimizations for maximum performance...");

        try {
            const optimizations = [
                // TCP optimizations
                'sysctl -w net.core.rmem_max=268435456',
                'sysctl -w net.core.wmem_max=268435456',
                'sysctl -w net.ipv4.tcp_rmem="4096 87380 268435456"',
                'sysctl -w net.ipv4.tcp_wmem="4096 16384 268435456"',
                'sysctl -w net.core.netdev_max_backlog=100000',
                'sysctl -w net.core.somaxconn=65535',
                'sysctl -w net.ipv4.tcp_max_syn_backlog=65535',

                // BBR congestion control
                'sysctl -w net.ipv4.tcp_congestion_control=bbr',
                'sysctl -w net.ipv4.tcp_fastopen=3',
                'sysctl -w net.core.default_qdisc=fq_codel',

                // File descriptor limits
                'sysctl -w fs.file-max=2097152',
                'sysctl -w fs.nr_open=2097152',

                // Memory optimizations
                'sysctl -w net.ipv4.tcp_mem="786432 2097152 3145728"',
                'sysctl -w net.ipv4.udp_mem="786432 2097152 3145728"',

                // Additional optimizations
                'sysctl -w net.ipv4.tcp_slow_start_after_idle=0',
                'sysctl -w net.ipv4.tcp_tw_reuse=1',
                'sysctl -w net.ipv4.tcp_fin_timeout=30',
                'sysctl -w net.ipv4.tcp_keepalive_time=1200',
                'sysctl -w net.ipv4.tcp_keepalive_intvl=30',
                'sysctl -w net.ipv4.tcp_keepalive_probes=3'
            ];

            let applied = 0;
            for (const cmd of optimizations) {
                try {
                    execSync(cmd, { stdio: 'ignore' });
                    applied++;
                } catch {
                    // Ignore errors if no root privileges
                }
            }

            if (applied > 0) {
                Logger.success(`Applied ${applied} system optimizations`);
            } else {
                Logger.warning("Could not apply system optimizations (root privileges required)");
            }
        } catch (error) {
            Logger.warning("Error applying system optimizations");
        }
    }
}

// ========== SB MANAGER (Hysteria2 + VLESS-WS) ==========
class SbManager {
    /**
     * Get server host (domain, IP, or fallback)
     */
    static async getServerHost() {
        if (CONFIG.SB_DOMAIN) {
            Logger.info(`Using domain: ${CONFIG.SB_DOMAIN}`);
            return CONFIG.SB_DOMAIN;
        }

        const publicIp = SystemUtils.getPublicIpSync();
        if (publicIp) {
            Logger.info(`Using public IP: ${publicIp}`);
            return publicIp;
        }

        Logger.warning(`Using fallback host: ${CONFIG.SB_HOST}`);
        return CONFIG.SB_HOST;
    }

    /**
     * Ensure TLS certificates exist (used by Hysteria2)
     */
    static ensureCertificates() {
        SystemUtils.ensureDirectory(PATHS.SB_CERT_DIR);

        // Use external certificates if provided
        if (process.env.EXTERNAL_CERT && process.env.EXTERNAL_KEY &&
            fs.existsSync(process.env.EXTERNAL_CERT) && fs.existsSync(process.env.EXTERNAL_KEY)) {
            Logger.info("Using external TLS certificates");
            return {
                cert: process.env.EXTERNAL_CERT,
                key: process.env.EXTERNAL_KEY
            };
        }

        // Generate self-signed certificates
        if (!fs.existsSync(PATHS.SB_CERT_PATH) || !fs.existsSync(PATHS.SB_KEY_PATH)) {
            Logger.step("Generating self-signed TLS certificate");
            const result = spawnSync("openssl", [
                "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-subj", `/CN=${CONFIG.SB_SNI}`,
                "-keyout", PATHS.SB_KEY_PATH,
                "-out", PATHS.SB_CERT_PATH,
                "-days", "365",
            ]);

            if (result.status !== 0) {
                Logger.error("Failed to generate TLS certificate");
                return { cert: null, key: null };
            }
            Logger.success("TLS certificate generated");
        }

        return { cert: PATHS.SB_CERT_PATH, key: PATHS.SB_KEY_PATH };
    }

    /**
     * Ensure sb binary is downloaded and ready
     */
    static ensureBinary() {
        if (fs.existsSync(PATHS.SB_BIN)) {
            return true;
        }

        SystemUtils.ensureDirectory(PATHS.SB_BASE_DIR);
        Logger.step(`Downloading sb (${ARCH})`);

        const tarPath = path.join(PATHS.SB_BASE_DIR, TAR_NAME);

        // Download sb
        const curlResult = spawnSync("curl", ["-L", "-sS", "-o", tarPath, DOWNLOAD_URL], {
            timeout: 60000
        });

        if (curlResult.status !== 0) {
            Logger.error("Failed to download sb");
            return false;
        }

        // Extract archive
        const tarResult = spawnSync("tar", ["-xzf", tarPath, "-C", PATHS.SB_BASE_DIR]);
        if (tarResult.status !== 0) {
            Logger.error("Failed to extract sb archive");
            return false;
        }

        // Move binary to correct location
        const extractedDir = path.join(PATHS.SB_BASE_DIR, `sing-box-${CONFIG.SB_VERSION}-linux-${ARCH}`);
        if (fs.existsSync(path.join(extractedDir, "sing-box"))) {
            fs.renameSync(path.join(extractedDir, "sing-box"), PATHS.SB_BIN);
            spawnSync("chmod", ["+x", PATHS.SB_BIN]);
            // Free disk: remove archive and extracted folder
            try {
                fs.unlinkSync(tarPath);
                fs.rmSync(extractedDir, { recursive: true, force: true });
            } catch {
                // ignore cleanup errors
            }
            Logger.success("sb installed successfully");
            return true;
        }

        Logger.error("sb binary not found in archive");
        return false;
    }

    /**
     * Create sing-box configuration
     * Hysteria2 (UDP) and VLESS-WS (TCP) share the same listen_port.
     * This is safe because the protocols use different transport layers.
     */
    static writeConfiguration(cert, key) {
        Logger.step("Creating sb configuration (Hysteria2 + VLESS-WS)");

        // Normalize WS path: must start with / for the transport
        const wsPath = CONFIG.WS_PATH.startsWith('/') ? CONFIG.WS_PATH : `/${CONFIG.WS_PATH}`;

        const config = {
            "log": {
                "level": "info",
                "timestamp": true
            },
            "inbounds": [
                // ---------- Hysteria2 (UDP / QUIC) on public port ----------
                {
                    "type": "hysteria2",
                    "tag": "hy2-in",
                    "listen": "::",
                    "listen_port": CONFIG.SB_PORT,
                    "users": [
                        {
                            "password": CONFIG.SB_UUID
                        }
                    ],
                    "tls": {
                        "enabled": true,
                        "server_name": CONFIG.SB_SNI,
                        "alpn": ["h3"],
                        "certificate_path": cert,
                        "key_path": key
                    },
                    "obfs": {
                        "type": "salamander",
                        "password": CONFIG.SB_OBFS_PWD
                    },
                    "masquerade": {
                        "type": "proxy",
                        "url": CONFIG.SB_MASS_PROXY,
                        "rewrite_host": true
                    },
                    "ignore_client_bandwidth": false,
                    "up_mbps": 100,
                    "down_mbps": 100
                },
                // ---------- VLESS + WebSocket (TCP) on localhost only ----------
                // Public clients connect to Express on the public port; Express
                // proxies WebSocket upgrades to this inbound.
                {
                    "type": "vless",
                    "tag": "vless-ws-in",
                    "listen": "127.0.0.1",
                    "listen_port": CONFIG.VLESS_LOCAL_PORT,
                    "users": [
                        {
                            "uuid": CONFIG.SB_UUID,
                            "flow": ""
                        }
                    ],
                    "tls": {
                        "enabled": false
                    },
                    "transport": {
                        "type": "ws",
                        "path": wsPath,
                        "max_early_data": 2560,
                        "early_data_header_name": "Sec-WebSocket-Protocol"
                    }
                }
            ],
            "outbounds": [
                {
                    "type": "direct",
                    "tag": "direct"
                },
                {
                    "type": "block",
                    "tag": "block"
                }
            ]
        };

        fs.writeFileSync(PATHS.SB_JSON, JSON.stringify(config, null, 2));
        Logger.success(`sb config: HY2 UDP :${CONFIG.SB_PORT} + VLESS-WS 127.0.0.1:${CONFIG.VLESS_LOCAL_PORT}`);
    }

    /**
     * Start sb process
     */
    static start() {
        Logger.step("Starting sb...");

        if (!fs.existsSync(PATHS.SB_BIN)) {
            Logger.error("sb binary not found");
            return null;
        }

        // Validate configuration first
        const checkResult = spawnSync(PATHS.SB_BIN, ["check", "-c", PATHS.SB_JSON], {
            encoding: 'utf8'
        });

        if (checkResult.status !== 0) {
            Logger.error(`sb configuration error: ${checkResult.stderr}`);
            return null;
        }

        Logger.success("sb configuration validated");

        // Start sb process
        const logFile = fs.openSync(PATHS.SB_LOG_FILE, 'a');
        const child = spawn(PATHS.SB_BIN, ["run", "-c", PATHS.SB_JSON], {
            stdio: ['ignore', logFile, logFile],
            detached: false,
        });

        // Process event handlers
        child.on("error", (err) => {
            Logger.error(`Failed to start sb: ${err.message}`);
            fs.closeSync(logFile);
        });

        child.on("exit", (code, signal) => {
            fs.closeSync(logFile);
            if (signal) {
                Logger.error(`sb terminated with signal: ${signal}`);
            } else if (code !== 0) {
                Logger.error(`sb exited with code: ${code}`);
            } else {
                Logger.info("sb stopped normally");
            }
        });

        // Verify process started successfully
        setTimeout(() => {
            if (child.exitCode === null) {
                Logger.success("sb started successfully");
            }
        }, 2000);

        return child;
    }

    /**
     * Initialize sb service
     */
    static async initialize() {
        Logger.header("SB CONFIGURATION");

        // Display configuration
        Logger.config("Node Name", CONFIG.SB_NAME);
        Logger.config("Public port", CONFIG.SB_PORT);
        Logger.config("VLESS local", CONFIG.VLESS_LOCAL_PORT);
        Logger.config("UUID", CONFIG.SB_UUID);
        Logger.config("SNI (HY2)", CONFIG.SB_SNI);
        Logger.config("WS Path", CONFIG.WS_PATH.startsWith('/') ? CONFIG.WS_PATH : `/${CONFIG.WS_PATH}`);
        Logger.config("Domain", CONFIG.SB_DOMAIN || 'Not set');
        Logger.config("Fallback Host", CONFIG.SB_HOST);
        Logger.config("Version", CONFIG.SB_VERSION);
        Logger.config("Architecture", ARCH);

        // Setup certificates
        const certs = this.ensureCertificates();
        if (!certs.cert || !certs.key) {
            Logger.error("Certificate setup failed, skipping sb");
            return null;
        }

        // Download binary
        if (!this.ensureBinary()) {
            Logger.error("Binary download failed, skipping sb");
            return null;
        }

        // Create configuration and start
        this.writeConfiguration(certs.cert, certs.key);
        return this.start();
    }

    /**
     * Generate shareable links for both Hysteria2 and VLESS-WS
     */
    static async generateLinks() {
        const isp = await SystemUtils.getISPInfo();
        const serverHost = await this.getServerHost();
        const insecure = process.env.EXTERNAL_CERT ? "0" : "1";

        // Hysteria2 link
        const hy2Url = `hysteria2://${CONFIG.SB_UUID}@${serverHost}:${CONFIG.SB_PORT}/?sni=${CONFIG.SB_SNI}&obfs=salamander&obfs-password=${CONFIG.SB_OBFS_PWD}&insecure=${insecure}#${CONFIG.SB_NAME}-${isp}`;

        // VLESS-WS link (matches the requested format)
        // path without leading slash in the query to match common client expectations
        const wsPathForLink = CONFIG.WS_PATH.startsWith('/') ? CONFIG.WS_PATH.slice(1) : CONFIG.WS_PATH;
        const vlessWsUrl = `vless://${CONFIG.SB_UUID}@${serverHost}:${CONFIG.SB_PORT}?encryption=none&security=none&type=ws&path=${encodeURIComponent(wsPathForLink)}#${CONFIG.VLESS_NAME}-${isp}`;

        state.sboxLinks = [hy2Url];
        state.vlessWsLinks = [vlessWsUrl];
        state.sboxBase64 = Buffer.from(hy2Url).toString('base64');
        state.vlessWsBase64 = Buffer.from(vlessWsUrl).toString('base64');

        return { hy2: hy2Url, vlessWs: vlessWsUrl };
    }
}

// ========== X MANAGER ==========
class XManager {
    /**
     * Create X configuration
     */
    static createConfiguration() {
        Logger.step("Creating X configuration");

        const config = {
            log: {
                access: '/dev/null',
                error: '/dev/null',
                loglevel: 'none'
            },
            inbounds: [
                {
                    port: CONFIG.ARGO_PORT,
                    protocol: 'vless',
                    settings: {
                        clients: [{
                            id: CONFIG.UUID,
                            flow: 'xtls-rprx-vision'
                        }],
                        decryption: 'none',
                        fallbacks: [
                            { dest: 3001 },
                            { path: "/vless-argo", dest: 3002 }
                        ]
                    },
                    streamSettings: { network: 'tcp' }
                },
                {
                    port: 3001,
                    listen: "127.0.0.1",
                    protocol: "vless",
                    settings: {
                        clients: [{ id: CONFIG.UUID }],
                        decryption: "none"
                    },
                    streamSettings: {
                        network: "ws",
                        security: "none",
                        wsSettings: { path: "/vless-argo" }
                    }
                },
                {
                    port: 3002,
                    listen: "127.0.0.1",
                    protocol: "vless",
                    settings: {
                        clients: [{ id: CONFIG.UUID, level: 0 }],
                        decryption: "none"
                    },
                    streamSettings: {
                        network: "ws",
                        security: "none",
                        wsSettings: { path: "/vless-argo" }
                    },
                    sniffing: {
                        enabled: true,
                        destOverride: ["http", "tls", "quic"],
                        metadataOnly: false
                    }
                }
            ],
            dns: {
                servers: ["https+local://8.8.8.8/dns-query"]
            },
            outbounds: [
                { protocol: "freedom", tag: "direct" },
                { protocol: "blackhole", tag: "block" }
            ]
        };

        fs.writeFileSync(PATHS.X_CONFIG, JSON.stringify(config, null, 2));
        Logger.success("X configuration created");
    }

    /**
     * Get system architecture
     */
    static getSystemArchitecture() {
        const arch = os.arch();
        return (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') ? 'arm' : 'amd';
    }

    /**
     * Get files to download for current architecture
     */
    static getFilesForArchitecture(architecture) {
        const isArm = architecture === "arm";
        // Same mirrors as the original working setup (override with WEB_URL / BOT_URL)
        const webDefault = isArm
            ? "https://arm64.ssss.nyc.mn/web"
            : "https://amd64.ssss.nyc.mn/web";
        const botDefault = isArm
            ? "https://arm64.ssss.nyc.mn/2go"
            : "https://amd64.ssss.nyc.mn/2go";

        return [
            { fileName: "web", fileUrl: CONFIG.WEB_URL || webDefault },
            { fileName: "bot", fileUrl: CONFIG.BOT_URL || botDefault }
        ];
    }

    /**
     * Remove stale / incomplete binaries so they re-download
     */
    static purgeBadBinary(fileName, minBytes = 1024 * 500) {
        const p = path.join(CONFIG.FILE_PATH, fileName);
        try {
            if (fs.existsSync(p) && fs.statSync(p).size < minBytes) {
                fs.unlinkSync(p);
                Logger.warning(`Removed incomplete binary: ${fileName}`);
            }
        } catch { /* ignore */ }
    }

    /**
     * Download and setup X components
     */
    static async downloadAndRun() {
        const architecture = this.getSystemArchitecture();
        const filesToDownload = this.getFilesForArchitecture(architecture);

        if (filesToDownload.length === 0) {
            Logger.warning(`No files found for architecture: ${architecture}`);
            return;
        }

        // Drop truncated downloads from previous ENOSPC runs
        this.purgeBadBinary("web");
        this.purgeBadBinary("bot");

        Logger.step(`Downloading files for ${architecture} architecture`);

        try {
            const downloadPromises = filesToDownload.map(file =>
                SystemUtils.downloadFile(file.fileName, file.fileUrl)
            );
            await Promise.all(downloadPromises);
            Logger.success("All files downloaded successfully");
        } catch (error) {
            Logger.warning(`X components download failed: ${error}`);
            Logger.warning("Continuing without Argo/X — Hysteria2 and VLESS-WS remain available");
        }

        ["web", "bot"].forEach((name) => {
            const absoluteFilePath = path.join(CONFIG.FILE_PATH, name);
            if (fs.existsSync(absoluteFilePath)) {
                try { fs.chmodSync(absoluteFilePath, 0o755); } catch { /* ignore */ }
            }
        });

        // Stop previous instances so ports/logs are clean
        try {
            execSync(`pkill -f "${CONFIG.FILE_PATH}/web" 2>/dev/null || true`, { shell: true });
            execSync(`pkill -f "${CONFIG.FILE_PATH}/bot" 2>/dev/null || true`, { shell: true });
        } catch { /* ignore */ }

        if (fs.existsSync(path.join(CONFIG.FILE_PATH, "web"))) {
            await this.startXCore();
            // Let Xray bind ARGO_PORT before cloudflared connects
            await new Promise((r) => setTimeout(r, 2500));
        } else {
            Logger.warning("X core binary missing — skipping X server");
            return;
        }

        if (fs.existsSync(path.join(CONFIG.FILE_PATH, "bot"))) {
            await this.startCloudflared();
        } else {
            Logger.warning("Cloudflared binary missing — skipping Argo tunnel");
        }
    }

    /**
     * Start X core
     */
    static async startXCore() {
        const webPath = path.join(CONFIG.FILE_PATH, "web");
        const command = `nohup "${webPath}" -c "${PATHS.X_CONFIG}" >/dev/null 2>&1 &`;
        try {
            exec(command);
            Logger.success("X core started");
        } catch (error) {
            Logger.error(`Failed to start X core: ${error}`);
        }
    }

    /**
     * Start Cloudflared tunnel
     */
    static async startCloudflared() {
        const botPath = path.join(CONFIG.FILE_PATH, "bot");
        if (!fs.existsSync(botPath)) {
            return;
        }

        try { fs.writeFileSync(PATHS.BOOT_LOG, ""); } catch { /* ignore */ }

        let args;
        const auth = CONFIG.ARGO_AUTH || "";

        if (/^[A-Z0-9a-z=]{120,250}$/.test(auth)) {
            args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${auth}`;
        } else if (/TunnelSecret/.test(auth)) {
            args = `tunnel --edge-ip-version auto --config "${CONFIG.FILE_PATH}/tunnel.yml" run`;
        } else {
            // Quick tunnel — domain appears in log as *.trycloudflare.com
            // Match original working flags + explicit logfile
            args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile "${PATHS.BOOT_LOG}" --loglevel info --url http://127.0.0.1:${CONFIG.ARGO_PORT}`;
        }

        try {
            // Also append process streams in case --logfile is ignored by some builds
            const cmd = `nohup "${botPath}" ${args} >> "${PATHS.BOOT_LOG}" 2>&1 &`;
            exec(cmd);
            Logger.success("Cloudflared tunnel started");
        } catch (error) {
            Logger.error(`Failed to start Cloudflared: ${error}`);
        }
    }

    /**
     * Read trycloudflare.com hostname from cloudflared log
     */
    static parseArgoDomainFromLog(content) {
        if (!content) return null;
        // Matches: https://foo-bar.trycloudflare.com  or  foo-bar.trycloudflare.com
        const re = /(?:https?:\/\/)?([a-z0-9-]+\.trycloudflare\.com)/gi;
        let match;
        let last = null;
        while ((match = re.exec(content)) !== null) {
            const host = match[1].toLowerCase();
            if (host !== "fallback.trycloudflare.com" && host !== "trycloudflare.com") {
                last = host;
            }
        }
        return last;
    }

    /**
     * Poll boot.log until a trycloudflare domain appears (or timeout)
     */
    static async waitForArgoDomain(timeoutMs = 45000, intervalMs = 2000) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            try {
                if (fs.existsSync(PATHS.BOOT_LOG)) {
                    const content = fs.readFileSync(PATHS.BOOT_LOG, "utf8");
                    const domain = this.parseArgoDomainFromLog(content);
                    if (domain) return domain;
                }
            } catch {
                // keep polling
            }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        return null;
    }

    /**
     * Extract Argo tunnel domains
     */
    static async extractDomains() {
        let argoDomain;

        // Named tunnel: user must set ARGO_DOMAIN
        if (CONFIG.ARGO_AUTH && CONFIG.ARGO_DOMAIN) {
            argoDomain = CONFIG.ARGO_DOMAIN;
            Logger.config("ARGO_DOMAIN", argoDomain);
            await this.generateLinks(argoDomain);
            return argoDomain;
        }

        if (CONFIG.ARGO_AUTH && !CONFIG.ARGO_DOMAIN) {
            Logger.warning("ARGO_AUTH set without ARGO_DOMAIN — cannot build Argo link host");
        }

        Logger.step("Waiting for Cloudflare quick tunnel domain...");
        argoDomain = await this.waitForArgoDomain(45000, 2000);

        if (!argoDomain) {
            Logger.warning("Argo domain not found in log — using fallback");
            argoDomain = "fallback.trycloudflare.com";
        } else {
            Logger.config("Argo Domain", argoDomain);
        }

        await this.generateLinks(argoDomain);
        return argoDomain;
    }

    /**
     * Generate X shareable links
     */
    static async generateLinks(argoDomain) {
        const isp = await SystemUtils.getISPInfo();

        return new Promise((resolve) => {
            setTimeout(() => {
                const vlessLink = `vless://${CONFIG.UUID}@${CONFIG.CFIP}:${CONFIG.CFPORT}?encryption=none&security=tls&sni=${argoDomain}&type=ws&host=${argoDomain}&path=%2Fvless-argo%3Fed%3D2560#${CONFIG.NAME}-${isp}`;

                state.xLinks = [vlessLink];
                state.xBase64 = Buffer.from(vlessLink).toString('base64');

                resolve(vlessLink);
            }, 2000);
        });
    }
}

// ========== HTTP SERVER ==========
class HttpServer {
    /**
     * Create Express application (plain HTTP panel)
     */
    static createApp() {
        const app = express();

        const servePage = (req, res) => this.sendSubscriptionPage(res);
        app.get("/", servePage);
        app.get(`/${CONFIG.SUB_PATH}`, servePage);
        app.get("/sub", servePage);

        app.get("/health", (req, res) => {
            res.json({
                ok: true,
                hy2: !!state.sbProcess,
                port: CONFIG.SB_PORT,
                vlessLocal: CONFIG.VLESS_LOCAL_PORT
            });
        });

        return app;
    }

    /**
     * Start public HTTP server + WebSocket proxy to local VLESS
     * Public TCP port is owned by this server (plain http://IP:PORT/sub works).
     * WS upgrades on the VLESS path are piped to sing-box on 127.0.0.1.
     */
    static startServer() {
        const app = this.createApp();
        const server = http.createServer(app);

        const wsPathNorm = (CONFIG.WS_PATH.startsWith('/') ? CONFIG.WS_PATH : `/${CONFIG.WS_PATH}`).replace(/\/+$/, '') || '/';

        server.on("upgrade", (req, socket, head) => {
            try {
                const urlPath = (req.url || "/").split("?")[0].replace(/\/+$/, '') || '/';
                const pathOk =
                    urlPath === wsPathNorm ||
                    urlPath === wsPathNorm + '/' ||
                    decodeURIComponent(urlPath) === wsPathNorm;

                if (!pathOk) {
                    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
                    socket.destroy();
                    return;
                }

                // Pipe client socket ↔ local VLESS-WS (sing-box)
                const target = net.connect(CONFIG.VLESS_LOCAL_PORT, "127.0.0.1", () => {
                    // Rebuild the HTTP upgrade request for the backend
                    let reqLines = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
                    for (let i = 0; i < req.rawHeaders.length; i += 2) {
                        reqLines += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
                    }
                    reqLines += "\r\n";
                    target.write(reqLines);
                    if (head && head.length) target.write(head);

                    socket.pipe(target);
                    target.pipe(socket);
                });

                target.on("error", () => {
                    try { socket.destroy(); } catch { /* ignore */ }
                });
                socket.on("error", () => {
                    try { target.destroy(); } catch { /* ignore */ }
                });
            } catch {
                try { socket.destroy(); } catch { /* ignore */ }
            }
        });

        return new Promise((resolve, reject) => {
            server.listen(CONFIG.PORT, "0.0.0.0", () => {
                Logger.success(`HTTP panel + WS proxy on 0.0.0.0:${CONFIG.PORT}`);
                Logger.info(`Open: http://YOUR_IP:${CONFIG.PORT}/${CONFIG.SUB_PATH}`);
                resolve(server);
            });
            server.on("error", (err) => {
                Logger.error(`HTTP server error: ${err.message}`);
                reject(err);
            });
        });
    }

    /**
     * Send subscription page
     */
    static sendSubscriptionPage(res) {
        // Pass raw links; escaping is done inside the HTML builders
        res.send(this.generateHtml(
            state.xLinks.slice(),
            state.sboxLinks.slice(),
            state.vlessWsLinks.slice(),
            state.xBase64 || '',
            state.sboxBase64 || '',
            state.vlessWsBase64 || ''
        ));
    }

    /**
     * Escape HTML special characters
     */
    static escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    /**
     * Generate HTML page
     */
    static generateHtml(xLinks, sboxLinks, vlessWsLinks, xBase64, sboxBase64, vlessWsBase64) {
        const cards = [];
        if (sboxLinks.length > 0) cards.push(this.generateProtocolCard({
            id: 'hy2',
            title: 'Hysteria2',
            subtitle: 'High-speed UDP · Brutal congestion control',
            icon: 'fa-rocket',
            accent: 'hy2',
            badges: ['UDP', 'QUIC', 'Port ' + CONFIG.SB_PORT],
            links: sboxLinks,
            base64: sboxBase64
        }));
        if (vlessWsLinks.length > 0) cards.push(this.generateProtocolCard({
            id: 'vless',
            title: 'VLESS-WS',
            subtitle: 'WebSocket over TCP · same public port',
            icon: 'fa-network-wired',
            accent: 'vless',
            badges: ['TCP', 'WebSocket', 'No TLS'],
            links: vlessWsLinks,
            base64: vlessWsBase64
        }));
        if (xLinks.length > 0) cards.push(this.generateProtocolCard({
            id: 'argo',
            title: 'VLESS Argo',
            subtitle: 'Cloudflare Tunnel · CDN edge',
            icon: 'fa-cloud',
            accent: 'argo',
            badges: ['TLS', 'CDN', 'Argo'],
            links: xLinks,
            base64: xBase64
        }));

        const activeCount = cards.length;

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0b0f19">
<title>Xray-Sing · Nodes</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" rel="stylesheet">
<style>${this.getStyles()}</style>
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
        <span class="dot"></span> Online · ${activeCount} protocol${activeCount === 1 ? '' : 's'}
      </div>
    </div>
    <p class="hero-desc">Copy a link into your client (v2rayN, Streisand, Hiddify, NekoBox…). Hysteria2 and VLESS-WS share public port <strong>${CONFIG.SB_PORT}</strong>.</p>
  </header>

  <main class="grid">
    ${cards.length ? cards.join('') : '<div class="empty">No links generated yet. Wait a moment and refresh.</div>'}
  </main>

  <footer class="footer">
    <span>Port <code>${CONFIG.SB_PORT}</code></span>
    <span class="sep">·</span>
    <span>HY2 UDP + VLESS TCP</span>
    <span class="sep">·</span>
    <span>Xray-Sing</span>
  </footer>
</div>

<div class="toast" id="toast"><i class="fas fa-check"></i> <span id="toast-text">Copied</span></div>
<script>${this.getScript()}</script>
</body>
</html>`;
    }

    static getStyles() {
        return `
:root {
  --bg: #0b0f19;
  --surface: #121826;
  --surface2: #1a2234;
  --border: rgba(255,255,255,0.08);
  --border-hover: rgba(99,102,241,0.45);
  --text: #e8edf7;
  --muted: #8b95a8;
  --primary: #6366f1;
  --primary2: #818cf8;
  --hy2: #22d3ee;
  --vless: #a78bfa;
  --argo: #34d399;
  --ok: #10b981;
  --radius: 16px;
  --shadow: 0 20px 50px rgba(0,0,0,0.35);
  --font: 'Inter', system-ui, -apple-system, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, monospace;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.bg-glow {
  position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(ellipse 80% 50% at 20% -10%, rgba(99,102,241,0.18), transparent 50%),
    radial-gradient(ellipse 60% 40% at 90% 10%, rgba(34,211,238,0.1), transparent 45%),
    radial-gradient(ellipse 50% 30% at 50% 100%, rgba(167,139,250,0.08), transparent 40%);
}
.wrap {
  position: relative; z-index: 1;
  max-width: 1100px;
  margin: 0 auto;
  padding: 2rem 1.25rem 3rem;
}
.hero { margin-bottom: 2rem; }
.hero-top {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem;
}
.logo { display: flex; align-items: center; gap: 0.9rem; }
.logo-mark {
  width: 48px; height: 48px; border-radius: 14px;
  display: grid; place-items: center;
  background: linear-gradient(135deg, #6366f1, #22d3ee);
  box-shadow: 0 8px 24px rgba(99,102,241,0.35);
  font-size: 1.25rem; color: #fff;
}
.logo h1 {
  font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em;
}
.tagline { color: var(--muted); font-size: 0.85rem; }
.status-pill {
  display: inline-flex; align-items: center; gap: 0.45rem;
  padding: 0.4rem 0.85rem; border-radius: 999px;
  font-size: 0.8rem; font-weight: 600;
  background: rgba(16,185,129,0.12);
  color: var(--ok);
  border: 1px solid rgba(16,185,129,0.25);
}
.status-pill .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 3px rgba(16,185,129,0.25);
  animation: pulse 2s ease infinite;
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 3px rgba(16,185,129,0.25); }
  50% { box-shadow: 0 0 0 6px rgba(16,185,129,0.08); }
}
.hero-desc {
  color: var(--muted); font-size: 0.95rem; max-width: 42rem;
}
.hero-desc strong { color: var(--text); font-weight: 600; }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 1.25rem;
}
.empty {
  grid-column: 1 / -1;
  text-align: center; padding: 3rem;
  color: var(--muted);
  background: var(--surface);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.35rem 1.35rem 1.2rem;
  box-shadow: var(--shadow);
  transition: border-color 0.2s, transform 0.2s;
  display: flex; flex-direction: column; gap: 1rem;
}
.card:hover { border-color: var(--border-hover); transform: translateY(-2px); }

.card-head { display: flex; align-items: flex-start; gap: 0.9rem; }
.card-icon {
  width: 44px; height: 44px; border-radius: 12px;
  display: grid; place-items: center; font-size: 1.1rem; flex-shrink: 0;
}
.card.hy2 .card-icon { background: rgba(34,211,238,0.12); color: var(--hy2); }
.card.vless .card-icon { background: rgba(167,139,250,0.12); color: var(--vless); }
.card.argo .card-icon { background: rgba(52,211,153,0.12); color: var(--argo); }
.card-title { font-size: 1.15rem; font-weight: 650; letter-spacing: -0.01em; }
.card-sub { color: var(--muted); font-size: 0.82rem; margin-top: 0.15rem; }

.badges { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.badge {
  font-size: 0.7rem; font-weight: 600; letter-spacing: 0.02em;
  padding: 0.2rem 0.55rem; border-radius: 6px;
  background: var(--surface2); color: var(--muted);
  border: 1px solid var(--border);
}
.card.hy2 .badge.accent { color: var(--hy2); border-color: rgba(34,211,238,0.3); background: rgba(34,211,238,0.08); }
.card.vless .badge.accent { color: var(--vless); border-color: rgba(167,139,250,0.3); background: rgba(167,139,250,0.08); }
.card.argo .badge.accent { color: var(--argo); border-color: rgba(52,211,153,0.3); background: rgba(52,211,153,0.08); }

.section-label {
  font-size: 0.72rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted); margin-bottom: 0.5rem;
}

.link-box {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0.85rem;
}
.link-text {
  font-family: var(--mono);
  font-size: 0.72rem;
  line-height: 1.5;
  word-break: break-all;
  color: #c5d0e6;
  max-height: 4.5em;
  overflow: hidden;
  margin-bottom: 0.75rem;
}
.link-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }

.btn {
  appearance: none; border: none; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem;
  font-family: var(--font); font-size: 0.82rem; font-weight: 600;
  padding: 0.55rem 0.9rem; border-radius: 10px;
  transition: background 0.15s, transform 0.1s, opacity 0.15s;
}
.btn:active { transform: scale(0.97); }
.btn-primary {
  background: var(--primary); color: #fff;
}
.btn-primary:hover { background: var(--primary2); }
.btn-ghost {
  background: transparent; color: var(--muted);
  border: 1px solid var(--border);
}
.btn-ghost:hover { color: var(--text); border-color: rgba(255,255,255,0.18); background: rgba(255,255,255,0.04); }
.btn.copied { background: var(--ok) !important; color: #fff !important; border-color: transparent !important; }

.base64-wrap { margin-top: 0.15rem; }
.base64-toggle {
  width: 100%; justify-content: space-between;
  background: transparent; border: 1px solid var(--border);
  color: var(--muted); border-radius: 10px; padding: 0.55rem 0.85rem;
  font-size: 0.8rem; font-weight: 600; cursor: pointer;
  display: flex; align-items: center; gap: 0.5rem;
}
.base64-toggle:hover { color: var(--text); border-color: rgba(255,255,255,0.15); }
.base64-panel {
  display: none; margin-top: 0.6rem;
  background: #0a0e16; border: 1px solid var(--border);
  border-radius: 10px; padding: 0.75rem;
}
.base64-panel.open { display: block; }
.base64-panel code {
  font-family: var(--mono); font-size: 0.68rem;
  word-break: break-all; color: #9aa8c2; display: block;
  margin-bottom: 0.65rem; line-height: 1.45;
}

.footer {
  margin-top: 2.5rem; text-align: center;
  color: var(--muted); font-size: 0.8rem;
  display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 0.35rem;
}
.footer code {
  font-family: var(--mono); font-size: 0.78rem;
  background: var(--surface2); padding: 0.1rem 0.4rem; border-radius: 4px;
  color: var(--text);
}
.sep { opacity: 0.4; }

.toast {
  position: fixed; bottom: 1.5rem; left: 50%;
  transform: translateX(-50%) translateY(120%);
  background: #0f172a; color: #fff;
  border: 1px solid rgba(16,185,129,0.4);
  padding: 0.75rem 1.25rem; border-radius: 12px;
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.9rem; font-weight: 600;
  box-shadow: 0 12px 40px rgba(0,0,0,0.45);
  opacity: 0; transition: transform 0.25s ease, opacity 0.25s ease;
  z-index: 1000; pointer-events: none;
}
.toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
.toast i { color: var(--ok); }

@media (max-width: 640px) {
  .wrap { padding: 1.25rem 1rem 2rem; }
  .logo h1 { font-size: 1.25rem; }
  .link-actions .btn { flex: 1; }
}
`;
    }

    static getScript() {
        return `
function copyText(text, btn) {
  const done = () => {
    const toast = document.getElementById('toast');
    const t = document.getElementById('toast-text');
    if (t) t.textContent = 'Copied to clipboard';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1800);
    if (btn) {
      const prev = btn.innerHTML;
      btn.classList.add('copied');
      btn.innerHTML = '<i class="fas fa-check"></i> Copied';
      setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = prev; }, 1600);
    }
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallback(text, done));
  } else {
    fallback(text, done);
  }
}
function fallback(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); }
  catch (e) { alert('Copy failed — select the text manually'); }
  document.body.removeChild(ta);
}
function toggleBase64(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('open');
}
`;
    }

    /**
     * Unified protocol card
     */
    static generateProtocolCard({ id, title, subtitle, icon, accent, badges, links, base64 }) {
        const link = links[0] || '';
        const badgesHtml = (badges || []).map((b, i) =>
            `<span class="badge${i === 0 ? ' accent' : ''}">${this.escapeHtml(b)}</span>`
        ).join('');

        // Safe embedding into onclick="copyText(<json>, this)"
        const asJsArg = (s) => this.escapeHtml(JSON.stringify(s || ''));

        return `
<article class="card ${accent}">
  <div class="card-head">
    <div class="card-icon"><i class="fas ${icon}"></i></div>
    <div>
      <div class="card-title">${this.escapeHtml(title)}</div>
      <div class="card-sub">${this.escapeHtml(subtitle)}</div>
    </div>
  </div>
  <div class="badges">${badgesHtml}</div>
  <div>
    <div class="section-label">Connection link</div>
    <div class="link-box">
      <div class="link-text">${link ? this.escapeHtml(link) : 'Not available'}</div>
      <div class="link-actions">
        ${link ? `
        <button class="btn btn-primary" type="button" onclick="copyText(${asJsArg(link)}, this)">
          <i class="fas fa-copy"></i> Copy link
        </button>
        <button class="btn btn-ghost" type="button" onclick="copyText(${asJsArg(base64)}, this)" ${base64 ? '' : 'disabled'}>
          <i class="fas fa-code"></i> Copy Base64
        </button>` : '<span class="card-sub">Waiting for generation…</span>'}
      </div>
    </div>
  </div>
  ${base64 ? `
  <div class="base64-wrap">
    <button class="base64-toggle" type="button" onclick="toggleBase64('b64-${id}')">
      <span><i class="fas fa-chevron-down"></i> Show Base64 / subscription</span>
    </button>
    <div class="base64-panel" id="b64-${id}">
      <code>${this.escapeHtml(base64)}</code>
      <button class="btn btn-ghost" type="button" onclick="copyText(${asJsArg(base64)}, this)">
        <i class="fas fa-copy"></i> Copy Base64
      </button>
    </div>
  </div>` : ''}
</article>`;
    }
}

// ========== MAIN APPLICATION ==========
class Application {
    /**
     * Initialize application
     */
    static async initialize() {
        SystemUtils.ensureDirectory(CONFIG.FILE_PATH);
        SystemUtils.ensureDirectory(PATHS.SB_BASE_DIR);

        // Persist UUID so restarts keep the same node id when UUID env is unset
        const uuidFile = path.join(CONFIG.FILE_PATH, "uuid.txt");
        if (!process.env.UUID && !process.env.SB_UUID) {
            try {
                if (fs.existsSync(uuidFile)) {
                    const saved = fs.readFileSync(uuidFile, "utf8").trim();
                    if (saved) {
                        CONFIG.UUID = saved;
                        CONFIG.SB_UUID = saved;
                        if (!process.env.WS_PATH) CONFIG.WS_PATH = saved;
                    }
                } else {
                    fs.writeFileSync(uuidFile, CONFIG.UUID);
                }
            } catch {
                // ignore
            }
        }

        // Persist OBFS password — critical: random each boot would break client links
        const obfsFile = path.join(CONFIG.FILE_PATH, "obfs.txt");
        if (CONFIG.SB_OBFS_PWD) {
            try { fs.writeFileSync(obfsFile, CONFIG.SB_OBFS_PWD); } catch { /* ignore */ }
        } else {
            try {
                if (fs.existsSync(obfsFile)) {
                    CONFIG.SB_OBFS_PWD = fs.readFileSync(obfsFile, "utf8").trim();
                }
            } catch { /* ignore */ }
            if (!CONFIG.SB_OBFS_PWD) {
                CONFIG.SB_OBFS_PWD = crypto.randomBytes(16).toString("hex");
                try { fs.writeFileSync(obfsFile, CONFIG.SB_OBFS_PWD); } catch { /* ignore */ }
            }
        }
    }

    /**
     * Start the application
     */
    static async start() {
        Logger.header("Xray-Sing starting");

        await this.initialize();
        Logger.success(`Data directory: ${CONFIG.FILE_PATH}`);
        Logger.info(`Public port: ${CONFIG.PORT}  |  Argo: ${CONFIG.ENABLE_ARGO ? "on" : "off"}`);

        if (process.env.ENABLE_SYSCTL === "1" || process.env.ENABLE_SYSCTL === "true") {
            SystemUtils.applySystemOptimizations();
        }

        Logger.step("[1/3] Starting sing-box (Hysteria2 + VLESS-WS)...");
        state.sbProcess = await SbManager.initialize();
        if (state.sbProcess) {
            await SbManager.generateLinks();
            Logger.success("sing-box is running");
        } else {
            Logger.error("sing-box failed to start");
        }

        Logger.step("[2/3] Starting HTTP panel + WS proxy...");
        await HttpServer.startServer();
        Logger.success(`Panel ready on port ${CONFIG.PORT}`);

        if (CONFIG.ENABLE_ARGO) {
            Logger.step("[3/3] Starting Xray + Cloudflare Argo...");
            XManager.createConfiguration();
            await XManager.downloadAndRun();
            await new Promise((resolve) => setTimeout(resolve, 3000));
            await XManager.extractDomains();
            if (state.xLinks.length > 0) {
                Logger.success("Argo tunnel is ready");
            } else {
                Logger.warning("Argo link not ready (check boot.log)");
            }
        } else {
            Logger.info("[3/3] Argo disabled (ENABLE_ARGO=0)");
        }

        await this.printAllLinks();
    }

    /**
     * Final summary for the user, then clear console after 3 minutes
     */
    static async printAllLinks() {
        const host = await SbManager.getServerHost();
        const webUrl = `http://${host}:${CONFIG.PORT}/${CONFIG.SUB_PATH}`;

        console.log("");
        Logger.header("READY");
        console.log(`${COLORS.bright}${COLORS.green}  All services are running${COLORS.reset}`);
        console.log("");
        console.log(`${COLORS.bright}  Web panel${COLORS.reset}`);
        console.log(`  ${COLORS.yellow}${webUrl}${COLORS.reset}`);
        console.log("");

        if (state.sboxLinks.length > 0) {
            console.log(`${COLORS.bright}  Hysteria2${COLORS.reset}`);
            state.sboxLinks.forEach((link) => {
                console.log(`  ${COLORS.white}${link}${COLORS.reset}`);
            });
            console.log("");
        }

        if (state.vlessWsLinks.length > 0) {
            console.log(`${COLORS.bright}  VLESS-WS${COLORS.reset}`);
            state.vlessWsLinks.forEach((link) => {
                console.log(`  ${COLORS.white}${link}${COLORS.reset}`);
            });
            console.log("");
        }

        if (CONFIG.ENABLE_ARGO && state.xLinks.length > 0) {
            console.log(`${COLORS.bright}  VLESS Argo${COLORS.reset}`);
            state.xLinks.forEach((link) => {
                console.log(`  ${COLORS.white}${link}${COLORS.reset}`);
            });
            console.log("");
        }

        console.log(`${COLORS.dim}  Links also saved to: ${path.join(CONFIG.FILE_PATH, "links.txt")}${COLORS.reset}`);
        console.log(`${COLORS.dim}  Console will clear in 3 minutes...${COLORS.reset}`);
        console.log(`${COLORS.bright}${COLORS.cyan}${"━".repeat(56)}${COLORS.reset}`);
        console.log("");

        try {
            const linksFile = path.join(CONFIG.FILE_PATH, "links.txt");
            const lines = [
                `Web: ${webUrl}`,
                "",
                "=== Hysteria2 ===",
                ...state.sboxLinks,
                "",
                "=== VLESS-WS ===",
                ...state.vlessWsLinks,
            ];
            if (CONFIG.ENABLE_ARGO && state.xLinks.length) {
                lines.push("", "=== X/Argo ===", ...state.xLinks);
            }
            fs.writeFileSync(linksFile, lines.join("\n") + "\n");
        } catch {
            // silent
        }

        // Keep timer on the event loop; clear with no further messages
        const clearTimer = setTimeout(() => {
            Logger.clearConsole();
        }, 3 * 60 * 1000);
        // Do NOT unref — must fire while the server keeps running
        if (clearTimer.ref) clearTimer.ref();
    }
}

// ========== ERROR HANDLING & SHUTDOWN ==========
function shutdown(signal) {
    try {
        if (state.sbProcess && !state.sbProcess.killed) {
            state.sbProcess.kill("SIGTERM");
        }
    } catch { /* ignore */ }
    process.exit(signal === "SIGINT" ? 130 : 0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (error) => {
    Logger.error(`Uncaught Exception: ${error.message}`);
});

process.on("unhandledRejection", (reason) => {
    Logger.error(`Unhandled Rejection: ${reason}`);
});

// ========== APPLICATION START ==========
Application.start().catch((error) => {
    Logger.error(`Application failed to start: ${error.message}`);
    process.exit(1);
});
