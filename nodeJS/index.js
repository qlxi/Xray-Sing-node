const express = require("express");
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const { exec, execSync, spawn, spawnSync } = require('child_process');

// ========== CONFIGURATION ==========
const CONFIG = {
    // X settings
    UUID: process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913',
    FILE_PATH: process.env.FILE_PATH || '/tmp/.cache',
    SUB_PATH: process.env.SUB_PATH || 'sub',
    PORT: process.env.SERVER_PORT || process.env.PORT || 3000,
    NAME: process.env.NAME || 'vless',
    
    // CDN settings
    CFIP: process.env.CFIP || 'www.kick.com',
    CFPORT: process.env.CFPORT || 443,
    
    // Argo Tunnel
    ARGO_DOMAIN: process.env.ARGO_DOMAIN || '',
    ARGO_AUTH: process.env.ARGO_AUTH || '',
    ARGO_PORT: process.env.ARGO_PORT || 8001,
    
    // sb settings
    SB_VERSION: process.env.SB_VERSION || "1.11.15",
    SB_NAME: process.env.SB_NAME || "HY2",
    SB_PORT: parseInt(process.env.SB_PORT || process.env.SERVER_PORT || process.env.PORT || "2705", 10),
    SB_UUID: process.env.SB_UUID || process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913',
    SB_SNI: process.env.SB_SNI || "time.android.com",
    SB_MASS_PROXY: process.env.SB_MASS_PROXY || "https://www.gstatic.com",
    SB_DOMAIN: process.env.SB_DOMAIN || process.env.DOMAIN,
    SB_HOST: process.env.SB_HOST || "127.0.0.1",
    SB_OBFS_PWD: process.env.SB_OBFS_PWD || Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    
    // VLESS WS settings (same port as Hysteria2)
    VLESS_PATH: process.env.VLESS_PATH || Math.random().toString(36).slice(2, 15) + '-' + Math.random().toString(36).slice(2, 15)
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
    sboxLinks: [],
    xBase64: "",
    sboxBase64: "",
    sbProcess: null
};

// ========== LOGGER ==========
class Logger {
    static info(message) {
        console.log(`${COLORS.cyan}ℹ ${message}${COLORS.reset}`);
    }

    static success(message) {
        console.log(`${COLORS.green}✅ ${message}${COLORS.reset}`);
    }

    static warning(message) {
        console.log(`${COLORS.yellow}⚠ ${message}${COLORS.reset}`);
    }

    static error(message) {
        console.log(`${COLORS.red}❌ ${message}${COLORS.reset}`);
    }

    static step(message) {
        console.log(`${COLORS.blue}➤ ${message}${COLORS.reset}`);
    }

    static header(message) {
        console.log(`\n${COLORS.bright}${COLORS.magenta}${'='.repeat(60)}${COLORS.reset}`);
        console.log(`${COLORS.bright}${COLORS.magenta}${message}${COLORS.reset}`);
        console.log(`${COLORS.bright}${COLORS.magenta}${'='.repeat(60)}${COLORS.reset}\n`);
    }

    static divider() {
        console.log(`${COLORS.dim}${'-'.repeat(60)}${COLORS.reset}`);
    }

    static config(key, value) {
        console.log(`  ${COLORS.cyan}${key}:${COLORS.reset} ${COLORS.yellow}${value}${COLORS.reset}`);
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
     * Get ISP information
     */
    static async getISPInfo() {
        try {
            const metaInfo = spawnSync(
                'curl -s https://speed.cloudflare.com/meta | awk -F\\" \'{print $26"-"$18}\' | sed -e \'s/ /_/g\'',
                { 
                    encoding: 'utf-8',
                    shell: true 
                }
            );
            
            if (metaInfo.status === 0 && metaInfo.stdout) {
                const isp = metaInfo.stdout.trim();
                return isp && isp.length > 0 ? isp : "UNKNOWN";
            }
        } catch (error) {
            Logger.error(`Failed to get ISP info: ${error.message}`);
        }
        return "UNKNOWN";
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

// ========== SB MANAGER ==========
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
     * Ensure TLS certificates exist
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
            Logger.success("sb installed successfully");
            return true;
        }
        
        Logger.error("sb binary not found in archive");
        return false;
    }

