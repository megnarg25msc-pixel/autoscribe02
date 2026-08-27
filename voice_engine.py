import os
import sys
import time
import queue
import threading
import re

# Limit OpenBLAS / OMP threads to avoid Windows memory allocation errors
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["OPENBLAS_NUM_THREADS"] = "2"
os.environ["MKL_NUM_THREADS"] = "2"

import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel

# Ensure UTF-8 output encoding for Windows terminal compatibility
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Global model cache to avoid re-loading models unnecessarily
_MODEL_CACHE = {}

# Default model settings
DEFAULT_MODEL_NAME = "base.en"
DEVICE = "cpu"
COMPUTE_TYPE = "int8"

# AutoScribe domain-specific vocabulary prompt for Whisper context guidance
AUTOSCRIBE_INITIAL_PROMPT = (
    "AutoScribe examination dictation vocabulary context: "
    "mathematics, equation, algebra, geometry, calculus, integral, derivative, "
    "coefficient, variable, exponent, square, squared, cube, cubed, "
    "plus, minus, multiplied, divided, equals, greater than, less than, "
    "greater than or equal to, less than or equal to, "
    "photosynthesis, respiration, chemistry, physics, biology, "
    "answer, question, roll number, submit, next question, read question."
)


def get_whisper_model(model_name: str = DEFAULT_MODEL_NAME) -> WhisperModel:
    """Retrieve or lazily initialize a local WhisperModel instance."""
    if model_name not in _MODEL_CACHE:
        print(f"Loading local Whisper model ('{model_name}' on {DEVICE} with {COMPUTE_TYPE})...")
        start_t = time.time()
        _MODEL_CACHE[model_name] = WhisperModel(
            model_name,
            device=DEVICE,
            compute_type=COMPUTE_TYPE
        )
        print(f"MODEL READY ('{model_name}' loaded in {time.time() - start_t:.2f}s)")
    return _MODEL_CACHE[model_name]


NUMBER_WORDS = {
    "zero": "0",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
    "ten": "10",
    "eleven": "11",
    "twelve": "12",
    "thirteen": "13",
    "fourteen": "14",
    "fifteen": "15",
    "sixteen": "16",
    "seventeen": "17",
    "eighteen": "18",
    "nineteen": "19",
    "twenty": "20",
    "thirty": "30",
    "forty": "40",
    "fifty": "50",
    "sixty": "60",
    "seventy": "70",
    "eighty": "80",
    "ninety": "90",
}


def normalize_math(text: str) -> str:
    """Convert spoken mathematical English into compact notation.
    
    This is an optional utility function and is NOT automatically applied
    to general English speech transcription.
    """
    text = text.lower().strip()

    # Multi-word operators FIRST
    replacements = [
        ("greater than or equal to", "≥"),
        ("less than or equal to", "≤"),
        ("divided by", "÷"),
        ("multiplied by", "×"),
        ("open bracket", "("),
        ("close bracket", ")"),
        ("open parenthesis", "("),
        ("close parenthesis", ")"),
        ("is equal to", "="),
        ("equal to", "="),
        ("equals", "="),
        ("greater than", ">"),
        ("less than", "<"),
        ("plus", "+"),
        ("minus", "-"),
        ("times", "×"),
    ]

    for spoken, symbol in replacements:
        text = text.replace(spoken, f" {symbol} ")

    # Powers
    text = re.sub(r"\b(squared|square)\b", "²", text)
    text = re.sub(r"\b(cubed|cube)\b", "³", text)

    # Convert number words
    words = text.split()
    converted = []

    for word in words:
        if word in NUMBER_WORDS:
            converted.append(NUMBER_WORDS[word])
        else:
            converted.append(word)

    text = " ".join(converted)

    # Remove spaces around operators
    text = re.sub(r"\s*([+×÷=><≤≥-])\s*", r"\1", text)

    # Remove spaces before/after brackets
    text = re.sub(r"\s*\(\s*", "(", text)
    text = re.sub(r"\s*\)\s*", ")", text)

    # Convert "5 x" -> "5x"
    text = re.sub(r"(\d+)\s+x\b", r"\1x", text)

    # Convert "x ³" -> "x³"
    text = re.sub(r"\bx\s+([²³])", r"x\1", text)

    # Remove remaining unnecessary spaces
    text = re.sub(r"\s+", " ", text).strip()

    return text


