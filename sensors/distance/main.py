import RPi.GPIO as GPIO
import time
from pythonosc import udp_client
import socket
import sys

# ─── Network ───────────────────────────────────────────
"""
OSC broadcast explanation:
Does not actually connect to 8.8.8.8 — SOCK_DGRAM is UDP/connectionless,
so connect() just tells the OS which network interface to use.
getsockname() reads back the local IP the OS chose.
Broadcast address replaces last octet with 255 so all subnet devices
can receive raw OSC directly with any OSC listener on port 5005.
Also sends to 127.0.0.1 (loopback) so the router on the same Pi receives it —
broadcast packets do not loop back to local listeners on Linux.
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
        return '192.168.0.255'

broadcast = get_broadcast_address()
print(f"Broadcasting OSC to {broadcast}:5005 and 127.0.0.1:5005")
osc_client = udp_client.SimpleUDPClient(broadcast, 5005, allow_broadcast=True)
osc_local  = udp_client.SimpleUDPClient('127.0.0.1', 5005)

# ─── GPIO Sensors ──────────────────────────────────────
# Each sensor: {trig, echo, name, min_cm, max_cm}
SENSORS = [
    {"trig": 17, "echo": 27, "name": "pi-hc-sr04", "min_cm": 5, "max_cm": 400},
    # {"trig": 23, "echo": 24, "name": "pi-hc-sr04-2", "min_cm": 5, "max_cm": 60},
]

try:
    GPIO.setmode(GPIO.BCM)
except Exception as e:
    print("GPIO already in use — is distance.service already running?")
    print("Run: sudo systemctl stop distance")
    sys.exit(1)

for s in SENSORS:
    GPIO.setup(s["trig"], GPIO.OUT)
    GPIO.setup(s["echo"], GPIO.IN)
    GPIO.output(s["trig"], False)

# Toggle button — enables/disables sensor output
TOGGLE_PIN = 22
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

    return round((end - start) * 17150, 2)

# ─── Main ──────────────────────────────────────────────
smoothed = {s["name"]: 64 for s in SENSORS}
prev     = {s["name"]: 0  for s in SENSORS}

sensor_enabled = False
last_button    = GPIO.HIGH

print("Distance sensor ready. Press toggle button to enable.")

try:
    while True:
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
                    cc   = int(max(0, min(127, (dist - s["min_cm"]) / (s["max_cm"] - s["min_cm"]) * 127)))
                    cc   = int(0.3 * cc + 0.7 * smoothed[s["name"]])
                    smoothed[s["name"]] = cc

                    rate = int(min(abs(dist - prev[s["name"]]) * 10, 127))
                    prev[s["name"]] = dist

                    osc_client.send_message(f"/sensor/{s['name']}/distance-cm", float(dist))
                    osc_local.send_message( f"/sensor/{s['name']}/distance-cm", float(dist))
                    osc_client.send_message(f"/sensor/{s['name']}/change-rate",  float(rate))
                    osc_local.send_message( f"/sensor/{s['name']}/change-rate",  float(rate))

                    print(f"{s['name']}: {dist:.1f}cm  rate: {rate}")

        time.sleep(0.05)

except KeyboardInterrupt:
    GPIO.cleanup()