    /**
     * Create sb configuration
     */
    static writeConfiguration(cert, key) {
        Logger.step("Creating sb configuration");
        
        const config = {
            "log": {
                "level": "info",
                "timestamp": true
            },
            "inbounds": [
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
                {
                    "type": "vless",
                    "tag": "vless-ws-in",
                    "listen": "::",
                    "listen_port": CONFIG.SB_PORT,
                    "users": [
                        {
                            "uuid": CONFIG.SB_UUID
                        }
                    ],
                    "transport": {
                        "type": "ws",
                        "path": `/${CONFIG.VLESS_PATH}`,
                        "max_early_data": 0
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
        Logger.success("sb configuration created");
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
        Logger.header("SB + VLESS WS CONFIGURATION");
        
        // Display configuration
        Logger.config("Node Name", CONFIG.SB_NAME);
        Logger.config("Port (UDP+TCP)", CONFIG.SB_PORT);
        Logger.config("UUID", CONFIG.SB_UUID);
        Logger.config("SNI", CONFIG.SB_SNI);
        Logger.config("Domain", CONFIG.SB_DOMAIN || 'Not set');
        Logger.config("Fallback Host", CONFIG.SB_HOST);
        Logger.config("Version", CONFIG.SB_VERSION);
        Logger.config("Architecture", ARCH);
        Logger.config("VLESS Path", CONFIG.VLESS_PATH);
        Logger.info("");
        Logger.info("Protocols enabled:");
        Logger.info("  • Hysteria2 (UDP) - High performance QUIC-based protocol");
        Logger.info("  • VLESS WebSocket (TCP) - Stealthy HTTP-like traffic");

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
     * Generate shareable links
     */
    static async generateLinks() {
        const isp = await SystemUtils.getISPInfo();
        const serverHost = await this.getServerHost();
        const insecure = process.env.EXTERNAL_CERT ? "0" : "1";

        // Hysteria2 link (UDP)
        const hy2Url = `hysteria2://${CONFIG.SB_UUID}@${serverHost}:${CONFIG.SB_PORT}/?sni=${CONFIG.SB_SNI}&obfs=salamander&obfs-password=${CONFIG.SB_OBFS_PWD}&insecure=${insecure}#${CONFIG.SB_NAME}-${isp}`;
        
        // VLESS WS link (TCP) - same port as Hysteria2
        const vlessWsUrl = `vless://${CONFIG.SB_UUID}@${serverHost}:${CONFIG.SB_PORT}?encryption=none&security=none&type=ws&path=/${CONFIG.VLESS_PATH}#${CONFIG.NAME}-vless-ws-${isp}`;

        state.sboxLinks = [hy2Url, vlessWsUrl];
        state.sboxBase64 = Buffer.from(state.sboxLinks.join('\n')).toString('base64');
        
        return hy2Url;
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
        return architecture === 'arm' ? [
            { fileName: "web", fileUrl: "https://arm64.ssss.nyc.mn/web" },
            { fileName: "bot", fileUrl: "https://arm64.ssss.nyc.mn/2go" }
        ] : [
            { fileName: "web", fileUrl: "https://amd64.ssss.nyc.mn/web" },
            { fileName: "bot", fileUrl: "https://amd64.ssss.nyc.mn/2go" }
        ];
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

        Logger.step(`Downloading files for ${architecture} architecture`);
        
        try {
            const downloadPromises = filesToDownload.map(file => 
                SystemUtils.downloadFile(file.fileName, file.fileUrl)
            );
            await Promise.all(downloadPromises);
            Logger.success("All files downloaded successfully");
        } catch (error) {
            Logger.error(`Download failed: ${error}`);
            return;
        }

        // Set file permissions
        const filesToAuthorize = ['./web', './bot'];
        filesToAuthorize.forEach(relativeFilePath => {
            const absoluteFilePath = path.join(CONFIG.FILE_PATH, relativeFilePath);
            if (fs.existsSync(absoluteFilePath)) {
                fs.chmodSync(absoluteFilePath, 0o755);
                Logger.success(`Permissions set for: ${absoluteFilePath}`);
            }
        });

        // Start services
        await this.startXCore();
        await this.startCloudflared();
    }

    /**
     * Start X core
     */
    static async startXCore() {
        const command = `nohup ${CONFIG.FILE_PATH}/web -c ${PATHS.X_CONFIG} >/dev/null 2>&1 &`;
        try {
            exec(command);
            Logger.success('X core started');
        } catch (error) {
            Logger.error(`Failed to start X core: ${error}`);
        }
    }

    /**
     * Start Cloudflared tunnel
     */
    static async startCloudflared() {
        if (!fs.existsSync(path.join(CONFIG.FILE_PATH, 'bot'))) {
            return;
        }

        let args;

        if (CONFIG.ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
            args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${CONFIG.ARGO_AUTH}`;
        } else if (CONFIG.ARGO_AUTH.match(/TunnelSecret/)) {
            args = `tunnel --edge-ip-version auto --config ${CONFIG.FILE_PATH}/tunnel.yml run`;
        } else {
            args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile ${PATHS.BOOT_LOG} --loglevel info --url http://localhost:${CONFIG.ARGO_PORT}`;
        }

        try {
            exec(`nohup ${CONFIG.FILE_PATH}/bot ${args} >/dev/null 2>&1 &`);
            Logger.success('Cloudflared tunnel started');
        } catch (error) {
            Logger.error(`Failed to start Cloudflared: ${error}`);
        }
    }

    /**
     * Extract Argo tunnel domains
     */
    static async extractDomains() {
        let argoDomain;

        if (CONFIG.ARGO_AUTH && CONFIG.ARGO_DOMAIN) {
            argoDomain = CONFIG.ARGO_DOMAIN;
            Logger.config('ARGO_DOMAIN', argoDomain);
            await this.generateLinks(argoDomain);
        } else {
            try {
                Logger.step("Waiting for Cloudflared to start...");
                await new Promise(resolve => setTimeout(resolve, 8000));
                
                if (fs.existsSync(PATHS.BOOT_LOG)) {
                    const fileContent = fs.readFileSync(PATHS.BOOT_LOG, 'utf-8');
                    const domains = fileContent.split('\n')
                        .map(line => line.match(/https?:\/\/([^ ]*trycloudflare\.com)\/?/))
                        .filter(match => match)
                        .map(match => match[1]);

                    argoDomain = domains.length > 0 ? domains[0] : "fallback.trycloudflare.com";
                    Logger.config('Argo Domain', argoDomain);
                } else {
                    Logger.warning('Boot log not found, using fallback domain');
                    argoDomain = "fallback.trycloudflare.com";
                }
                
                await this.generateLinks(argoDomain);
            } catch (error) {
                Logger.error('Error reading boot log:', error);
                argoDomain = "fallback.trycloudflare.com";
                await this.generateLinks(argoDomain);
            }
        }

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
     * Create Express application
     */
    static createApp() {
        const app = express();

        // Health check endpoint
        app.get("/", (req, res) => {
            res.json({ 
                service: "Hello World",
            });
        });

        // Subscription endpoint
        app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
            this.sendSubscriptionPage(res);
        });

        return app;
    }

    /**
     * Send subscription page
     */
    static sendSubscriptionPage(res) {
        const safeXLinks = state.xLinks.map(link => this.escapeHtml(link));
        const safeSboxLinks = state.sboxLinks.map(link => this.escapeHtml(link));
        const safeXBase64 = this.escapeHtml(state.xBase64 || '');
        const safeSboxBase64 = this.escapeHtml(state.sboxBase64 || '');

        res.send(this.generateHtml(safeXLinks, safeSboxLinks, safeXBase64, safeSboxBase64));
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
    static generateHtml(xLinks, sboxLinks, xBase64, sboxBase64) {
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Xray-Sing</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <style>
        ${this.getStyles()}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><i class="fas fa-shield-alt"></i> Xray-Sing</h1>
            <p>Secure and fast configurations</p>
            <div class="status-indicator">
                <i class="fas fa-circle"></i> Online
            </div>
        </div>

        <div class="grid">
            ${this.generateXCard(xLinks, xBase64)}
            ${this.generateSboxCard(sboxLinks, sboxBase64)}
        </div>
    </div>

    <div class="toast" id="toast">Copied to clipboard!</div>

    <script>
        ${this.getScript()}
    </script>
</body>
</html>`;
    }

    /**
     * Get CSS styles
     */
    static getStyles() {
        return `
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :root {
            --primary: #6366f1;
            --primary-dark: #4f46e5;
            --secondary: #10b981;
            --dark: #1f2937;
            --darker: #111827;
            --light: #f9fafb;
            --gray: #6b7280;
            --border: #374151;
        }

        body {
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            background: linear-gradient(135deg, var(--darker) 0%, var(--dark) 100%);
            color: var(--light);
            min-height: 100vh;
            line-height: 1.6;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 2rem;
        }

        .header {
            text-align: center;
            margin-bottom: 3rem;
        }

        .header h1 {
            font-size: 3rem;
            font-weight: 700;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 0.5rem;
        }

        .header p {
            color: var(--gray);
            font-size: 1.2rem;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
            gap: 2rem;
            margin-bottom: 2rem;
        }

        .card {
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(10px);
            border: 1px solid var(--border);
            border-radius: 1rem;
            padding: 2rem;
            transition: all 0.3s ease;
        }

        .card:hover {
            transform: translateY(-5px);
            border-color: var(--primary);
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
        }

        .card-header {
            display: flex;
            align-items: center;
            gap: 1rem;
            margin-bottom: 1.5rem;
        }

        .card-icon {
            width: 50px;
            height: 50px;
            background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.5rem;
        }

        .card-title {
            font-size: 1.5rem;
            font-weight: 600;
        }

        .card-subtitle {
            color: var(--gray);
            font-size: 0.9rem;
        }

        .link-item {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--border);
            border-radius: 0.75rem;
            padding: 1rem;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 1rem;
            transition: all 0.3s ease;
        }

        .link-item:hover {
            border-color: var(--primary);
            background: rgba(99, 102, 241, 0.1);
        }

        .link-content {
            flex: 1;
            word-break: break-all;
            font-family: 'Monaco', 'Consolas', monospace;
            font-size: 0.85rem;
            color: var(--light);
        }

        .copy-btn {
            background: var(--primary);
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 0.5rem;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.9rem;
            transition: all 0.3s ease;
            white-space: nowrap;
        }

        .copy-btn:hover {
            background: var(--primary-dark);
            transform: scale(1.05);
        }

        .copy-btn.copied {
            background: var(--secondary);
        }

        .base64-section {
            margin-top: 1.5rem;
        }

        .base64-title {
            font-size: 1.1rem;
            font-weight: 600;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .base64-content {
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border);
            border-radius: 0.75rem;
            padding: 1rem;
            font-family: 'Monaco', 'Consolas', monospace;
            font-size: 0.8rem;
            line-height: 1.4;
            word-break: break-all;
            margin-bottom: 1rem;
            position: relative;
        }

        .protocol-badge {
            background: var(--primary);
            color: white;
            padding: 0.25rem 0.75rem;
            border-radius: 1rem;
            font-size: 0.75rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
            display: inline-block;
        }

        .status-indicator {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.25rem 0.75rem;
            background: var(--secondary);
            color: white;
            border-radius: 1rem;
            font-size: 0.75rem;
            font-weight: 600;
            margin-left: 1rem;
        }

        .status-indicator.offline {
            background: #ef4444;
        }

        @media (max-width: 768px) {
            .container {
                padding: 1rem;
            }

            .grid {
                grid-template-columns: 1fr;
            }

            .header h1 {
                font-size: 2rem;
            }

            .link-item {
                flex-direction: column;
                align-items: stretch;
            }

            .copy-btn {
                align-self: stretch;
                justify-content: center;
            }
        }

        .toast {
            position: fixed;
            bottom: 2rem;
            right: 2rem;
            background: var(--secondary);
            color: white;
            padding: 1rem 2rem;
            border-radius: 0.75rem;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
            transform: translateY(100px);
            opacity: 0;
            transition: all 0.3s ease;
            z-index: 1000;
        }

        .toast.show {
            transform: translateY(0);
            opacity: 1;
        }`;
    }

    /**
     * Get JavaScript code
     */
    static getScript() {
        return `
        function copyToClipboard(text, button) {
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(() => {
                    showToast(button);
                }).catch(err => {
                    console.error('Failed to copy with navigator.clipboard: ', err);
                    fallbackCopyToClipboard(text, button);
                });
            } else {
                fallbackCopyToClipboard(text, button);
            }
        }

        function fallbackCopyToClipboard(text, button) {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                showToast(button);
            } catch (err) {
                console.error('Failed to copy with execCommand: ', err);
                alert('Failed to copy to clipboard. Please copy manually.');
            } finally {
                document.body.removeChild(textarea);
            }
        }

        function showToast(button) {
            const toast = document.getElementById('toast');
            toast.classList.add('show');
            setTimeout(() => {
                toast.classList.remove('show');
            }, 2000);

            if (button) {
                const originalText = button.innerHTML;
                button.innerHTML = '<i class="fas fa-check"></i> Copied!';
                button.classList.add('copied');
                setTimeout(() => {
                    button.innerHTML = originalText;
                    button.classList.remove('copied');
                }, 2000);
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            const cards = document.querySelectorAll('.card');
            cards.forEach(card => {
                card.addEventListener('click', (e) => {
                    if (!e.target.closest('.copy-btn')) {
                        card.style.transform = 'scale(0.98)';
                        setTimeout(() => {
                            card.style.transform = '';
                        }, 150);
                    }
                });
            });
        });`;
    }

    /**
     * Generate X configuration card
     */
    static generateXCard(links, base64) {
        return `
        <div class="card">
            <div class="card-header">
                <div class="card-icon">
                    <i class="fas fa-bolt"></i>
                </div>
                <div>
                    <div class="card-title">X Protocol</div>
                    <div class="card-subtitle">VLESS Argo protocol</div>
                </div>
            </div>

            <div class="protocol-badge">Connection Link</div>
            ${links.length > 0 ? links.map(link => `
                <div class="link-item">
                    <div class="link-content">${link}</div>
                    <button class="copy-btn" onclick="copyToClipboard('${link}', this)">
                        <i class="fas fa-copy"></i> Copy
                    </button>
                </div>
            `).join('') : '<div class="link-item"><div class="link-content">Links not generated yet</div></div>'}

            <div class="base64-section">
                <div class="base64-title">
                    <i class="fas fa-qrcode"></i> Base64 Configuration
                </div>
                ${base64 ? `
                    <div class="base64-content">${base64}</div>
                    <button class="copy-btn" onclick="copyToClipboard('${base64}', this)">
                        <i class="fas fa-copy"></i> Copy Base64
                    </button>
                ` : '<div class="base64-content">Subscription not generated yet</div>'}
            </div>
        </div>`;
    }

    /**
     * Generate sb configuration card
     */
    static generateSboxCard(links, base64) {
        // Separate Hysteria2 and VLESS WS links
        const hy2Links = links.filter(link => link.startsWith('hysteria2://'));
        const vlessWsLinks = links.filter(link => link.startsWith('vless://') && link.includes('type=ws'));
        
        return `
        <div class="card">
            <div class="card-header">
                <div class="card-icon">
                    <i class="fas fa-rocket"></i>
                </div>
                <div>
                    <div class="card-title">HY2 + VLESS WS</div>
                    <div class="card-subtitle">Hysteria2 (UDP) + VLESS WS (TCP) on same port</div>
                </div>
            </div>

            ${hy2Links.length > 0 ? `
            <div class="protocol-badge">Hysteria2 Protocol (UDP)</div>
            ${hy2Links.map(link => `
                <div class="link-item">
                    <div class="link-content">${link}</div>
                    <button class="copy-btn" onclick="copyToClipboard('${link}', this)">
                        <i class="fas fa-copy"></i> Copy HY2
                    </button>
                </div>
            `).join('')}
            ` : ''}

            ${vlessWsLinks.length > 0 ? `
            <div class="protocol-badge" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">VLESS WebSocket (TCP)</div>
            ${vlessWsLinks.map(link => `
                <div class="link-item">
                    <div class="link-content">${link}</div>
                    <button class="copy-btn" onclick="copyToClipboard('${link}', this)" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
                        <i class="fas fa-copy"></i> Copy VLESS WS
                    </button>
                </div>
            `).join('')}
            ` : ''}

            <div class="base64-section">
                <div class="base64-title">
                    <i class="fas fa-qrcode"></i> Base64 Configuration (All Protocols)
                </div>
                ${base64 ? `
                    <div class="base64-content">${base64}</div>
                    <button class="copy-btn" onclick="copyToClipboard('${base64}', this)">
                        <i class="fas fa-copy"></i> Copy Base64
                    </button>
                ` : '<div class="base64-content">Configuration not generated yet</div>'}
            </div>
        </div>`;
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
    }

    /**
     * Start the application
     */
    static async start() {
        Logger.header("🚀 XRAY-SING STARTUP");
        
        await this.initialize();
        
        // Apply system optimizations
        SystemUtils.applySystemOptimizations();

        // Start sb
        Logger.step("Starting sb server...");
        state.sbProcess = await SbManager.initialize();
        
        if (state.sbProcess) {
            await SbManager.generateLinks();
        } else {
            Logger.warning("sb failed to start, skipping link generation");
        }

        // Start X
        Logger.step("Starting X server...");
        XManager.createConfiguration();
        await XManager.downloadAndRun();

        // Wait for services to start
        Logger.step("Waiting for services to start...");
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Generate links
        await XManager.extractDomains();

        // Start HTTP server
        const app = HttpServer.createApp();
        app.listen(CONFIG.PORT, () => {
            Logger.success(`HTTP server running on port: ${CONFIG.PORT}`);
            this.printAllLinks();
        });
    }

    /**
     * Print all connection links
     */
    static printAllLinks() {
        Logger.header("🔗 CONNECTION LINKS");
        
        console.log(`\n${COLORS.green}${COLORS.bright}📡 X LINKS:${COLORS.reset}`);
        state.xLinks.forEach((link, index) => {
            console.log(`  ${COLORS.cyan}${index + 1}.${COLORS.reset} ${COLORS.yellow}${link}${COLORS.reset}`);
        });
        
        console.log(`\n${COLORS.blue}${COLORS.bright}🔗 X BASE64 (Subscription):${COLORS.reset}`);
        console.log(`  ${COLORS.white}${state.xBase64}${COLORS.reset}`);
        
        if (state.sboxLinks.length > 0) {
            console.log(`\n${COLORS.magenta}${COLORS.bright}⚡ HYSTERIA2 + VLESS WS LINKS:${COLORS.reset}`);
            
            // Separate and display Hysteria2 links
            const hy2Links = state.sboxLinks.filter(link => link.startsWith('hysteria2://'));
            const vlessWsLinks = state.sboxLinks.filter(link => link.startsWith('vless://') && link.includes('type=ws'));
            
            if (hy2Links.length > 0) {
                console.log(`\n${COLORS.green}${COLORS.bright}📡 Hysteria2 (UDP):${COLORS.reset}`);
                hy2Links.forEach((link, index) => {
                    console.log(`  ${COLORS.cyan}${index + 1}.${COLORS.reset} ${COLORS.yellow}${link}${COLORS.reset}`);
                });
            }
            
            if (vlessWsLinks.length > 0) {
                console.log(`\n${COLORS.blue}${COLORS.bright}🔌 VLESS WebSocket (TCP):${COLORS.reset}`);
                vlessWsLinks.forEach((link, index) => {
                    console.log(`  ${COLORS.cyan}${index + 1}.${COLORS.reset} ${COLORS.yellow}${link}${COLORS.reset}`);
                });
            }
            
            console.log(`\n${COLORS.blue}${COLORS.bright}🔗 COMBINED BASE64 (All Protocols):${COLORS.reset}`);
            console.log(`  ${COLORS.white}${state.sboxBase64}${COLORS.reset}`);
        } else {
            console.log(`\n${COLORS.yellow}${COLORS.bright}⚠ LINKS: Not available${COLORS.reset}`);
        }
        
        Logger.divider();
        Logger.success("Services are running! Use the links above to connect.");

        // Auto-clear terminal after 3 minutes
        Logger.step(`Terminal will clear in 3 minutes...`);
        setTimeout(() => {
            process.stdout.write('\x1Bc');
            process.stdout.write('\x1B[2J\x1B[0f');
            console.log(`${COLORS.bright}${COLORS.green}Thank you for using this Xray-Sing!${COLORS.reset}\n`);
        }, 3 * 60 * 1000);
    }
}

// ========== ERROR HANDLING ==========
process.on('uncaughtException', (error) => {
    Logger.error(`Uncaught Exception: ${error.message}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    Logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    process.exit(1);
});

// ========== APPLICATION START ==========
Application.start().catch(error => {
    Logger.error(`Application failed to start: ${error.message}`);
    process.exit(1);
});
