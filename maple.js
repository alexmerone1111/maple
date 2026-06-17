const express = require('express');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const config = require('./config.json');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const url = require('url');

const terminalSessions = {};

const app = express();
app.use(express.json());
app.use(express.static('dashboard', { index: 'ui.html' }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let isStreaming = false;
let isConnecting = false;

const logHistory = [];
const MAX_HISTORY = 200;

function broadcastToLiveTerminal(chunk) {
    const str = chunk.toString();
    logHistory.push(str);
    if (logHistory.length > MAX_HISTORY) logHistory.shift();
    
    wss.clients.forEach(client => {
        if (client.isLiveTerminal && client.readyState === WebSocket.OPEN) {
            client.send(str);
        }
    });
}

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = (chunk, encoding, callback) => {
    broadcastToLiveTerminal(chunk);
    return originalStdoutWrite(chunk, encoding, callback);
};

process.stderr.write = (chunk, encoding, callback) => {
    broadcastToLiveTerminal(chunk);
    return originalStderrWrite(chunk, encoding, callback);
};

['log', 'info', 'warn', 'error'].forEach((method) => {
    const orig = console[method];
    console[method] = function(...args) {
        orig(`[${new Date().toLocaleString()}]`, ...args);
    };
});

wss.on('connection', (ws, req) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    
    if (reqUrl.pathname === '/terminal/live') {
        ws.isTerminal = true;
        ws.isLiveTerminal = true;
        logHistory.forEach(msg => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(msg);
            }
        });
        return;
    }
    
    if (reqUrl.pathname === '/terminal') {
        const id = reqUrl.searchParams.get('id');
        ws.isTerminal = true;
        ws.terminalId = id;
        const ptyProcess = terminalSessions[id];
        
        if (!ptyProcess) {
            ws.close();
            return;
        }

        const onData = (data) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(data);
            }
        };
        ptyProcess.on('data', onData);

        ws.on('message', (msg) => {
            if (ptyProcess && !ptyProcess.killed) {
                try {
                    ptyProcess.write(msg.toString());
                } catch (e) {
                    console.error('Error writing to pty:', e);
                }
            }
        });

        ws.on('close', () => {
            ptyProcess.removeListener('data', onData);
        });

        return;
    }

    console.log('Client connected to cloud device stream');

    if (!isStreaming) {
        isStreaming = true;
        const sendFrame = () => {
            if (!isStreaming) return;
            const refreshRate = config.STREAM_REFRESH_MS || 50;
            execFile('su', ['-c', 'screencap -p'], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 10, timeout: 3000 }, (err, stdout) => {
                if (err) {
                    console.error("screencap error:", err);
                    if (isStreaming) setTimeout(sendFrame, refreshRate * 2);
                } else if (stdout && stdout.length > 0) {
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && !client.isTerminal) {
                            client.send(stdout);
                        }
                    });
                    if (isStreaming) setTimeout(sendFrame, refreshRate);
                } else {
                    if (isStreaming) setTimeout(sendFrame, refreshRate);
                }
            });
        };
        sendFrame();
    }

    ws.on('close', () => {
        console.log('Client disconnected from the cloud device stream.');
        const hasStreamClients = Array.from(wss.clients).some(c => !c.isTerminal);
        if (!hasStreamClients) {
            console.log('No more Roblox app clients open. Stopping cloud device stream...');
            isStreaming = false;
        }
    });
});