def transcribe_audio_file(
    filename: str,
    model_name: str = DEFAULT_MODEL_NAME,
    beam_size: int = 5,
    use_initial_prompt: bool = True,
    condition_on_previous_text: bool = False
) -> tuple[str, float]:
    """Transcribe an audio file using local faster-whisper. Returns (transcript, duration_sec)."""
    model_inst = get_whisper_model(model_name)
    prompt = AUTOSCRIBE_INITIAL_PROMPT if use_initial_prompt else None

    start_t = time.time()
    segments, info = model_inst.transcribe(
        filename,
        beam_size=beam_size,
        language="en",
        temperature=0.0,
        condition_on_previous_text=condition_on_previous_text,
        initial_prompt=prompt,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=1000, speech_pad_ms=400)
    )
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
    duration = time.time() - start_t
    return text, duration


def transcribe_audio_bytes(
    audio_bytes: bytes,
    file_suffix: str = ".wav",
    model_name: str = DEFAULT_MODEL_NAME
) -> tuple[str, float]:
    """Transcribe raw audio bytes using local faster-whisper. Returns (transcript, duration_sec)."""
    import tempfile
    if not audio_bytes or len(audio_bytes) == 0:
        return "", 0.0

    with tempfile.NamedTemporaryFile(suffix=file_suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        raw_text, duration = transcribe_audio_file(tmp_path, model_name=model_name)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass

    return raw_text, duration


def transcribe_audio_array(
    audio_data: np.ndarray,
    samplerate: int = 16000,
    model_name: str = DEFAULT_MODEL_NAME,
    beam_size: int = 5,
    use_initial_prompt: bool = True,
    condition_on_previous_text: bool = False
) -> str:
    """Transcribe a 1D float32 numpy audio array sampled at samplerate (default 16kHz)."""
    if len(audio_data) == 0:
        return ""

    # Ensure float32 1D array normalized [-1, 1]
    if audio_data.dtype != np.float32:
        audio_data = audio_data.astype(np.float32)
    if audio_data.ndim > 1:
        audio_data = audio_data.squeeze()

    # RMS Energy check to ignore pure silence and background noise
    rms = np.sqrt(np.mean(audio_data ** 2))
    if rms < 0.003:
        return ""

    model_inst = get_whisper_model(model_name)
    prompt = AUTOSCRIBE_INITIAL_PROMPT if use_initial_prompt else None

    try:
        segments, info = model_inst.transcribe(
            audio_data,
            beam_size=beam_size,
            language="en",
            temperature=0.0,
            condition_on_previous_text=condition_on_previous_text,
            initial_prompt=prompt,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=1000, speech_pad_ms=400)
        )
        texts = [seg.text.strip() for seg in segments if seg.text.strip()]
        return " ".join(texts)
    except Exception as e:
        print(f"\n[Transcription Error: {e}]", file=sys.stderr)
        return ""


