#!/usr/bin/env python3
"""A small localhost-only Edge TTS service for Chrome Bilingual Translator."""

import asyncio
import io
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import edge_tts


HOST = "127.0.0.1"
PORT = 8765
MAX_TEXT_LENGTH = 6000


class EdgeTtsHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path != "/health":
            return self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
        self._send_json(HTTPStatus.OK, {"ok": True, "service": "edge-tts"})

    def do_POST(self):
        if self.path != "/speak":
            return self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            text = str(payload.get("text", "")).strip()
            voice = str(payload.get("voice", "en-US-AriaNeural")).strip()
            if not text or len(text) > MAX_TEXT_LENGTH:
                raise ValueError(f"text must contain 1-{MAX_TEXT_LENGTH} characters")
            audio = asyncio.run(synthesize(text, voice))
        except (ValueError, json.JSONDecodeError) as error:
            return self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except Exception as error:
            return self._send_json(HTTPStatus.BAD_GATEWAY, {"error": f"Edge TTS failed: {error}"})

        self.send_response(HTTPStatus.OK)
        self._cors_headers()
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        print(f"[edge-tts] {self.address_string()} - {format % args}")


async def synthesize(text, voice):
    output = io.BytesIO()
    communicate = edge_tts.Communicate(text, voice=voice, rate="-4%")
    async for event in communicate.stream():
        if event["type"] == "audio":
            output.write(event["data"])
    return output.getvalue()


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), EdgeTtsHandler)
    print(f"Edge TTS service running at http://{HOST}:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nEdge TTS service stopped.")
    finally:
        server.server_close()