app.post('/api/terminal/spawn', (req, res) => {
    const { type } = req.body;
    const id = Date.now().toString();
    const command = type === 'root' ? 'su' : 'bash';
    const args = type === 'root' ? ['-'] : [];
    
    try {
        const ptyProcess = pty.spawn(command, args, {
            name: 'xterm-color',
            cols: 80,
            rows: 24,
            cwd: process.env.HOME || '/data/data/com.termux/files/home',
            env: process.env
        });

        ptyProcess.on('exit', () => {
            delete terminalSessions[id];
            wss.clients.forEach(client => {
                if (client.isTerminal && client.terminalId === id) {
                    client.close();
                }
            });
        });

        terminalSessions[id] = ptyProcess;
        res.json({ id });
    } catch (e) {
        console.error('Failed to spawn terminal:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/terminals', (req, res) => {
    res.json({ sessions: Object.keys(terminalSessions) });
});

app.post('/api/terminal/kill', (req, res) => {
    const { id } = req.body;
    if (terminalSessions[id]) {
        try {
            terminalSessions[id].kill();
        } catch (error) {
            console.error(`Error killing terminal ${id}:`, error.message);
        }
        delete terminalSessions[id];
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

let accounts = [];
let currentAccountIndex = 0;
let retryCount = 0;
let isRunning = false;
let isLoginMode = false;
let isManualLaunch = false;
let heartbeatTimer = null;

function executeShell(command, timeoutMs = 30000) {
    return new Promise((resolve) => {
        exec(command, { timeout: timeoutMs }, (err, stdout, stderr) => {
            if (err) {
                console.error(`Error executing: ${command}\n`, stderr);
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
}



executeShell('su -c "mkdir -p /sdcard/roblox_accounts"');

function loadAccounts() {
    try {
        if (fs.existsSync('accounts.json')) {
            const data = fs.readFileSync('accounts.json', 'utf8');
            accounts = JSON.parse(data);
            accounts = accounts.map(account => ({ username: account.username }));
            console.log(`Loaded ${accounts.length} accounts from accounts.json.`);
        } else {
            console.log('No accounts.json found, starting with empty vault database.');
            accounts = [];
        }
    } catch (err) {
        console.error('Failed to read accounts.json:', err);
        accounts = [];
    }
}

loadAccounts();

async function killRoblox() {
    console.log('Force stopping the Roblox client...');
    await executeShell('su -c "am force-stop com.roblox.client"');
}

async function injectAndLaunch() {
    if (currentAccountIndex >= accounts.length) {
        console.log('Out of valid accounts! Stopping automation.');
        stopAutomation();
        return;
    }

    const account = accounts[currentAccountIndex];
    const username = account.username;
    console.log(`[Index ${currentAccountIndex}] Restoring account: ${username} (Retry ${retryCount}/${config.MAX_RETRIES})`);

    await killRoblox();
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!isRunning) return;

    console.log(`Wiping the current Roblox app client data...`);
    if (!(await executeShell('su -c "pm clear com.roblox.client"'))) return handleCrash();
    if (!isRunning) return;
    
    console.log(`Restoring /sdcard/roblox_accounts/${username}.tar.gz...`);
    if (!(await executeShell(`su -c "tar -xzf /sdcard/roblox_accounts/${username}.tar.gz -C /data/data/com.roblox.client"`))) return handleCrash();
    if (!isRunning) return;
    
    if (!(await executeShell('su -c "UID=\\$(stat -c %u /data/data/com.roblox.client); chown -R \\$UID:\\$UID /data/data/com.roblox.client"'))) return handleCrash();
    if (!isRunning) return;

    let launchIntent = `roblox://placeId=${config.PLACE_ID}`;
    if (config.JOB_ID && config.JOB_ID.trim() !== '') {
        launchIntent += `&gameInstanceId=${config.JOB_ID.trim()}`;
    }
    console.log(`Launching Roblox app into the following intent: ${launchIntent}...`);
    if (!(await executeShell(`su -c "am start -a android.intent.action.VIEW -d '${launchIntent}'"`))) return handleCrash();

    startHeartbeatTimer();
}

function startHeartbeatTimer() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);

    heartbeatTimer = setTimeout(() => {
        console.log(`Heartbeat timed out after ${config.HEALTHCHECK_INTERVAL_MS}ms!`);
        handleCrash();
    }, config.HEALTHCHECK_INTERVAL_MS);
}

async function checkForegroundStatus() {
    return new Promise((resolve) => {
        exec('su -c "pidof com.roblox.client"', { timeout: 5000 }, (err, stdout) => {
            const processId = stdout ? stdout.trim() : "";
            if (!processId) return resolve(false);

            exec(`su -c "cat /proc/${processId}/oom_score_adj"`, { timeout: 5000 }, (err, stdout) => {
                const oomScore = parseInt(stdout ? stdout.trim() : "1000", 10);
                resolve(!isNaN(oomScore) && oomScore < 300);
            });
        });
    });
}

async function handleCrash() {
    if (!isRunning) return;

    const isForeground = await checkForegroundStatus();

    if (isForeground) {
        retryCount++;
        console.log(`Heartbeat timeout. Account stuck on screen. Retry ${retryCount}/${config.MAX_RETRIES}.`);
    } else {
        console.log(`Heartbeat timeout. App crashed or minimized. Relaunching without penalty. Retry ${retryCount}/${config.MAX_RETRIES}.`);
    }

    isConnecting = true;
    if (retryCount > config.MAX_RETRIES) {
        console.log(`Max retries reached for index ${currentAccountIndex}. Account marked invalid.`);
        accounts[currentAccountIndex].invalid = true;
        setTimeout(cycleAccount, 0);
    } else {
        setTimeout(injectAndLaunch, 0);
    }
}

function cycleAccount() {
    currentAccountIndex++;
    retryCount = 0;
    injectAndLaunch();
}

function stopAutomation() {
    isRunning = false;
    isLoginMode = false;
    isManualLaunch = false;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    exec('su -c "pkill -f sendevent"');
    killRoblox();
    console.log('Automation completely stopped.');
}

app.post('/api/nav/back', (req, res) => {
    exec('su -c "input keyevent 4"');
    res.json({ success: true });
});

app.post('/api/nav/home', (req, res) => {
    exec('su -c "input keyevent 3"');
    res.json({ success: true });
});

app.post('/api/nav/recents', (req, res) => {
    exec('su -c "input keyevent 187"');
    res.json({ success: true });
});

let screenWidth = 720;
let screenHeight = 1280;
exec('su -c "wm size"', (err, stdout) => {
    if (stdout) {
        const match = stdout.match(/Physical size: (\d+)x(\d+)/);
        if (match) {
            screenWidth = parseInt(match[1]);
            screenHeight = parseInt(match[2]);
            console.log(`Detected screen resolution: ${screenWidth}x${screenHeight}`);
        }
    }
});

app.post('/api/touch', (req, res) => {
    const { x, y } = req.body;
    const absoluteX = Math.round(x * screenWidth);
    const absoluteY = Math.round(y * screenHeight);
    execFile('su', ['-c', `input tap ${absoluteX} ${absoluteY}`]);
    res.json({ success: true });
});

app.post('/api/swipe', (req, res) => {
    const { startX, startY, endX, endY, duration } = req.body;
    const absoluteX1 = Math.round(startX * screenWidth);
    const absoluteY1 = Math.round(startY * screenHeight);
    const absoluteX2 = Math.round(endX * screenWidth);
    const absoluteY2 = Math.round(endY * screenHeight);
    execFile('su', ['-c', `input swipe ${absoluteX1} ${absoluteY1} ${absoluteX2} ${absoluteY2} ${duration || 300}`]);
    res.json({ success: true });
});

app.post('/api/text', (req, res) => {
    let text = req.body.text || "";
    text = text.replace(/ /g, '%s');
    text = text.replace(/'/g, "'\\''");
    execFile('su', ['-c', `input text '${text}'`]);
    res.json({ success: true });
});

app.post('/api/key', (req, res) => {
    const { keycode } = req.body;
    exec(`su -c "input keyevent ${keycode}"`);
    res.json({ success: true });
});

app.post('/api/login_mode', async (req, res) => {
    isLoginMode = true;
    isRunning = false;
    isConnecting = false;
    await executeShell('su -c "am force-stop com.roblox.client"');
    await executeShell('su -c "pm clear com.roblox.client"');
    await executeShell('su -c "monkey -p com.roblox.client -c android.intent.category.LAUNCHER 1"');
    res.json({ message: 'Login mode activated. Opening the native Roblox app client...' });
});

app.post('/api/save_account', (req, res) => {
    if (!isLoginMode) return res.status(400).json({ error: 'Not in login mode.' });

    console.log(`Extracting username from native Roblox app prefs...`);
    exec('su -c "cat /data/data/com.roblox.client/shared_prefs/prefs.xml"', async (err, stdout) => {
        const match = stdout ? stdout.match(/<string name="username">([^<]+)<.string>/) : null;
        const username = match ? match[1].trim() : null;

        if (!username) {
            console.error('Failed to read Roblox username from prefs.xml:', err || 'Empty stdout');
            return res.status(400).json({ error: 'No valid account found! Did you log in on the native Roblox app?' });
        }

        const exists = accounts.find(account => account.username === username);
        if (!exists) {
            accounts.push({ username });
            fs.writeFileSync('accounts.json', JSON.stringify(accounts, null, 2));
        }

        console.log(`Backing up account data for ${username}...`);
        await executeShell(`su -c "tar --exclude='cache' --exclude='code_cache' --exclude='no_backup' -czf /sdcard/roblox_accounts/${username}.tar.gz -C /data/data/com.roblox.client ."`);
        console.log(`Saved new account: ${username}`);

        stopAutomation();
        res.json({ message: 'Account saved!', username });
    });
});

app.post('/api/start', async (req, res) => {
    if (isRunning) return res.json({ message: 'Already running.' });

    if (!config.PLACE_ID || config.PLACE_ID.trim() === '') {
        return res.status(400).json({ error: 'A Place ID is required before starting!' });
    }

    if (accounts.length === 0) {
        return res.status(400).json({ error: 'No accounts loaded.' });
    }

    isRunning = true;
    isLoginMode = false;
    isManualLaunch = false;
    isConnecting = true;
    currentAccountIndex = 0;
    retryCount = 0;
    
    accounts.forEach(account => account.invalid = false);
    
    injectAndLaunch();
    res.json({ message: 'Started automation.' });
});

app.post('/api/healthcheck', (req, res) => {
    if (!isRunning) return res.json({ message: 'Not running.' });

    console.log('Heartbeat received!');
    retryCount = 0;
    isConnecting = false;

    startHeartbeatTimer();
    res.json({ message: 'Heartbeat acknowledged.' });
});

app.post('/api/cycle', (req, res) => {
    if (!isRunning) return res.json({ message: 'Not running.' });

    const reason = req.body.reason || 'Unknown';
    console.log('Received cycle account request. Reason: ' + reason);

    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    cycleAccount();

    res.json({ message: 'Cycling to next account.' });
});

app.post('/api/relaunch', (req, res) => {
    if (!isRunning) return res.json({ message: 'Not running.' });

    console.log('Received relaunch request. Relaunching the current account...');
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    
    retryCount = 0; 
    injectAndLaunch();

    res.json({ message: 'Relaunching the current account.' });
});

app.post('/api/launch', async (req, res) => {
    if (!config.PLACE_ID || config.PLACE_ID.trim() === '') {
        return res.status(400).json({ error: 'A Place ID is required before launching!' });
    }

    const { username } = req.body;
    const index = accounts.findIndex(account => account.username === username);
    if (index === -1) return res.status(404).json({ error: 'Account not found.' });

    isRunning = true;
    isLoginMode = false;
    isManualLaunch = true;
    isConnecting = true;
    currentAccountIndex = index;
    retryCount = 0;
    accounts[index].invalid = false;

    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    injectAndLaunch();

    res.json({ message: `Launched ${username}` });
});

app.post('/api/drop', (req, res) => {
    const { username } = req.body;
    const index = accounts.findIndex(account => account.username === username);
    if (index === -1) return res.status(404).json({ error: 'Account not found.' });

    if (isRunning && index === currentAccountIndex) {
        stopAutomation();
    } else if (isRunning && index < currentAccountIndex) {
        currentAccountIndex--;
    }

    accounts.splice(index, 1);
    fs.writeFileSync('accounts.json', JSON.stringify(accounts, null, 2));
    
    executeShell(`su -c "rm -f /sdcard/roblox_accounts/${username}.tar.gz"`);

    res.json({ message: `Dropped ${username}` });
});

app.post('/api/kill', (req, res) => {
    stopAutomation();
    res.json({ message: 'Automation killed.' });
});

app.post('/api/set_target', (req, res) => {
    const { type, value } = req.body;
    if (type === 'place') {
        config.PLACE_ID = value;
    } else if (type === 'job') {
        config.JOB_ID = value;
    }
    fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
    res.json({ success: true });
});

app.get('/api/status', (req, res) => {
    res.json({
        isRunning,
        isLoginMode,
        isManualLaunch,
        isConnecting,
        currentAccount: isRunning ? accounts[currentAccountIndex]?.username : null,
        currentRetry: retryCount,
        maxRetries: config.MAX_RETRIES,
        placeId: config.PLACE_ID || '',
        jobId: config.JOB_ID || '',
        accounts: accounts.map((account, index) => ({
            username: account.username,
            isActive: isRunning && (index === currentAccountIndex),
            isFailed: isRunning && account.invalid === true,
            isManualLaunch: isRunning && (index === currentAccountIndex) && isManualLaunch
        }))
    });
});

server.listen(config.PORT, '127.0.0.1', () => {
    console.log(`MAPLE listening on http://127.0.0.1:${config.PORT}`);
    console.log('Dashboard ready at http://127.0.0.1:3000');
});
