import socket
import threading
import rtmidi
import sys
import time

# ─── MIDI Controller Forwarding ────────────────────────
# Reads USB MIDI controllers plugged into the Pi and forwards
# their messages to the router via UDP on port 5006.
# The router receives on port 5006 and broadcasts as type:'midi'.
#
# Message format: device_name|midi_bytes
# e.g. b'Teensy MIDI|0xB2 0x01 0x40'
#
# The router's midiSocket handler splits on '|' and decodes
# the raw MIDI bytes into channel/CC/note/value.

ROUTER_HOST = '127.0.0.1'
ROUTER_PORT = 5006

def decode_midi(data):
    """Human-readable MIDI message for logs."""
    if len(data) < 2:
        return str(list(data))
    status   = data[0]
    msg_type = status & 0xF0
    channel  = (status & 0x0F) + 1
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
        return f"Ch{channel} {type_name} cc={data[1]} value={data[2]}"
    elif msg_type in (0x80, 0x90):
        return f"Ch{channel} {type_name} note={data[1]} velocity={data[2]}"
    elif msg_type == 0xE0:
        return f"Ch{channel} {type_name} value={(data[2] << 7) | data[1]}"
    else:
        return f"Ch{channel} {type_name} {list(data[1:])}"

def forward_midi_input(port_index, port_name):
    midi_in = rtmidi.MidiIn()
    midi_in.open_port(port_index)
    print(f"Forwarding MIDI from: {port_name}")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def callback(message, data):
        try:
            msg_bytes, _ = message
            device  = port_name.split(':')[0].encode('utf-8')
            payload = device + b'|' + bytes(msg_bytes)
            sock.sendto(bytes(payload), (ROUTER_HOST, ROUTER_PORT))
            print(f"{port_name.split(':')[0]} → {decode_midi(list(msg_bytes))}")
        except Exception as e:
            print(f"Callback error: {e}")

    midi_in.set_callback(callback)
    while True:
        time.sleep(1)

def start():
    temp  = rtmidi.MidiIn()
    ports = temp.get_ports()
    print("MIDI inputs found:", ports)

    skip = ['Through', 'PipeWire']
    started = 0
    for i, name in enumerate(ports):
        if any(s in name for s in skip):
            continue
        t = threading.Thread(target=forward_midi_input, args=(i, name), daemon=True)
        t.start()
        started += 1

    if started == 0:
        print("No MIDI controllers found. Waiting...")

    # Keep main thread alive
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("Stopping MIDI forwarding.")
        sys.exit(0)

if __name__ == '__main__':
    start()