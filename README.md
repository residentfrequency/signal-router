# Resident Frequency — Pi Signal Router

A portable signal routing system for live art-tech performance. Runs on a Raspberry Pi and connects sensors, MIDI controllers, microphones, and generative visual sketches into a shared signal pool — accessible to anyone on the local network via browser.

Built by [Resident Frequency](https://residentfrequency.github.io), a Seattle-based art-tech-music collective.

Demo sites:
- Router: [https://rf.postoccupancy.com](https://rf.postoccupancy.com)
- Moire Pattern Generator: [https://rf.postoccupancy.com/moire](https://rf.postoccupancy.com/moire)
- Browser Mic: [https://rf.postoccupancy.com/mic](https://rf.postoccupancy.com/mic)

---

## What it does

The Pi acts as a hub. Every signal — environmental sensor readings, MIDI CC values from physical controllers, spectral audio analysis from microphones, derived values from generative visual sketches — enters the router as a WebSocket JSON message and is broadcast to all connected browsers. Each browser can receive signals as MIDI via the WebMIDI API, send MIDI back, or consume raw float values directly in JavaScript.

**Signal sources:**
- Physical sensors via GPIO (HC-SR04 ultrasonic distance, temperature, humidity)
- MIDI controllers via browser WebMIDI API (Teensy, Akai, any USB MIDI device)
- Virtual MIDI buses (IAC Driver on Mac, loopMIDI on Windows)
- Microphone audio analysis via Web Audio API (RMS, spectral bands, centroid)
- Generative visual sketches (moire interference metrics)
- OSC UDP from any device on the local network (port 5005)

**Signal destinations:**
- Any browser on the network receives all signals as WebSocket JSON
- Browsers output to local MIDI ports via WebMIDI API
- OSC UDP broadcast to registered clients on port 9000
- SuperCollider via OSC on localhost

**Access:**
- Ethernet switch: `https://10.0.0.1:3000`
- Local WiFi: `https://[pi-ip]:3000`
- Tailscale VPN: `https://adrian-pi.tailc1f637.ts.net:3000`
- Public (Cloudflare tunnel): `https://rf.postoccupancy.com`

---

## Hardware

- Raspberry Pi 3B (Pi 4/5 recommended for production)
- HC-SR04 ultrasonic distance sensor — GPIO 17 (trigger), 27 (echo)
- Toggle button — GPIO 22 (enables/disables distance sensor)
- TP-Link LS1008G 8-port Gigabit ethernet switch
- USB-C/USB-A ethernet adapter for Mac connection

---

## Project structure

```
signal-router/
  router/           Node.js WebSocket/OSC signal router
    server.js
    package.json
    public/
      index.html    Router UI
  theremin/         Python sensor script
    main.py
  moire/            Generative visual sketch
    index.html
  mic/              Microphone audio analysis
    index.html
  pi-setup/         Pi configuration reference
    systemd/
    scripts/
    config/
```

---

## Pi setup from scratch

### 1. Operating system

Install Raspberry Pi OS (full desktop) using Raspberry Pi Imager. Enable SSH during setup. Boot and update:

```bash
sudo apt update && sudo apt upgrade -y
```

### 2. Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

### 3. Python dependencies

```bash
sudo apt install python3-pip python3-gpiozero -y
pip3 install sensors/requirements.txt --break-system-packages

# Optional - for enabling MIDI controllers via Pi's USB port, these are required:
sudo apt install libasound2-dev -y
pip3 install -r controllers/requirements.txt --break-system-packages

```

### 4. Clone the repo

```bash
cd ~
git clone https://github.com/residentfrequency/signal-router.git
mv signal-router signal-router
cd signal-router/router
npm install
```

### 5. Environment variables

The router polls Supabase for ESP32 sensor data. Create a `.env` file in `router/`:

```bash
nano ~/signal-router/router/.env
```

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
```

### 6. SSL certificate

The router runs HTTPS. It first tries to use the Tailscale certificate, then falls back to a self-signed cert. Generate a self-signed cert for local use:

```bash
cd ~/signal-router/router
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/CN=adrian-pi" \
  -addext "subjectAltName=DNS:adrian-pi,DNS:adrian-pi.local,DNS:localhost,IP:127.0.0.1,IP:10.0.0.1,IP:192.168.4.1"
```

### 7. Systemd services

Copy service files from `pi-setup/systemd/` to `/etc/systemd/system/`:

```bash
sudo cp ~/signal-router/pi-setup/systemd/router.service /etc/systemd/system/
sudo cp ~/signal-router/pi-setup/systemd/theremin.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable router theremin
sudo systemctl start router theremin
```

**router.service** runs `node server.js` from `~/signal-router/router/`

**theremin.service** runs `python3 -u main.py` from `~/signal-router/theremin/`

Check status:
```bash
sudo systemctl status router
sudo systemctl status theremin
```

### 8. Shell scripts

Copy scripts to `/usr/local/bin/` and make executable:

```bash
sudo cp ~/signal-router/pi-setup/scripts/* /usr/local/bin/
sudo chmod +x /usr/local/bin/rf-status
sudo chmod +x /usr/local/bin/wifi-mode
sudo chmod +x /usr/local/bin/ap-mode
sudo chmod +x /usr/local/bin/router-log
sudo chmod +x /usr/local/bin/theremin-log
sudo chmod +x /usr/local/bin/kiosk
```

### 9. Ethernet DHCP

Configure `eth0` to serve DHCP to connected devices at `10.0.0.1`:

```bash
sudo nmcli con add \
  type ethernet \
  ifname eth0 \
  con-name "rf-ethernet" \
  ipv4.method shared \
  ipv4.addresses 10.0.0.1/24 \
  ipv4.never-default yes \
  connection.autoconnect yes
sudo nmcli con up "rf-ethernet"
```

Any device connected via ethernet (directly or through a switch) will receive an IP in the `10.0.0.x` range from the Pi's DHCP server and can access the router at `https://10.0.0.1:3000`.

**Mac ethernet setup** — set the ethernet adapter to a manual static IP so it connects immediately without waiting for DHCP:

System Settings → Network → ethernet adapter → Details → TCP/IP → Configure IPv4: Manually
- IP Address: `10.0.0.2`
- Subnet Mask: `255.255.255.0`
- Router: `10.0.0.1`

Then set service order so WiFi stays primary for internet traffic:
System Settings → Network → `⋯` → Set Service Order → drag WiFi above ethernet.

### 10. NetworkManager dispatcher

Ensures ethernet comes back up automatically when WiFi reconnects after a dropout:

```bash
sudo tee /etc/NetworkManager/dispatcher.d/98-eth0-reconnect << 'EOF'
#!/bin/bash
[ "$1" = "wlan0" ] && [ "$2" = "up" ] && nmcli con up "rf-ethernet" 2>/dev/null
exit 0
EOF
sudo chmod +x /etc/NetworkManager/dispatcher.d/98-eth0-reconnect
```

### 11. AP mode

Install hostapd for broadcasting the Pi as a WiFi access point:

```bash
sudo apt install hostapd -y
sudo systemctl unmask hostapd
```

Create `/etc/hostapd/hostapd.conf`:

```
interface=wlan0
driver=nl80211
ssid=ResidentFrequency
hw_mode=g
channel=7
wmm_enabled=0
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=theremin123
wpa_key_mgmt=WPA-PSK
wpa_pairwise=TKIP
rsn_pairwise=CCMP
```

### 12. Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Follow the authentication link. After setup the Pi is accessible at its Tailscale IP from any device on your Tailscale network.

```bash
tailscale ip    # shows the assigned IP
```

### 13. Cloudflare tunnel

Provides a stable public HTTPS URL — no port forwarding required.

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm \
  -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/

# Authenticate with Cloudflare account
cloudflared login

# Create a named tunnel
cloudflared tunnel create resident-frequency

# Create config file
sudo mkdir -p /etc/cloudflared
sudo nano /etc/cloudflared/config.yml
```

```yaml
tunnel: resident-frequency
credentials-file: /home/pi/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: rf.postoccupancy.com
    service: https://localhost:3000
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

```bash
# Route DNS
cloudflared tunnel route dns resident-frequency rf.postoccupancy.com

# Install as systemd service
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

**Change the subdomain:**
1. Update `/etc/cloudflared/config.yml` with new hostname
2. `cloudflared tunnel route dns resident-frequency newname.postoccupancy.com`
3. Delete old DNS record in Cloudflare dashboard
4. `sudo systemctl restart cloudflared`

**Disable during performance** (saves ~60MB RAM):
```bash
sudo systemctl stop cloudflared
sudo systemctl start cloudflared   # re-enable when needed
```

---

## Shell scripts

### `wifi-mode`

Connects the Pi to a WiFi network. If the network is new, adds it. If already saved, reconnects. Disconnects from current network first, rescans, then connects.

```bash
wifi-mode "VenueSSID"             # prompts for password if new network
wifi-mode "VenueSSID" "password"  # adds and connects in one step
wifi-mode                         # shows current SSID and visible networks
```

After connecting, automatically brings up `rf-ethernet` so the ethernet switch is available simultaneously.

### `ap-mode`

Switches `wlan0` to Access Point mode. The Pi broadcasts as `ResidentFrequency` (password: `theremin123`). Stops WiFi client mode. Useful when no venue WiFi is available — all devices connect to the Pi directly.

```bash
ap-mode
```

Connect to `ResidentFrequency` WiFi, then access router at `https://192.168.4.1:3000`.

To return to WiFi client mode, connect via ethernet and run `wifi-mode`.

### `rf-status`

Shows current state of all services, network interfaces, memory usage, and connection URLs.

```bash
rf-status
```

Example output:
```
=== Resident Frequency Status ===

✓ Sensor (theremin)
✓ Router
✓ Cloudflare tunnel

=== Network ===
WiFi: CLIENT — VenueSSID (192.168.1.42) — internet ✓
Ethernet: CABLE CONNECTED — 10.0.0.1 — 2 client(s)
Tailscale: 100.118.138.43

=== Connect at ===
Local aliases:
  https://adrian-pi.local:3000 (same local network)
  https://adrian-pi:3000  (Tailscale MagicDNS)
  https://adrian-pi.tailc1f637.ts.net:3000  (Tailscale full hostname)

By IP:
  Ethernet:  https://10.0.0.1:3000
  WiFi:      https://192.168.1.42:3000
  Tailscale: https://100.118.138.43:3000
  Public:    https://rf.postoccupancy.com

=== Memory ===
RAM: 248MB used / 921MB total (27% used)

=== Processes ===
✓ Router (node server.js) PID 825 — 51MB
✓ cloudflared PID 1823 — 22MB
✓ Sensor (main.py) PID 832 — 28MB
```

### `router-log`

Tails the router service log in real time. Useful for debugging signal flow.

```bash
router-log
```

Runs: `sudo journalctl -u router -f`

### `theremin-log`

Tails the sensor script log in real time.

```bash
theremin-log
```

Runs: `sudo journalctl -u theremin -f`

### `kiosk`

Opens Chromium in fullscreen on the Pi's desktop pointing to the router UI. Useful when the Pi is connected to a display.

```bash
kiosk              # opens https://localhost:3000
kiosk moire/       # opens https://localhost:3000/moire/
pkill chromium     # close
```

Autostart on boot is **disabled by default**. To enable:

```bash
mkdir -p ~/.config/autostart
nano ~/.config/autostart/chromium-kiosk.desktop
```

```ini
[Desktop Entry]
Type=Application
Name=Chromium Kiosk
Exec=/usr/local/bin/kiosk
X-GNOME-Autostart-enabled=true
```

---

## Mac workflow

### Deploy script

A `deploy` script on your Mac copies files from the local `signal-router/` folder to the Pi via SCP. It lives in `~/bin/deploy` (not `/usr/local/bin` — macOS SIP prevents writing there).

Setup:

```bash
mkdir -p ~/bin
nano ~/bin/deploy
chmod +x ~/bin/deploy
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Usage:

```bash
deploy                                # rsync all changed files in signal-router/
deploy router/public/moire5.html      # copy one file
deploy router/server.js               # copy server.js and restart router
```

Run from any subfolder — `deploy moire5.html` from inside `signal-router/moire/` resolves to the correct path automatically.

The deploy script uses `pi@adrian-pi` (Tailscale MagicDNS) as the default target — works whether connected via ethernet, WiFi, or remotely.

### VS Code Remote SSH

The VS Code Remote SSH extension is convenient for editing files on the Pi but **installs a Node.js server** that consumes ~400MB RAM on the Pi 3 — more than the router itself. Close the Remote SSH connection before a performance session. Use `deploy` from a local Terminal instead.

---

## Network architecture

```
Internet
    │
    └── Tailscale VPN ──────────────────── remote access
    └── Cloudflare Tunnel ───────────────── rf.postoccupancy.com → :3000

Venue WiFi router
    │
    └── wlan0 (192.168.x.x) ─────────────── Pi on venue network

Pi eth0 (10.0.0.1) ──── ethernet switch ─── Mac (10.0.0.2)
                                         └── other devices (10.0.0.x)

AP mode: wlan0 (192.168.4.1) ────────────── ResidentFrequency SSID
                                         └── clients (192.168.4.x)
```

Three connection modes:
- **Venue WiFi + ethernet switch** — Pi on venue WiFi for internet, ethernet switch for local low-latency connections
- **Ethernet only** — no WiFi, direct cable between Mac and Pi, Mac set to manual IP `10.0.0.2`
- **AP mode** — no venue WiFi, Pi broadcasts its own network, all devices connect to `ResidentFrequency`

---

## Signal format

All signals broadcast as WebSocket JSON. Three message types reflecting the origin format of the signal:

**osc** — physical sensor, originated as OSC UDP (distance sensor, Kinect, any OSC sender on port 5005):
```json
{
  "type": "osc",
  "device": "osc/pi-hc-sr04/distance-cm",
  "value": 142.3,
  "source": "127.0.0.1"
}
```

**json** — browser or HTTP origin, full float 0–1 (mic Web Audio analysis, moire derived signals, ESP32 via Supabase):
```json
{
  "type": "json",
  "device": "json/mic-192.168.0.5/rms",
  "value": 0.847,
  "source": "192.168.0.5"
}
```

**midi** — MIDI controller via browser WebMIDI API (IAC Driver, loopMIDI, USB controllers) or Pi USB via controllers/main.py:
```json
{
  "type": "midi",
  "device": "midi/Teensy MIDI",
  "msgType": "cc",
  "channel": 3,
  "cc": 1,
  "value": 64
}
```

The `device` field includes the type as a prefix — `osc/`, `json/`, or `midi/` — making the origin format visible in the router UI signal table.

### Receiving in Python

```python
import asyncio, websockets, json

async def listen():
    async with websockets.connect('wss://rf.postoccupancy.com') as ws:
        async for msg in ws:
            data = json.loads(msg)
            if data['type'] == 'osc':
                print(data['device'], data['value'])
            elif data['type'] == 'json':
                print(data['device'], data['value'])   # already 0-1
            elif data['type'] == 'midi':
                print(data['device'], data['value'] / 127)

asyncio.run(listen())
```

### Receiving in p5.js / browser JavaScript

```javascript
const ws = new WebSocket('wss://rf.postoccupancy.com');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'osc') {
    // data.value is raw sensor value e.g. 142.3cm
    // normalize using routing min/max
  }
  if (data.type === 'json') {
    // data.value is float 0-1 already
  }
  if (data.type === 'midi') {
    // data.value is 0-127, normalize: data.value / 127
  }
};
```

### Receiving as OSC

Every connected browser client automatically receives all signals as OSC UDP on port 9000. Open an OSC listener on port 9000 in TouchDesigner, VCV Rack, or Max for Live.

OSC address format mirrors the device field:
```
/osc/pi-hc-sr04/distance-cm   142.3  0.369
/json/mic-192_168_0_5/rms     0.847  0.847
/midi/Teensy_MIDI/ch3/cc1     0.504  64
```

osc and json messages carry raw value + normalized 0–1. midi CC messages carry normalized 0–1 + raw 0–127.

To send OSC to the router, send UDP to port 5005 (local network only — not available via Cloudflare tunnel, use Tailscale for remote OSC). Toggle SEND ON in the OSC ports table to register your IP as an allowed sender.

OSC address format for inbound:
```
/sensor/name/param value
e.g. /sensor/kinect/x 0.42
```

---

## Configuration files reference

| File | Purpose |
|------|---------|
| `/etc/systemd/system/router.service` | Router autostart |
| `/etc/systemd/system/theremin.service` | Sensor script autostart |
| `/etc/cloudflared/config.yml` | Cloudflare tunnel config |
| `/etc/hostapd/hostapd.conf` | AP mode SSID and password |
| `/etc/NetworkManager/dispatcher.d/98-eth0-reconnect` | Auto-reconnect ethernet on WiFi up |
| `~/signal-router/router/.env` | Supabase credentials (not in repo) |
| `~/signal-router/router/routing.json` | Signal routing config (not in repo) |
| `~/.cloudflared/cert.pem` | Cloudflare auth certificate |
| `/usr/local/bin/rf-status` | Status script |
| `/usr/local/bin/wifi-mode` | WiFi management script |
| `/usr/local/bin/ap-mode` | AP mode script |
| `~/.config/autostart/chromium-kiosk.desktop` | Kiosk autostart (disabled by default) |

---

## Performance checklist

Before a session:

1. Close VS Code Remote SSH on Mac
2. `ssh pi@adrian-pi`
3. `rf-status` — verify services and network
4. `wifi-mode "VenueSSID" "password"` if new venue
5. `sudo systemctl stop cloudflared` — optional, saves RAM
6. Plug in ethernet cable, verify Mac shows `10.0.0.x` address
7. Open `https://10.0.0.1:3000` in Chrome
8. Allow MIDI access when Chrome asks

After a session:

```bash
sudo systemctl start cloudflared   # re-enable if stopped
```

---

## Troubleshooting

**Router not responding at :3000 but SSH works**
```bash
sudo systemctl status router
sudo journalctl -u router -n 20
```
Common cause: working directory not found after file reorganization. Check `WorkingDirectory` in `/etc/systemd/system/router.service`.

**Ethernet not connecting**
Check carrier (physical cable) vs IP:
```bash
cat /sys/class/net/eth0/carrier   # 1 = cable present, 0 = no cable
ip addr show eth0
```
If carrier is 1 but no DHCP lease on Mac: set Mac ethernet IP manually to `10.0.0.2`.

**WiFi connected but wrong network after moving locations**
NetworkManager reconnects to last known network. Force reconnect:
```bash
sudo nmcli dev disconnect wlan0
wifi-mode "NewVenueSSID" "password"
```

**Pi running slow / freezing**
Check memory and processes:
```bash
rf-status
ps aux | grep node
```
VS Code Remote SSH is the most common cause — kills it with `pkill -9 -f vscode-server`.

**Distance sensor showing dashes in router**
OSC packets from `main.py` use subnet broadcast which doesn't loop back on Linux. Check `main.py` sends to both broadcast and `127.0.0.1`. Verify OSC inbound whitelist in server.js includes broadcast addresses.

**`wifi-mode` reports success but SSID unchanged**
Network not in scan range. Run `sudo nmcli dev wifi rescan` then retry. Check signal strength with `sudo nmcli dev wifi list`.