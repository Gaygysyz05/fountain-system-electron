"""
Daemon listens on localhost only. The Electron app and this process run on the
same machine; there is no reason for the control socket to be reachable from the
network, unlike the old api_server.py (0.0.0.0 + a hardcoded API key baked into
a distributed .exe).
"""
HOST = "127.0.0.1"
PORT = 8765
WS_PATH = "/ws"

# "Localhost only" stops the network, but not a browser tab: any website open
# on this machine can still hit http://127.0.0.1:8765 (CORS just controls
# whether its JS gets to read the response) and, worse, WebSocket connections
# aren't subject to CORS at all -- a page with nothing but
# `new WebSocket("ws://127.0.0.1:8765/ws")` could otherwise send PLAY_SCENARIO
# / EMERGENCY_STOP / SET_DEVICE_STATE straight to real motors and valves.
# These are the only origins a legitimate renderer ever presents: the
# electron-vite dev server, and "null" -- what Chromium sends as Origin for a
# packaged app's file:// page. Used both to tighten CORS (main.py) and to
# reject the WS handshake outright (ws_endpoint) from anything else.
ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "null"]