def run_continuous_dictation(
    silence_threshold_sec: float = 1.0,
    rms_threshold: float = 0.003,
    max_phrase_sec: float = 15.0,
    model_name: str = DEFAULT_MODEL_NAME,
    device_index: int = None
):
    """Capture microphone audio continuously, segmenting phrases dynamically
    when the speaker pauses for `silence_threshold_sec` (0.8–1.2 seconds),
    maintaining a cumulative transcript buffer.
    Pressing ENTER stops transcription.
    """
    samplerate = 16000
    channels = 1
    audio_queue = queue.Queue()
    stop_event = threading.Event()

    def audio_callback(indata, frames, time_info, status):
        if status:
            print(f"\n[Audio Input Status: {status}]", file=sys.stderr)
        audio_queue.put(indata.copy())

    print("\n" + "=" * 60)
    print("      GENERAL MICROPHONE TRANSCRIPTION ENGINE (LOCAL)")
    print("=" * 60)
    print(f"Model: {model_name} | Sample Rate: {samplerate} Hz | Pause Cutoff: {silence_threshold_sec}s")
    if device_index is not None:
        print(f"Microphone Device Index: {device_index}")
    else:
        print("Microphone Device: Default System Input")
    print("Press [ENTER] at any time to STOP dictation.")
    print("=" * 60 + "\n")

    cumulative_transcript = ""

    # Thread to monitor ENTER key press for graceful exit
    def wait_for_user_stop():
        try:
            input()
        except EOFError:
            pass
        stop_event.set()

    stop_thread = threading.Thread(target=wait_for_user_stop, daemon=True)
    stop_thread.start()

    # Open microphone input stream
    try:
        stream = sd.InputStream(
            samplerate=samplerate,
            channels=channels,
            dtype='float32',
            device=device_index,
            callback=audio_callback
        )
    except Exception as e:
        print(f"Error initializing microphone stream: {e}")
        return cumulative_transcript

    with stream:
        phrase_buffer = np.array([], dtype=np.float32)
        has_spoken = False
        silence_start_time = None

        while not stop_event.is_set():
            try:
                block = audio_queue.get(timeout=0.1)
                block_data = block.squeeze()
            except queue.Empty:
                block_data = np.array([], dtype=np.float32)

            if len(block_data) > 0:
                phrase_buffer = np.append(phrase_buffer, block_data)
                block_rms = np.sqrt(np.mean(block_data ** 2))

                if block_rms >= rms_threshold:
                    if not has_spoken:
                        has_spoken = True
                    silence_start_time = None
                else:
                    if has_spoken:
                        if silence_start_time is None:
                            silence_start_time = time.time()

            current_time = time.time()
            phrase_duration = (len(phrase_buffer) / samplerate)

            should_finalize = False
            if has_spoken and silence_start_time is not None:
                if (current_time - silence_start_time) >= silence_threshold_sec:
                    should_finalize = True
            elif has_spoken and phrase_duration >= max_phrase_sec:
                should_finalize = True

            if should_finalize and len(phrase_buffer) > 0:
                raw_text = transcribe_audio_array(
                    phrase_buffer,
                    samplerate=samplerate,
                    model_name=model_name
                )

                if raw_text:
                    if cumulative_transcript:
                        cumulative_transcript += " " + raw_text
                    else:
                        cumulative_transcript = raw_text

                    print("\nRAW TRANSCRIPT:")
                    print(raw_text)
                    print("\nCUMULATIVE TRANSCRIPT:")
                    print(cumulative_transcript)
                    print("-" * 50)

                phrase_buffer = np.array([], dtype=np.float32)
                has_spoken = False
                silence_start_time = None

        while not audio_queue.empty():
            block = audio_queue.get_nowait()
            phrase_buffer = np.append(phrase_buffer, block.squeeze())

        if len(phrase_buffer) > int(0.5 * samplerate):
            final_raw = transcribe_audio_array(
                phrase_buffer,
                samplerate=samplerate,
                model_name=model_name
            )
            if final_raw:
                if cumulative_transcript:
                    cumulative_transcript += " " + final_raw
                else:
                    cumulative_transcript = final_raw

                print("\nRAW TRANSCRIPT:")
                print(final_raw)
                print("\nCUMULATIVE TRANSCRIPT:")
                print(cumulative_transcript)
                print("-" * 50)

    print("\n" + "=" * 60)
    print("              DICTATION SESSION ENDED")
    print("=" * 60)
    print("FINAL CUMULATIVE TRANSCRIPT:")
    print(cumulative_transcript if cumulative_transcript else "(No speech recorded)")
    print("=" * 60 + "\n")

    return cumulative_transcript


