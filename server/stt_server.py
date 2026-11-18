#!/usr/bin/env python3
# Relay STT local: recebe WAV (PCM16 16k mono) por POST /stt, salva e devolve {"text": ...}.
# Fase 1: stub (devolve tamanho). STT real plugado depois em transcribe().
import http.server, json, os, time, sys, subprocess, threading


def load_dotenv(path=None):
    # Carrega KEY=valor de um .env simples (sem dependência externa), sem
    # sobrescrever variáveis já exportadas no ambiente. O arquivo .env não
    # é versionado (ver .gitignore); use .env.example como modelo.
    path = path or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                os.environ.setdefault(k, v)
    except FileNotFoundError:
        pass


load_dotenv()

# Pre-stage o script de BACK no device uma vez (reduz latencia: so 1 vda shell).
STAGE = (
    "export PATH=/root/vega/bin:$PATH; "
    "printf 'inputd-cli button_press KEY_BACK >/dev/null 2>&1\\n' > /root/back.sh; "
    "vega exec vda push /root/back.sh /tmp/back.sh >/dev/null 2>&1"
)
FIRE = "export PATH=/root/vega/bin:$PATH; vega exec vda shell sh /tmp/back.sh >/dev/null 2>&1"

def stage_back():
    try:
        subprocess.run(["docker", "exec", "vega-sdk-dl", "bash", "-c", STAGE],
                       timeout=30, capture_output=True)
        sys.stderr.write("[back] script staged\n"); sys.stderr.flush()
    except Exception as e:
        sys.stderr.write(f"[back] stage erro: {e}\n"); sys.stderr.flush()

def inject_back():
    # Injeta KEY_BACK (fecha overlay/áudio da Alexa). O app consome back,
    # entao se o BACK chegar ao app e inofensivo (nao fecha).
    try:
        subprocess.run(["docker", "exec", "vega-sdk-dl", "bash", "-c", FIRE],
                       timeout=15, capture_output=True)
        sys.stderr.write("[back] KEY_BACK\n"); sys.stderr.flush()
    except Exception as e:
        sys.stderr.write(f"[back] erro: {e}\n"); sys.stderr.flush()

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "caps")
os.makedirs(OUT, exist_ok=True)

import wave, struct, urllib.request, numpy as np

DG_KEY = os.environ.get("DEEPGRAM_API_KEY", "").strip()
# nova-2 pt com pontuacao; SEM smart_format (ele troca "uma" por "1", ruim p/ msg).
DG_URL = ("https://api.deepgram.com/v1/listen"
          "?model=nova-2&language=pt&punctuate=true")

# ---- utilitarios de audio ----
def read_pcm(wav_path):
    w = wave.open(wav_path, "rb")
    sr = w.getframerate()
    a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return a, sr

def trim_silence(a, sr, th=500, pad=0.15):
    # recorta so a regiao com fala (reduz alucinacao do STT em silencio longo)
    idx = np.where(np.abs(a) > th)[0]
    if len(idx) == 0:
        return a
    p = int(pad * sr)
    i0 = max(0, idx[0] - p); i1 = min(len(a), idx[-1] + p)
    return a[i0:i1]

def normalize(a, target=16000, max_gain=18.0, floor=60, weak_below=9000):
    # Ganho automatico SO para capturas fracas: se o pico ja esta acima de
    # weak_below, deixa o audio intacto (nao mexe nas boas). Nao amplifica
    # silencio/ruido (pico < floor) e limita o ganho. Usa o pico absoluto
    # (mesmo criterio do picoMax da sonda).
    if len(a) == 0:
        return a, 1.0
    peak = int(np.max(np.abs(a)))
    if peak < floor or peak >= weak_below:
        return a, 1.0
    gain = min(max_gain, target / peak)
    if gain <= 1.0:
        return a, 1.0
    out = np.clip(a.astype(np.float32) * gain, -32768, 32767).astype(np.int16)
    return out, gain

def pcm_to_wav_bytes(a, sr):
    data = a.astype("<i2").tobytes()
    hdr = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
    hdr += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16)
    hdr += b"data" + struct.pack("<I", len(data))
    return hdr + data

# ---- Deepgram (nuvem) ----
def deepgram(wav_bytes):
    req = urllib.request.Request(
        DG_URL,
        data=wav_bytes,
        headers={"Authorization": "Token " + DG_KEY, "Content-Type": "audio/wav"},
        method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.loads(r.read().decode())
    return j["results"]["channels"][0]["alternatives"][0]["transcript"].strip()

# ---- Whisper local (fallback) ----
_WHISPER = None
def whisper_local(a, sr):
    global _WHISPER
    if _WHISPER is None:
        from faster_whisper import WhisperModel
        sys.stderr.write("[stt] carregando whisper fallback…\n"); sys.stderr.flush()
        _WHISPER = WhisperModel("small", device="cpu", compute_type="int8")
    audio = a.astype(np.float32) / 32768.0
    segs, _ = _WHISPER.transcribe(audio, language="pt", vad_filter=True)
    return " ".join(s.text.strip() for s in segs).strip()

def transcribe(wav_path):
    a, sr = read_pcm(wav_path)
    a = trim_silence(a, sr)
    if len(a) < sr * 0.2:        # menos de 0,2s de fala util
        return ""
    a, gain = normalize(a)
    if gain > 1.0:
        sys.stderr.write(f"[stt] ganho auto x{gain:.1f}\n"); sys.stderr.flush()
    if DG_KEY:
        try:
            t = deepgram(pcm_to_wav_bytes(a, sr))
            if t:
                sys.stderr.write("[stt] deepgram ok\n"); sys.stderr.flush()
                return t
            sys.stderr.write("[stt] deepgram vazio -> whisper\n"); sys.stderr.flush()
        except Exception as e:
            sys.stderr.write(f"[stt] deepgram erro -> whisper: {e}\n"); sys.stderr.flush()
    return whisper_local(a, sr)

class H(http.server.BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path.startswith("/back"):
            threading.Thread(target=inject_back, daemon=True).start()
            self._send(200, {"back": True})
            return
        self._send(200, {"ok": True, "ts": time.time()})
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(n)
        ts = time.strftime("%H%M%S")
        # /log: instrumentacao do app (eventos de ciclo de vida), fora da UI.
        if self.path.startswith("/log"):
            try:
                msg = data.decode("utf-8", "replace")
            except Exception:
                msg = repr(data)
            sys.stderr.write(f"[app {ts}] {msg}\n"); sys.stderr.flush()
            self._send(200, {"logged": True})
            return
        path = os.path.join(OUT, f"cap_{ts}.wav")
        with open(path, "wb") as f:
            f.write(data)
        sys.stderr.write(f"[{ts}] POST {self.path} {len(data)}B -> {path}\n"); sys.stderr.flush()
        try:
            text = transcribe(path)
        except Exception as e:
            text = ""
            sys.stderr.write(f"  transcribe error: {e}\n"); sys.stderr.flush()
        self._send(200, {"text": text, "bytes": len(data)})
    def log_message(self, *a): pass

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    stage_back()
    print(f"STT relay on 0.0.0.0:{port}  out={OUT}", flush=True)
    http.server.ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
