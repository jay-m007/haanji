"""Wiring test for the speech service in --fake mode (no models, stdlib only)."""
import base64
import json
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

import server


class FakeSpeechService(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(server.Models(fake=True)))
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def post(self, path, body):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())

    def test_health(self):
        with urllib.request.urlopen(self.base + "/health") as r:
            self.assertEqual(json.loads(r.read())["fake"], True)

    def test_stt(self):
        audio = base64.b64encode(b"\x00\x10" * 1600).decode()
        self.assertIn("पेपर पिन", self.post("/stt", {"lang": "hi", "sample_rate": 16000, "audio": audio})["text"])

    def test_tts(self):
        r = self.post("/tts", {"lang": "mr", "text": "नमस्कार"})
        self.assertEqual(r["sample_rate"], 16000)
        self.assertGreater(len(base64.b64decode(r["audio"])), 1000)

    def test_tts_empty_text_is_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.post("/tts", {"lang": "hi", "text": "  "})
        self.assertEqual(e.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
