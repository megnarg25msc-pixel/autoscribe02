import os
import sys
import json
import time
import urllib.parse

# Limit OpenBLAS / MKL threads to prevent memory allocation issues
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["OPENBLAS_NUM_THREADS"] = "2"
os.environ["MKL_NUM_THREADS"] = "2"

from http.server import HTTPServer, BaseHTTPRequestHandler
from voice_engine import (
    get_whisper_model,
    transcribe_audio_bytes,
    normalize_math,
    DEFAULT_MODEL_NAME,
    DEVICE,
    COMPUTE_TYPE
)

# Bind strictly to localhost (127.0.0.1) for local safety
HOST = "127.0.0.1"
PORT = 5000


class VoiceServerRequestHandler(BaseHTTPRequestHandler):
    """HTTP request handler for local AutoScribe voice engine."""

    def _set_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(200)
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path).path

        if parsed_path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._set_cors_headers()
            self.end_headers()

            response = {
                "status": "ok",
                "engine": "faster-whisper",
                "model": DEFAULT_MODEL_NAME,
                "device": DEVICE,
                "compute_type": COMPUTE_TYPE
            }
            self.wfile.write(json.dumps(response).encode("utf-8"))

        elif parsed_path in ["/", "/test_client.html", "/index.html"]:
            client_file = "test_client.html"
            if os.path.exists(client_file):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self._set_cors_headers()
                self.end_headers()
                with open(client_file, "rb") as f:
                    self.wfile.write(f.read())
            else:
                self.send_error(404, "test_client.html not found")

        else:
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Endpoint not found"}).encode("utf-8"))

    def do_POST(self):
        parsed_path = urllib.parse.urlparse(self.path).path

        if parsed_path == "/transcribe":
            content_type = self.headers.get("Content-Type", "")
            content_length = int(self.headers.get("Content-Length", 0))

            if content_length == 0:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": "Empty body"}).encode("utf-8"))
                return

            body = self.rfile.read(content_length)

            # Determine audio format suffix (.wav or .webm)
            suffix = ".wav"
            if "webm" in content_type.lower():
                suffix = ".webm"
            elif "ogg" in content_type.lower():
                suffix = ".ogg"
            elif "mp3" in content_type.lower():
                suffix = ".mp3"

            # Extract raw audio if multipart/form-data payload
            audio_bytes = body
            if "multipart/form-data" in content_type:
                boundary = content_type.split("boundary=")[-1].encode("utf-8")
                parts = body.split(boundary)
                for part in parts:
                    if b"filename=" in part or b"audio" in part:
                        sep_idx = part.find(b"\r\n\r\n")
                        if sep_idx != -1:
                            raw_data = part[sep_idx + 4:]
                            if raw_data.endswith(b"\r\n--"):
                                raw_data = raw_data[:-6]
                            elif raw_data.endswith(b"\r\n"):
                                raw_data = raw_data[:-2]
                            audio_bytes = raw_data
                            break

            try:
                # Ensure diagnostic audio folder exists with absolute path
                base_dir = os.path.dirname(os.path.abspath(__file__))
                diag_dir = os.path.join(base_dir, "diagnostic_audio")
                os.makedirs(diag_dir, exist_ok=True)

                timestamp_str = time.strftime("%Y%m%d_%H%M%S")
                diag_filename = f"diagnostic_{timestamp_str}_mic.wav"
                diag_filepath = os.path.join(diag_dir, diag_filename)

                # Save raw incoming bytes to diagnostic WAV file on disk
                with open(diag_filepath, "wb") as f:
                    f.write(audio_bytes)

                # Inspect and verify WAV PCM header metadata
                sample_rate_hz = 16000
                channels = 1
                bits_per_sample = 16
                nframes = 0
                audio_duration_sec = 0.0
                is_valid_16k_mono = False

                if suffix == ".wav":
                    try:
                        import wave
                        with wave.open(diag_filepath, "rb") as wf:
                            sample_rate_hz = wf.getframerate()
                            channels = wf.getnchannels()
                            sample_width = wf.getsampwidth()
                            bits_per_sample = sample_width * 8
                            nframes = wf.getnframes()
                            audio_duration_sec = round(nframes / float(sample_rate_hz), 2)
                            is_valid_16k_mono = (sample_rate_hz == 16000 and channels == 1 and bits_per_sample == 16)
                    except Exception as ve:
                        print(f"[WAV Header Error]: {ve}", file=sys.stderr)

                raw_byte_length = len(audio_bytes)
                if audio_duration_sec == 0.0 and raw_byte_length > 0:
                    audio_duration_sec = round(raw_byte_length / (sample_rate_hz * 2), 2)

                # Transcribe saved diagnostic WAV with local faster-whisper (Config C baseline)
                raw_text, duration_sec = transcribe_audio_bytes(audio_bytes, file_suffix=suffix)

                print("\n" + "=" * 70)
                print("         AUTOSCRIBE DIAGNOSTIC AUDIO REQUEST LOG")
                print("=" * 70)
                print(f"Saved Diagnostic WAV File: {diag_filepath}")
                print(f"WAV Duration:              {audio_duration_sec:.2f}s")
                print(f"Sample Rate:               {sample_rate_hz} Hz")
                print(f"Number of Channels:        {channels} ({'Mono' if channels == 1 else 'Stereo'})")
                print(f"Bits Per Sample:           {bits_per_sample}-bit")
                print(f"Total PCM Frames:          {nframes}")
                print(f"Raw Byte Length:           {raw_byte_length} bytes")
                print(f"Verified 16kHz Mono 16bit: {'YES [VERIFIED CLEAN]' if is_valid_16k_mono else 'NO [HEADER MISMATCH]'}")
                print(f"Whisper Processing Time:   {duration_sec:.3f}s")
                print(f"Raw Transcript:            \"{raw_text}\"")
                print("=" * 70 + "\n")

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self._set_cors_headers()
                self.end_headers()

                response = {
                    "success": True,
                    "transcript": raw_text,
                    "saved_file": diag_filename,
                    "saved_filepath": diag_filepath,
                    "audio_duration_sec": audio_duration_sec,
                    "sample_rate_hz": sample_rate_hz,
                    "channels": channels,
                    "bits_per_sample": bits_per_sample,
                    "total_pcm_frames": nframes,
                    "raw_byte_length": raw_byte_length,
                    "is_valid_16k_mono": is_valid_16k_mono,
                    "processing_time_sec": round(duration_sec, 3)
                }
                self.wfile.write(json.dumps(response).encode("utf-8"))

            except Exception as e:
                print(f"[Transcribe Error]: {e}", file=sys.stderr)
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode("utf-8"))

        else:
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Endpoint not found"}).encode("utf-8"))

    def log_message(self, format, *args):
        sys.stdout.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {format % args}\n")


