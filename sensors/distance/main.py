import RPi.GPIO as GPIO
import time
from pythonosc import udp_client
import socket
import threading
import rtmidi
import sys

# ─── Network ───────────────────────────────────────────
"""
Notes about get_broadcast_address:
This is a trick. It doesn't actually connect to Google's DNS at 8.8.8.8 — SOCK_DGRAM is UDP which is connectionless, so connect() just tells the OS which network interface to use for that destination. 
The OS picks the right local IP address. Then getsockname() reads back what the OS chose. 
It's a way to ask "what's my IP address on the active network interface?" without knowing the interface name. 
The broadcast address is then constructed by replacing the last octet with 255.

Why broadcast? 
The Pi sends OSC to 192.168.x.255 which means every device on the subnet receives it, not just the router. This means any computer on the network could receive raw OSC directly if they had an OSC listener — not just the router.

SOCK_DGRAM is the socket type for UDP (datagrams) as opposed to SOCK_STREAM for TCP. UDP is fire-and-forget — no connection, no acknowledgment, just packets. OSC uses UDP because low latency matters more than guaranteed delivery for real-time sensor data.
"""

def get_broadcast_address():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        parts = ip.split('.')
        parts[3] = '255'
        return '.'.join(parts)
    except OSError:
        return '192.168.0.255'  # fallback


broadcast = get_broadcast_address()
print(f"Broadcasting to {broadcast}")
osc_client = udp_client.SimpleUDPClient(broadcast, 5005, allow_broadcast=True)
osc_local = udp_client.SimpleUDPClient('127.0.0.1', 5005)

# ─── GPIO Sensors ──────────────────────────────────────
# Each sensor is a dict: {trig, echo, name, min_cm, max_cm}
SENSORS = [
    {"trig": 17, "echo": 27, "name": "distance1", "min_cm": 5, "max_cm": 400},
    # Add more sensors here:
    # {"trig": 23, "echo": 24, "name": "distance2", "min_cm": 5, "max_cm": 60},
]

try:
    GPIO.setmode(GPIO.BCM)
except Exception as e:
    print("GPIO already in use - is theremin.service already running?")
    print("Run: sudo systemctl stop theremin")
    sys.exit(1)

for s in SENSORS:
    GPIO.setup(s["trig"], GPIO.OUT)
    GPIO.setup(s["echo"], GPIO.IN)
    GPIO.output(s["trig"], False)

# Toggle button to enable/disable sensors
TOGGLE_PIN = 22  # pick any free GPIO pin
GPIO.setup(TOGGLE_PIN, GPIO.IN, pull_up_down=GPIO.PUD_UP)

def read_sensor(s):
    GPIO.output(s["trig"], True)
    time.sleep(0.00001)
    GPIO.output(s["trig"], False)
    
    timeout = time.time() + 0.1
    start = time.time()
    while GPIO.input(s["echo"]) == 0:
        start = time.time()
        if time.time() > timeout:
            return None
    
    timeout = time.time() + 0.1
    end = time.time()
    while GPIO.input(s["echo"]) == 1:
        end = time.time()
        if time.time() > timeout:
            return None
    
    duration = end - start
    return round(duration * 17150, 2)

def normalize(val, min_cm, max_cm):
    return int(max(0, min(127, (val - min_cm) / (max_cm - min_cm) * 127)))

# ─── MIDI decoder for human-readable logs ──────────────
def decode_midi(data):
    if len(data) < 2:
        return str(list(data))
    status = data[0]
    msg_type = status & 0xF0
    channel = (status & 0x0F) + 1
    types = {
        0x80: "Note Off",
        0x90: "Note On",
        0xA0: "Poly Aftertouch",
        0xB0: "CC",
        0xC0: "Program Change",
        0xD0: "Aftertouch",
        0xE0: "Pitch Bend"
    }
    type_name = types.get(msg_type, f"Unknown({hex(msg_type)})")
    if msg_type == 0xB0:
        return f"Ch{channel} {type_name}{data[1]} value={data[2]}"
    elif msg_type in (0x80, 0x90):
        return f"Ch{channel} {type_name} note={data[1]} velocity={data[2]}"
    elif msg_type == 0xE0:
        pb = (data[2] << 7) | data[1]
        return f"Ch{channel} {type_name} value={pb}"
    else:
        return f"Ch{channel} {type_name} {list(data[1:])}"

# ─── MIDI Forwarding ───────────────────────────────────
# This is for any MIDI controllers connected to the Pi's USB ports
def forward_midi_input(port_index, port_name):
    min_input = rtmidi.MidiIn()
    min_input.open_port(port_index)
    print(f"Forwarding MIDI from: {port_name}")
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)

    def callback(message, data):
        try:
            msg_bytes, _ = message
            device = port_name.split(':')[0].encode('utf-8')
            payload = device + b'|' + bytes(msg_bytes)
            # Send to localhost router instead of Mac
            sock.sendto(bytes(payload), ('127.0.0.1', 5006))
            decoded = decode_midi(list(msg_bytes))
            print(f"{port_name.split(':')[0]} → {decoded}")
        except Exception as e:
            print(f"Callback error: {e}")

    min_input.set_callback(callback)
    while True:
        time.sleep(1)

def start_midi_forwarding():
    temp = rtmidi.MidiIn()
    ports = temp.get_ports()
    print("MIDI inputs found:", ports)
    for i, name in enumerate(ports):
        if any(skip in name for skip in ['Through', 'PipeWire']):
            continue
        t = threading.Thread(target=forward_midi_input, args=(i, name), daemon=True)
        t.start()

# ─── Main ──────────────────────────────────────────────
start_midi_forwarding()

smoothed = {s["name"]: 64 for s in SENSORS}
prev = {s["name"]: 0 for s in SENSORS}

sensor_enabled = False
last_button = GPIO.HIGH

try:
    while True:
        # Check toggle button
        reading = GPIO.input(TOGGLE_PIN)

        if reading == GPIO.LOW and last_button == GPIO.HIGH:
            sensor_enabled = not sensor_enabled
            print(f"Sensor {'enabled' if sensor_enabled else 'disabled'}")
        last_button = reading
        
        if sensor_enabled:
            for s in SENSORS:
                dist = read_sensor(s)
                if dist is not None:
                    dist = max(s["min_cm"], min(s["max_cm"], dist))
                    cc = normalize(dist, s["min_cm"], s["max_cm"])
                    cc = int(0.3 * cc + 0.7 * smoothed[s["name"]])
                    smoothed[s["name"]] = cc
                    
                    rate = int(min(abs(dist - prev[s["name"]]) * 10, 127))
                    prev[s["name"]] = dist
                    
                    osc_client.send_message(f"/sensor/{s['name']}/distance", dist)
                    osc_local.send_message(f"/sensor/{s['name']}/distance", dist)
                    osc_client.send_message(f"/sensor/{s['name']}/rate", rate)
                    osc_local.send_message(f"/sensor/{s['name']}/rate", rate)
                    print(f"{s['name']}: {dist:.1f}cm → value: {dist} rate: {rate}")
        
        time.sleep(0.05)

except KeyboardInterrupt:
    GPIO.cleanup()