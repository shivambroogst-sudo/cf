const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const token = process.env.CLOUDFLARE_TOKEN;
if (!token) {
  console.error("❌ Missing CLOUDFLARE_TOKEN in .env file");
  console.error("Add: CLOUDFLARE_TOKEN=your_cloudflare_tunnel_token");
  process.exit(1);
}

const platformMap = {
  linux: "linux",
  darwin: "darwin",
  win32: "windows"
};

const archMap = {
  x64: "amd64",
  arm64: "arm64"
};

const platform = platformMap[os.platform()] || "linux";
const arch = archMap[os.arch()] || "amd64";

const binaryName = `cloudflared-${platform}-${arch}${
  platform === "windows" ? ".exe" : ""
}`;

const binaryPath = path.join(__dirname, binaryName);

const downloadUrls = {
  "linux-amd64":
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
  "linux-arm64":
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64",
  "darwin-amd64":
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64",
  "darwin-arm64":
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64",
  "windows-amd64":
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
};

const downloadUrl = downloadUrls[`${platform}-${arch}`];

if (!downloadUrl) {
  console.error(`❌ Unsupported platform: ${platform}-${arch}`);
  process.exit(1);
}

let activeTunnel = null;
let restartTimer = null;
let stopping = false;
let restartDelay = 5000;

async function downloadBinary() {
  if (fs.existsSync(binaryPath)) {
    console.log(`✔️ cloudflared binary found: ${binaryPath}`);
    return binaryPath;
  }

  if (typeof fetch !== "function") {
    throw new Error("This script requires Node.js 18 or newer.");
  }

  console.log("⬇️ Downloading cloudflared binary...");

  const response = await fetch(downloadUrl, {
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `cloudflared download failed: HTTP ${response.status}`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  fs.writeFileSync(binaryPath, buffer, { mode: 0o755 });

  try {
    fs.chmodSync(binaryPath, 0o755);
  } catch (_) {}

  console.log("✔️ cloudflared download complete");

  return binaryPath;
}

function scheduleRestart() {
  if (stopping || restartTimer) return;

  console.log(
    `🔄 Restarting Cloudflare Tunnel in ${restartDelay / 1000} seconds...`
  );

  restartTimer = setTimeout(async () => {
    restartTimer = null;

    try {
      await startTunnel();
    } catch (err) {
      console.error("❌ Restart error:", err.message);
      scheduleRestart();
    }
  }, restartDelay);
}

async function startTunnel() {
  if (stopping || activeTunnel) return;

  const bin = await downloadBinary();

  if (stopping) return;

  console.log("🚀 Starting Cloudflare Tunnel using HTTP/2...");
  console.log(
    "ℹ️ Outbound TCP connectivity to Cloudflare port 7844 is required."
  );

  activeTunnel = spawn(
    bin,
    ["tunnel", "--protocol", "http2", "run", "--token", token],
    {
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  activeTunnel.stdout.on("data", (data) => {
    const msg = data.toString().trim();

    if (msg) console.log(msg);

    const match = msg.match(
      /https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/
    );

    if (match) {
      console.log(`🌍 Public URL: ${match[0]}`);
    }
  });

  activeTunnel.stderr.on("data", (data) => {
    const msg = data.toString().trim();

    if (msg) console.error("⚠️", msg);
  });

  activeTunnel.on("error", (err) => {
    console.error("❌ Failed to launch cloudflared:", err.message);
  });

  activeTunnel.on("close", (code, signal) => {
    activeTunnel = null;

    if (stopping) {
      process.exit(0);
      return;
    }

    console.error(
      `❌ Tunnel exited (code: ${code}, signal: ${signal || "none"})`
    );

    scheduleRestart();
  });
}

function shutdown(signal) {
  if (stopping) return;

  stopping = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  console.log(`\n🛑 ${signal}: stopping Cloudflare Tunnel...`);

  if (activeTunnel) {
    activeTunnel.kill();
  } else {
    process.exit(0);
  }
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

startTunnel().catch((err) => {
  console.error("❌ Startup error:", err.message);
  process.exitCode = 1;
});