def start_server():
    """Initialize model ONCE at startup and start HTTP server."""
    print("\n" + "=" * 65)
    print("      INITIALIZING AUTOSCRIBE LOCAL VOICE SERVER (DIAGNOSTIC MODE)")
    print("=" * 65)
    
    # Ensure diagnostic audio directory exists
    diag_dir = os.path.join(os.path.dirname(__file__), "diagnostic_audio")
    os.makedirs(diag_dir, exist_ok=True)
    print(f"Diagnostic Audio Folder: {diag_dir}")

    # Initialize Whisper model ONCE in memory before accepting connections
    get_whisper_model(DEFAULT_MODEL_NAME)

    server_address = (HOST, PORT)
    httpd = HTTPServer(server_address, VoiceServerRequestHandler)

    print("\n" + "=" * 65)
    print("          AUTOSCRIBE LOCAL VOICE SERVER READY")
    print("=" * 65)
    print(f"Server Host:        http://{HOST}:{PORT}")
    print(f"Health Check:       http://{HOST}:{PORT}/health")
    print(f"Transcribe API:     http://{HOST}:{PORT}/transcribe")
    print(f"Browser Test Page:  http://{HOST}:{PORT}/test_client.html")
    print(f"Diagnostic Folder:  {diag_dir}")
    print("Listening strictly on 127.0.0.1 (Localhost only)")
    print("=" * 65 + "\n")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping AutoScribe local voice server...")
        httpd.server_close()


if __name__ == "__main__":
    start_server()