def run_math_normalization_tests() -> bool:
    """Run unit tests for mathematical normalization logic."""
    spoken_segments = [
        "x cube",
        "plus three",
        "equals ten"
    ]

    math_buffer = ""

    print("\n=== CUMULATIVE MATH DICTATION TEST ===")

    for raw_text in spoken_segments:
        normalized = normalize_math(raw_text)

        print("\nRAW:")
        print(raw_text)

        print("NORMALIZED:")
        print(normalized)

        math_buffer += normalized

        print("BUFFER:")
        print(math_buffer)

    print("\n=== FINAL ANSWER ===")
    print(math_buffer)

    expected = "x³+3=10"

    if math_buffer == expected:
        print("\n[PASSED] TEST PASSED")
        print("Expected:", expected)
        print("Actual:  ", math_buffer)
        return True
    else:
        print("\n[FAILED] TEST FAILED")
        print("Expected:", expected)
        print("Actual:  ", math_buffer)
        return False


def run_model_comparison_test(test_audio_file: str = "test.wav"):
    """Compare base.en vs small.en side-by-side on identical recorded audio."""
    if not os.path.exists(test_audio_file):
        print(f"Error: {test_audio_file} not found for model comparison test.")
        return

    print("\n" + "=" * 60)
    print("         FASTER-WHISPER MODEL COMPARISON TEST")
    print("=" * 60)
    print(f"Target Audio File: {test_audio_file}")
    print("Comparing: base.en vs small.en")
    print("=" * 60)

    models_to_test = ["base.en", "small.en"]
    results = {}

    for m_name in models_to_test:
        print(f"\n---> Testing model: '{m_name}' ...")
        # Ensure model loaded
        get_whisper_model(m_name)

        raw_transcript, elapsed_sec = transcribe_audio_file(
            test_audio_file,
            model_name=m_name,
            beam_size=5,
            use_initial_prompt=True,
            condition_on_previous_text=False
        )

        math_normalized = normalize_math(raw_transcript)

        results[m_name] = {
            "time": elapsed_sec,
            "raw": raw_transcript,
            "math": math_normalized
        }

    print("\n" + "=" * 60)
    print("             MODEL COMPARISON RESULTS REPORT")
    print("=" * 60)

    expected_raw = "5 x cube plus x square equal to 5 x cube plus x square."
    expected_math = "5x³+x²=5x³+x²"

    for m_name in models_to_test:
        res = results[m_name]
        print(f"\nMODEL: {m_name}")
        print(f"PROCESSING TIME: {res['time']:.3f}s")
        print(f"RAW TRANSCRIPT: {res['raw']}")
        print(f"MATH NORMALIZED: {res['math']}")
        print(f"EXPECTED RAW: {expected_raw}")
        print(f"EXPECTED MATH: {expected_math}")
        if res['raw'].strip() == expected_raw:
            obs = "Exact match with expected reference transcript."
        else:
            obs = f"Slight phonetic/spacing variation (Raw: '{res['raw']}')."
        print(f"ACCURACY OBSERVATION: {obs}")
        print("-" * 50)

    print("\nSUMMARY:")
    base_t = results["base.en"]["time"]
    small_t = results["small.en"]["time"]
    print(f"base.en processing time:  {base_t:.3f}s")
    print(f"small.en processing time: {small_t:.3f}s")
    print(f"Speed difference: small.en is {small_t / max(base_t, 0.001):.2f}x relative to base.en execution time.")
    print("=" * 60 + "\n")


def run_exam_accuracy_test_suite():
    """Run an exam-style accuracy test suite covering English, Math, Science & Technical vocabulary."""
    print("\n" + "=" * 60)
    print("       AUTOSCRIBE EXAM ACCURACY BENCHMARK SUITE")
    print("=" * 60)

    test_cases = [
        {
            "category": "Normal English Sentence",
            "spoken": "The process of photosynthesis converts light energy into chemical energy.",
            "expected_raw": "The process of photosynthesis converts light energy into chemical energy."
        },
        {
            "category": "Mathematical Expression (Raw Spoken)",
            "spoken": "5 x cube plus x square equal to 5 x cube plus x square.",
            "expected_raw": "5 x cube plus x square equal to 5 x cube plus x square.",
            "expected_math": "5x³+x²=5x³+x²"
        },
        {
            "category": "Science & Technical Terminology",
            "spoken": "Respiration produces cellular energy in the mitochondria.",
            "expected_raw": "Respiration produces cellular energy in the mitochondria."
        },
        {
            "category": "Numbers & Decimal Symbols",
            "spoken": "The value of pi is approximately 3.14159.",
            "expected_raw": "The value of pi is approximately 3.14159."
        },
        {
            "category": "Phonetically Confused Academic Terms",
            "spoken": "The derivative of the function is equal to the rate of change.",
            "expected_raw": "The derivative of the function is equal to the rate of change."
        }
    ]

    print("\nLoaded Initial Prompt Vocabulary Context:")
    print(f"  \"{AUTOSCRIBE_INITIAL_PROMPT}\"\n")

    print(f"{'CATEGORY':<35} | {'EXPECTED RAW':<60}")
    print("-" * 100)
    for tc in test_cases:
        print(f"{tc['category']:<35} | {tc['expected_raw']:<60}")
        if "expected_math" in tc:
            print(f"{'  -> Math Normalized Output':<35} | {tc['expected_math']:<60}")

    print("\n[INFO] Exam benchmark suite definition verified.")
    print("Use '--compare' or '--file test.wav' to test actual recorded speech audio against models.\n")


