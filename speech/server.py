"""Haanji speech service: free, local speech-to-text and text-to-speech for Hindi, Marathi and Gujarati.

Models (downloaded once from Hugging Face, then cached):
  - ai4bharat/indic-conformer-600m-multilingual  (speech to text, MIT)
  - ai4bharat/indic-parler-tts                    (text to speech, Apache 2.0)

Run:   python server.py                (needs a GPU for live calls; works on CPU, slowly)
Test:  python server.py --fake         (no models: echoes a fixed sentence and a tone)

API (JSON over HTTP, port 5070; not 5060, which browsers and Node refuse as a SIP port):
  GET  /health -> {"ok": true, "device": "cuda", "fake": false}
  POST /stt  {"lang": "hi", "sample_rate": 16000, "audio": <base64 16-bit PCM mono>} -> {"text": "..."}
  POST /tts  {"lang": "hi", "text": "..."} -> {"sample_rate": 44100, "audio": <base64 16-bit PCM mono>}
"""
import argparse
import base64
import json
import math
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# IndicConformer takes ISO codes; English and mixed speech go through the Hindi model.
STT_LANG = {"hi": "hi", "mr": "mr", "gu": "gu", "en": "hi", "mixed": "hi"}

# Indic Parler-TTS picks a voice from a written description. Named speakers from the model card.
VOICES = {
    "hi": "Divya speaks in a clear, friendly and polite tone at a moderate pace. The recording is very clear with no background noise.",
    "mr": "Sunita speaks in a clear, friendly and polite tone at a moderate pace. The recording is very clear with no background noise.",
    "gu": "Neha speaks in a clear, friendly and polite tone at a moderate pace. The recording is very clear with no background noise.",
    "en": "Divya speaks in a clear, friendly and polite tone at a moderate pace. The recording is very clear with no background noise.",
}
VOICES["mixed"] = VOICES["hi"]


class Models:
    """Loads both models once. One lock per model: a GPU runs one request at a time anyway."""

    def __init__(self, fake: bool):
        self.fake = fake
        self.device = "none"
        self.stt_lock = threading.Lock()
        self.tts_lock = threading.Lock()
        if fake:
            return
        import torch  # noqa: imported here so --fake needs nothing installed
        from transformers import AutoModel, AutoTokenizer
        from parler_tts import ParlerTTSForConditionalGeneration

        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        if self.device == "cpu":
            print("! No CUDA GPU found: speech will be too slow for live phone calls.", file=sys.stderr)
        t0 = time.time()
        self.stt_model = AutoModel.from_pretrained("ai4bharat/indic-conformer-600m-multilingual", trust_remote_code=True)
        if hasattr(self.stt_model, "to"):
            try:
                self.stt_model = self.stt_model.to(self.device)
            except Exception:
                pass  # the ONNX-based model manages its own device
        self.tts_model = ParlerTTSForConditionalGeneration.from_pretrained("ai4bharat/indic-parler-tts").to(self.device)
        self.tts_tok = AutoTokenizer.from_pretrained("ai4bharat/indic-parler-tts")
        self.desc_tok = AutoTokenizer.from_pretrained(self.tts_model.config.text_encoder._name_or_path)
        self.tts_rate = self.tts_model.config.sampling_rate
        print(f"Models loaded on {self.device} in {time.time() - t0:.0f} s", file=sys.stderr)

    def stt(self, pcm: bytes, rate: int, lang: str) -> str:
        if self.fake:
            return "मुझे 1000 बॉक्स पेपर पिन चाहिए" if pcm else ""
        torch = self.torch
        samples = struct.unpack("<%dh" % (len(pcm) // 2), pcm[: len(pcm) - len(pcm) % 2])
        wav = torch.tensor(samples, dtype=torch.float32).unsqueeze(0) / 32768.0
        if rate != 16000:
            import torchaudio
            wav = torchaudio.transforms.Resample(orig_freq=rate, new_freq=16000)(wav)
        with self.stt_lock:
            text = self.stt_model(wav, STT_LANG.get(lang, "hi"), "rnnt")
        return text if isinstance(text, str) else str(text)

    def tts(self, text: str, lang: str):
        if self.fake:
            rate = 16000
            n = min(rate * 4, 600 * len(text))
            return rate, b"".join(struct.pack("<h", int(3000 * math.sin(2 * math.pi * 300 * i / rate))) for i in range(n))
        torch = self.torch
        desc = self.desc_tok(VOICES.get(lang, VOICES["hi"]), return_tensors="pt").to(self.device)
        prompt = self.tts_tok(text, return_tensors="pt").to(self.device)
        with self.tts_lock, torch.no_grad():
            out = self.tts_model.generate(input_ids=desc.input_ids, attention_mask=desc.attention_mask,
                                          prompt_input_ids=prompt.input_ids, prompt_attention_mask=prompt.attention_mask)
        audio = out.cpu().numpy().squeeze()
        audio = (audio.clip(-1, 1) * 32767).astype("<i2").tobytes()
        return self.tts_rate, audio


def make_handler(models: Models):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # quieter: one line per request
            sys.stderr.write("%s %s\n" % (self.command, self.path))

        def reply(self, status: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                return self.reply(200, {"ok": True, "device": models.device, "fake": models.fake})
            self.reply(404, {"error": "not found"})

        def do_POST(self):
            try:
                n = int(self.headers.get("content-length", "0"))
                if n > 20 * 1024 * 1024:
                    return self.reply(413, {"error": "too large"})
                body = json.loads(self.rfile.read(n) or b"{}")
                lang = body.get("lang", "hi")
                if self.path == "/stt":
                    pcm = base64.b64decode(body.get("audio", ""))
                    return self.reply(200, {"text": models.stt(pcm, int(body.get("sample_rate", 16000)), lang).strip()})
                if self.path == "/tts":
                    text = str(body.get("text", "")).strip()[:600]
                    if not text:
                        return self.reply(400, {"error": "text is empty"})
                    rate, audio = models.tts(text, lang)
                    return self.reply(200, {"sample_rate": rate, "audio": base64.b64encode(audio).decode()})
                self.reply(404, {"error": "not found"})
            except Exception as e:  # report, keep serving
                self.reply(500, {"error": f"{type(e).__name__}: {e}"})

    return Handler


def main(argv=None):
    p = argparse.ArgumentParser(description="Haanji speech service")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=5070)
    p.add_argument("--fake", action="store_true", help="no models; for testing the wiring")
    a = p.parse_args(argv)
    models = Models(a.fake)
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(models))
    print(f"Haanji speech service on http://{a.host}:{a.port} ({'fake' if a.fake else models.device})", file=sys.stderr)
    srv.serve_forever()


if __name__ == "__main__":
    main()
