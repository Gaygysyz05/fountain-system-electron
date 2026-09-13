"""Localhost-only control socket -- unlike the old api_server.py (0.0.0.0 + a hardcoded API key baked into a distributed .exe)."""
HOST = "127.0.0.1"
PORT = 8765
WS_PATH = "/ws"

# WebSockets aren't subject to CORS, so without this any local page could open ws://127.0.0.1:8765/ws and drive real motors/valves directly; checked in both main.py's CORS and ws_endpoint's handshake rejection.
ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "null"]