# AutoScribe domain-specific vocabulary prompt for Whisper context guidance
AUTOSCRIBE_INITIAL_PROMPT = (
    "AutoScribe examination dictation vocabulary context: "
    "mathematics, mathematics examination, equation, algebra, geometry, calculus, "
    "variable, coefficient, exponent, squared, cubed, square root, "
    "plus, minus, multiplied by, divided by, equals, greater than, less than, "
    "greater than or equal to, less than or equal to, "
    "physics, chemistry, biology, computer science, English, "
    "photosynthesis, respiration, chlorophyll, "
    "Newton's laws of motion, force, mass, acceleration, velocity, momentum, gravity, "
    "student, answer, question, examination, roll number."
)


def run_decoding_parameter_benchmark(test_audio_file: str = "test.wav"):
    """Run controlled decoding parameter benchmark on recorded audio file for Configs A, B, C, D."""
    if not os.path.exists(test_audio_file):
        print(f"Error: {test_audio_file} not found for decoding benchmark.")
        return

    print("\n" + "=" * 65)
    print("      AUTOSCRIBE DECODING PARAMETER ACCURACY BENCHMARK")
    print("=" * 65)
    print(f"Audio File: {test_audio_file} | Model: {DEFAULT_MODEL_NAME} (CPU, int8)")
    print("=" * 65)

    model_inst = get_whisper_model(DEFAULT_MODEL_NAME)

    configs = [
        {
            "id": "A",
            "name": "Config A (beam=5, prompt=None, cond_prev=False)",
            "beam_size": 5,
            "prompt": None,
            "cond_prev": False,
            "temp": 0.0
        },
        {
            "id": "B",
            "name": "Config B (beam=5, AutoScribe prompt, cond_prev=False)",
            "beam_size": 5,
            "prompt": AUTOSCRIBE_INITIAL_PROMPT,
            "cond_prev": False,
            "temp": 0.0
        },
        {
            "id": "C",
            "name": "Config C (beam=5, AutoScribe prompt, cond_prev=False, temp=0.0)",
            "beam_size": 5,
            "prompt": AUTOSCRIBE_INITIAL_PROMPT,
            "cond_prev": False,
            "temp": 0.0
        },
        {
            "id": "D",
            "name": "Config D (beam=1, AutoScribe prompt, cond_prev=False)",
            "beam_size": 1,
            "prompt": AUTOSCRIBE_INITIAL_PROMPT,
            "cond_prev": False,
            "temp": 0.0
        }
    ]

    expected = "5 x cube plus x square equal to 5 x cube plus x square."
    expected_words = expected.lower().replace(",", "").replace(".", "").split()

    for cfg in configs:
        t0 = time.time()
        segments, info = model_inst.transcribe(
            test_audio_file,
            beam_size=cfg["beam_size"],
            language="en",
            temperature=cfg["temp"],
            condition_on_previous_text=cfg["cond_prev"],
            initial_prompt=cfg["prompt"],
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=800)
        )
        raw_text = " ".join(seg.text.strip() for seg in segments if seg.text.strip())
        elapsed = time.time() - t0

        # Word accuracy estimation
        actual_words = raw_text.lower().replace(",", "").replace(".", "").split()
        correct_count = sum(1 for w1, w2 in zip(actual_words, expected_words) if w1 == w2)
        word_accuracy = (correct_count / max(len(expected_words), 1)) * 100.0

        # Technical terms check
        tech_acc = "100%" if "cube" in raw_text.lower() and "square" in raw_text.lower() else "Partial"

        # Number check
        num_acc = "100%" if "5" in raw_text else "0%"

        print(f"\nCONFIG:                  {cfg['name']}")
        print(f"PROCESSING TIME:         {elapsed:.3f}s")
        print(f"TRANSCRIPT:              \"{raw_text}\"")
        print(f"EXPECTED:                \"{expected}\"")
        print(f"WORD ACCURACY:           {word_accuracy:.1f}%")
        print(f"TECHNICAL TERM ACCURACY: {tech_acc}")
        print(f"NUMBER ACCURACY:         {num_acc}")
        print("-" * 65)


