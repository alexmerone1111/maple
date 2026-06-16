# MAPLE
An Android Termux Node.js-based tool with a simple dashboard for Roblox account botting, monitoring, and management.

Requires root & ADB access. The Web UI & HF-Space dashboard deployment for this specific version uses [VMOS Cloud](https://www.vmoscloud.com/) as the Android cloud device provider. Any Android executor of choice can be used as long as they support autoexecution & communication with localhost through HTTP requests.

[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/Node.js-18.x-green?logo=node.js&style=for-the-badge)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.9+-yellow?logo=python&logoColor=white&style=for-the-badge)](https://www.python.org/)

![dashboard](https://github.com/alexmerone1111/MAPLE/raw/main/dashboard/ui.png?raw=true)

## DEPLOYMENT & SETUP

### Required Prerequisites:
For optimal stability on Android cloud environments, manually install these specific APK versions:
- **Magisk:** [Official GitHub Releases](https://github.com/topjohnwu/Magisk/releases) - Required to grant and manage root/SuperUser permissions for Termux and the backend scripts.
- **Termux:** [v0.118.0 (GitHub Release)](https://github.com/termux/termux-app/releases/tag/v0.118.0) or [Latest Version](https://github.com/termux/termux-app/releases) - Do not use the Google Play version; it is deprecated and will fail to install packages.
- **Cloudflare WARP (1.1.1.1):** [Official APK](https://1.1.1.1/) | [Softonic](https://1-1-1-1.en.softonic.com/android) - Recommended for avoiding IP bans, captchas, and ensuring a stable connection.
- **ES File Explorer:** [Download via Softonic](https://es-file-explorer.en.softonic.com/android) - Recommended for visually managing and navigating files on the device (ensure your file manager supports root access).

### Termux Installation:
BEFORE YOU PROCEED, MAKE SURE YOUR DEVICE IS ROOTED!
- You will need to grant root permissions (superuser) to Termux to run the backend script. If you do not have root access, you will need to root your device before proceeding. For more information on how to root your device, please refer to documentation provided by your cloud provider. 

To install dependencies, clone the repository, and start the server, open **Termux** on your cloud device and paste the following setup command:

```bash
sed -i 's@https://[^/ ]*/\(termux/\|\)apt@https://packages.termux.dev/apt@g' $PREFIX/etc/apt/sources.list $PREFIX/etc/apt/sources.list.d/*.list 2>/dev/null; pkg update -y -o Dpkg::Options::="--force-confold" && pkg install -y -o Dpkg::Options::="--force-confold" git nodejs root-repo && rm -rf MAPLE && git clone https://github.com/alexmerone1111/MAPLE.git && cd MAPLE && npm install && (killall node 2>/dev/null || true) && npm start
```

If you ever need to manually restart the backend on your cloud device:
```bash
cd ~/MAPLE && (killall node 2>/dev/null || true) && npm start
```

## Accessing the Dashboard:

You can access the Maple Dashboard remotely using either:
1. **Hugging Face Docker Space:** (Recommended) Deploy the contents of the `hf-docker` folder to a private HF Space. You can then access the dashboard directly at `https://HF_USERNAME-SPACE_NAME.hf.space/`.
2. **Local Python Tunnel:** Run `tunnel.py` on your local computer to bind the cloud server to port `3000`. Once active, visit `http://localhost:3000` in your browser.

## Configuration:

The system uses a `config.json` file to manage its automation loop.

| Parameter | Description | Default |
| --- | --- | --- |
| `PLACE_ID` | The target Roblox game Place ID to launch. | *Required* |
| `JOB_ID` | (Optional) The specific Server ID / Job ID to join. | `null` |
| `HEALTHCHECK_INTERVAL_MS`| Maximum time without a heartbeat before forcibly restarting the app. | `300000` |
| `MAX_RETRIES` | Maximum restart attempts for a crashing account before it is skipped. | `3` |
| `STREAM_REFRESH_MS` | Delay between screen captures for the cloud stream. | `50` |

## Lua API Integration:

Your Roblox executor script must communicate with the Maple backend via HTTP requests to `http://127.0.0.1:3000`. Below are the endpoint documentation and code examples. See `example.lua` for a pre-made, ready-to-use executor script.

### 1. Healthcheck (`/api/healthcheck`)
Send a POST request periodically to prevent the backend from assuming the game has crashed.

**cURL:**
```bash
curl -X POST http://127.0.0.1:3000/api/healthcheck
```

**Lua:**
```lua
task.spawn(function()
    while true do
        pcall(function()
            request({
                Url = "http://127.0.0.1:3000/api/healthcheck",
                Method = "POST"
            })
        end)
        task.wait(30)
    end
end)
```

### 2. Cycle Account (`/api/cycle`)
Trigger this endpoint when the script finishes its primary task and is ready to load the next account.

**cURL:**
```bash
curl -X POST http://127.0.0.1:3000/api/cycle \
  -H "Content-Type: application/json" \
  -d '{"reason": "Task Complete"}'
```

**Lua:**
```lua
local function cycleAccount(reason)
    pcall(function()
        request({
            Url = "http://127.0.0.1:3000/api/cycle",
            Method = "POST",
            Headers = { ["Content-Type"] = "application/json" },
            Body = game:GetService("HttpService"):JSONEncode({ reason = reason or "Task Complete" })
        })
    end)
end
```

### 3. Relaunch Account (`/api/relaunch`)
Trigger this endpoint to restart the current Roblox instance without cycling to the next account (useful for dodging server kicks or soft-locking).

**cURL:**
```bash
curl -X POST http://127.0.0.1:3000/api/relaunch
```

**Lua:**
```lua
pcall(function()
    request({
        Url = "http://127.0.0.1:3000/api/relaunch",
        Method = "POST"
    })
end)
```

### 4. Start Automation (`/api/start`)
Initiates the automation loop. This is usually triggered directly from the Web Dashboard, but can be done via Lua if needed.

**cURL:**
```bash
curl -X POST http://127.0.0.1:3000/api/start
```

**Lua:**
```lua
pcall(function()
    request({
        Url = "http://127.0.0.1:3000/api/start",
        Method = "POST"
    })
end)
```

### 4. Kill Automation (`/api/kill`)
Forcefully stops the entire automation process and halts the current game.

**cURL:**
```bash
curl -X POST http://127.0.0.1:3000/api/kill
```

**Lua:**
```lua
pcall(function()
    request({
        Url = "http://127.0.0.1:3000/api/kill",
        Method = "POST"
    })
end)
```