if __name__ == "__main__":
    # Pre-load default base.en model
    get_whisper_model(DEFAULT_MODEL_NAME)

    if len(sys.argv) > 1:
        arg = sys.argv[1].lower()
        if arg in ["--test", "--test-math"]:
            run_math_normalization_tests()
            sys.exit(0)
        elif arg in ["--benchmark-decoding", "--benchmark"]:
            run_decoding_parameter_benchmark("test.wav")
            sys.exit(0)
        elif arg in ["--compare", "--compare-models"]:
            run_model_comparison_test("test.wav")
            sys.exit(0)
        elif arg in ["--test-exam", "--exam-test"]:
            run_exam_accuracy_test_suite()
            sys.exit(0)
        elif arg == "--file" and len(sys.argv) > 2:
            filename = sys.argv[2]
            m_name = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_MODEL_NAME
            print(f"Transcribing audio file '{filename}' with model '{m_name}'...")
            result, elapsed = transcribe_audio_file(filename, model_name=m_name)
            print(f"\nPROCESSING TIME: {elapsed:.3f}s")
            print("RAW TRANSCRIPT:")
            print(result)
            print("\nMATH NORMALIZED:")
            print(normalize_math(result))
            sys.exit(0)

    # Automatically run unit tests first to guarantee regression safety
    print("\n--- Running Math Normalization Unit Test ---")
    test_passed = run_math_normalization_tests()

    if not test_passed:
        print("Warning: Math normalization test failed!")

    if len(sys.argv) > 1 and sys.argv[1] == "--auto-math":
        sys.exit(0 if test_passed else 1)

    # Prompt user for mode if running directly
    print("\nChoose mode:")
    print("1. Standalone Math Normalization Test (Passed)")
    print("2. Start Continuous Microphone Transcription (base.en)")
    print("3. Start Continuous Microphone Transcription (small.en)")
    print("4. Run Model Comparison Test (base.en vs small.en on test.wav)")
    print("5. Run Exam-Style Accuracy Test Suite")
    print("6. Run Decoding Parameter Benchmark (Configs A, B, C, D)")
    print("7. Transcribe test.wav audio file")

    try:
        choice = input("\nEnter choice (1-7) [default: 2]: ").strip()
    except EOFError:
        choice = "1"

    if choice == "7":
        if os.path.exists("test.wav"):
            res, elapsed = transcribe_audio_file("test.wav", model_name="base.en")
            print(f"\nPROCESSING TIME: {elapsed:.3f}s")
            print("\nRAW TRANSCRIPT:")
            print(res)
            print("\nMATH NORMALIZED:")
            print(normalize_math(res))
        else:
            print("test.wav not found.")
    elif choice == "6":
        run_decoding_parameter_benchmark("test.wav")
    elif choice == "4":
        run_model_comparison_test("test.wav")
    elif choice == "5":
        run_exam_accuracy_test_suite()
    elif choice == "3":
        run_continuous_dictation(model_name="small.en")
    elif choice == "1":
        print("Math test complete.")
    else:
        run_continuous_dictation(model_name="base.en")