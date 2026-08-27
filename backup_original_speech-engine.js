/**
 * AutoScribe - AI Voice & Speech Engine with Sarvam AI Text-to-Speech (bulbul:v3)
 * 
 * TTS Architecture:
 * speakText(text, gender, speed)
 *   ↓
 * Sarvam AI Cloud TTS API (POST /api/tts)
 *   ↓
 * Audio Response (Base64)
 *   ↓
 * HTML5 Audio Player (new Audio)
 * 
 * Browser SpeechSynthesis is DISABLED.
 * webkitSpeechRecognition is KEPT INTACT for student voice dictation (en-IN).
 */

window.AutoScribeSpeech = {
  recognition: null,
  synth: window.speechSynthesis,
  isListening: false,
  autoListenMode: true,
  onTranscriptCallback: null,
  onCommandCallback: null,
  speechActive: false,
  audioCtx: null,
  currentAudioPlayer: null,
  ttsAbortController: null,
  ttsRequestId: 0,
  voices: [],

  normalizeTranscript(text) {
    if (!text) return '';
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  },

  init() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.error("AutoScribe: Web Speech API Recognition is not supported in this browser. Please use Chrome or Edge.");
      return false;
    }

    if (this.synth) {
      this.loadVoices();
      if (typeof this.synth.onvoiceschanged !== 'undefined') {
        this.synth.onvoiceschanged = () => this.loadVoices();
      }
    }

    if (this.recognition) return true;

    // Speech-to-Text Recognition Singleton instance for Student Voice Dictation (en-IN)
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-IN';

    this.recognition.onresult = (event) => {
      // Discard recognition results while TTS is speaking to prevent loopback / self-listening
      if (this.speechActive || (this.synth && this.synth.speaking)) {
        console.log("[AutoScribe SpeechEngine] Discarded STT input during active TTS playback.");
        return;
      }

      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }

      if (interimTranscript) {
        console.log("[AutoScribe SpeechEngine] interim transcript:", interimTranscript);
      }
      if (finalTranscript) {
        console.log("[AutoScribe SpeechEngine] final transcript:", finalTranscript);
      }

      const heardText = (finalTranscript || interimTranscript).trim();
      if (!heardText) return;

      const isLoginPage = window.location.pathname.endsWith('login.html') || window.location.href.includes('login.html');

      // Filter out TTS speaker echo / system prompt loopback
      const isSpeakerEcho = /\b(can i read the question|once again or will you write|please say read again|please say your answer|if you want to change it say change|otherwise say no changes|can i read your answer|can i start this|exam or move to the next subject)\b/i.test(heardText);
      if (isSpeakerEcho) {
        console.warn("[AutoScribe SpeechEngine] Ignored speaker echo loopback:", heardText);
        return;
      }

      this.updateVoiceLogDisplay(heardText, finalTranscript ? 'final' : 'interim');

      // Only parse global/navigation or exam voice commands when NOT on login page
      if (!isLoginPage) {
        const currentState = window.AutoScribeExamSession ? (window.AutoScribeExamSession.questionState || window.AutoScribeExamSession.mathState || 'IDLE') : 'IDLE';

        const isAnswerMode = window.AutoScribeExamSession && (
          window.AutoScribeExamSession.answerMode || 
          window.AutoScribeExamSession.waitingForAnswer ||
          currentState === 'WRITE_MODE' ||
          currentState === 'RECORDING_ANSWER' ||
          currentState === 'MATH_RECORDING_ANSWER'
        );

        const isDecisionState = window.AutoScribeExamSession && (
          window.AutoScribeExamSession.questionState === 'AWAITING_READ_WRITE' ||
          window.AutoScribeExamSession.questionState === 'AWAITING_CONFIRMATION' ||
          window.AutoScribeExamSession.reviewState !== 'IDLE'
        );

        if (!isAnswerMode && !isDecisionState) {
          const globalCmd = this.parseGlobalCommands(heardText);
          if (globalCmd) return;

          const examCmd = this.parseVoiceCommands(heardText);
          if (examCmd) return;
        }
      }

      if (this.onTranscriptCallback) {
        if (this.isRollMode) {
          if (finalTranscript) {
            this.stopListening();
            const cleanedRoll = this.normalizeRollNumber(finalTranscript);
            console.log("[AutoScribe SpeechEngine] Roll Number Captured (Final):", cleanedRoll);
            this.onTranscriptCallback(cleanedRoll, true);
          }
        } else {
          if (finalTranscript) {
            console.log("[AutoScribe SpeechEngine] Dispatching final transcript to onTranscriptCallback:", finalTranscript);
            this.onTranscriptCallback(finalTranscript, true);
          } else if (interimTranscript) {
            console.log("[AutoScribe SpeechEngine] Dispatching interim transcript to onTranscriptCallback:", interimTranscript);
            this.onTranscriptCallback(interimTranscript, false);
          }
        }
      }     
    };


    this.recognition.onerror = (event) => {
      console.warn("AutoScribe Speech Warning:", event.error);
      if (event.error === 'not-allowed') {
        this.updateVoiceLogDisplay("Mic access blocked. Tap anywhere to grant mic access.", 'error');
      }
    };

    this.recognition.onend = () => {
      const isLoginPage = window.location.pathname.endsWith('login.html') || window.location.href.includes('login.html');
      if (!isLoginPage && this.autoListenMode && !this.speechActive) {
        setTimeout(() => {
          try {
            if (!this.speechActive && this.recognition) {
              this.recognition.start();
            }
          } catch (e) {}
        }, 250);
      }
    };

    return true;
  },

  loadVoices() {
    if (this.synth) {
      this.voices = this.synth.getVoices() || [];
    }
  },

  getBestVoice(gender = 'male') {
    if (!this.voices || this.voices.length === 0) {
      this.loadVoices();
    }
    const voices = this.voices || [];
    if (voices.length === 0) return null;

    const targetGender = String(gender).toLowerCase();
    
    // 1. Prefer en-IN voices
    const enInVoices = voices.filter(v => {
      const lang = (v.lang || '').replace('_', '-').toLowerCase();
      return lang === 'en-in';
    });

    if (enInVoices.length > 0) {
      if (targetGender === 'female') {
        const femaleVoice = enInVoices.find(v => /\b(female|veena|neerja|heera|zira|google)\b/i.test(v.name));
        if (femaleVoice) return femaleVoice;
      } else if (targetGender === 'male') {
        const maleVoice = enInVoices.find(v => /\b(male|rishi|prabhat|david|mark|google)\b/i.test(v.name));
        if (maleVoice) return maleVoice;
      }
      return enInVoices[0];
    }

    // 2. Fallback to any English voice
    const enVoices = voices.filter(v => (v.lang || '').toLowerCase().startsWith('en'));
    if (enVoices.length > 0) {
      if (targetGender === 'female') {
        const femaleEn = enVoices.find(v => /\b(female|zira|samantha|victoria|karen|google)\b/i.test(v.name));
        if (femaleEn) return femaleEn;
      } else if (targetGender === 'male') {
        const maleEn = enVoices.find(v => /\b(male|david|alex|daniel|george|google)\b/i.test(v.name));
        if (maleEn) return maleEn;
      }
      return enVoices[0];
    }

    return null;
  },

  /**
   * Primary Web SpeechSynthesis Text-to-Speech Function
   */
  speakText(text, gender = 'male', speed = '1.0', onEndCallback = null) {
    if (typeof speed === 'function') {
      onEndCallback = speed;
      speed = '1.0';
    }

    this.stopSpeaking();
    this.speechActive = true;

    // Pause speech recognition while TTS audio plays to prevent audio loopback
    if (this.recognition) {
      try { this.recognition.stop(); } catch (e) {}
    }

    if (!('speechSynthesis' in window)) {
      console.warn("AutoScribe: SpeechSynthesis is not supported in this browser.");
      this.speechActive = false;
      if (onEndCallback) onEndCallback();
      return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    
    // Select best voice (en-IN first, then English fallback)
    const voice = this.getBestVoice(gender);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = 'en-IN';
    }

    // Set rate
    const parsedSpeed = parseFloat(speed) || 1.0;
    utterance.rate = Math.max(0.5, Math.min(2.0, parsedSpeed));

    let completed = false;
    const finishSpeech = () => {
      if (completed) return;
      completed = true;

      // 400ms squelch buffer before microphone reactivates
      setTimeout(() => {
        this.speechActive = false;
        if (onEndCallback) {
          onEndCallback();
        } else if (this.autoListenMode && this.isListening) {
          this.startListening();
        }
      }, 400);
    };

    utterance.onend = finishSpeech;
    utterance.onerror = (e) => {
      console.warn("SpeechSynthesis Error:", e);
      finishSpeech();
    };

    try {
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.error("SpeechSynthesis Exception:", err);
      finishSpeech();
    }
  },

  /**
   * Browser SpeechSynthesis Fallback alias
   */
  speakTextFallback(text, speed = '1.0', onEndCallback = null) {
    this.speakText(text, 'male', speed, onEndCallback);
  },

  /**
   * Legacy audio player method (kept intact for compatibility)
   */
  playSarvamAudio(base64Audio, onEndCallback = null, reqId = null) {
    this.speechActive = false;
    if (onEndCallback) onEndCallback();
  },

  showAutoplayBanner(onActivate) {
    let banner = document.getElementById('autoplayBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'autoplayBanner';
      banner.style.position = 'fixed';
      banner.style.bottom = '20px';
      banner.style.left = '50%';
      banner.style.transform = 'translateX(-50%)';
      banner.style.backgroundColor = 'var(--accent-gold, #f59e0b)';
      banner.style.color = '#000';
      banner.style.padding = '0.85rem 1.75rem';
      banner.style.borderRadius = '12px';
      banner.style.fontSize = '1.15rem';
      banner.style.fontWeight = 'bold';
      banner.style.zIndex = '99999';
      banner.style.cursor = 'pointer';
      banner.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';
      banner.style.border = '2px solid #ffffff';
      banner.innerHTML = '🔊 Click or Tap anywhere to activate Voice Assistant';
      document.body.appendChild(banner);
    }
    banner.style.display = 'block';

    const handler = () => {
      banner.style.display = 'none';
      document.removeEventListener('click', handler);
      document.removeEventListener('keydown', handler);
      this.getAudioContext();
      if (onActivate) onActivate();
    };

    banner.addEventListener('click', handler, { once: true });
    document.addEventListener('click', handler, { once: true });
    document.addEventListener('keydown', handler, { once: true });
  },

  /**
   * Accessible Error Handling
   */
  handleSarvamError(message, setupRequired = false) {
    this.speechActive = false;
    console.warn("AutoScribe TTS Notice:", message);
    if (this.autoListenMode) {
      setTimeout(() => this.startListening(), 400);
    }
  },

  showAccessibleToast(msg) {
    let toast = document.getElementById('accessibleToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'accessibleToast';
      toast.setAttribute('role', 'alert');
      toast.setAttribute('aria-live', 'assertive');
      toast.style.position = 'fixed';
      toast.style.bottom = '20px';
      toast.style.right = '20px';
      toast.style.backgroundColor = 'var(--accent-red)';
      toast.style.color = '#ffffff';
      toast.style.padding = '1rem 1.5rem';
      toast.style.borderRadius = '8px';
      toast.style.fontWeight = '700';
      toast.style.zIndex = '10000';
      toast.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 8000);
  },

  speak(text, onEndCallback = null) {
    const user = AutoScribeApp ? AutoScribeApp.currentUser : null;
    const speedStr = (user && user.speed) ? user.speed : (localStorage.getItem('autoscribe_voice_speed') || '1.0');
    const genderStr = (user && user.gender) ? user.gender : (localStorage.getItem('autoscribe_voice_gender') || 'male');

    this.speakText(text, genderStr, speedStr, onEndCallback);
  },

  stopSpeaking() {
    if (this.ttsAbortController) {
      try { this.ttsAbortController.abort(); } catch (e) {}
      this.ttsAbortController = null;
    }
    if (this.currentAudioPlayer) {
      try {
        this.currentAudioPlayer.onended = null;
        this.currentAudioPlayer.onerror = null;
        this.currentAudioPlayer.pause();
        this.currentAudioPlayer.currentTime = 0;
        this.currentAudioPlayer.src = '';
      } catch (e) {}
      this.currentAudioPlayer = null;
    }
    this.speechActive = false;
  },

  getAudioContext() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  },

  playChime(type = 'listen') {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'listen') {
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
      } else if (type === 'confirm') {
        osc.frequency.setValueAtTime(523.25, ctx.currentTime);
        osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      } else if (type === 'pause') {
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      }
    } catch (e) {}
  },

  updateVoiceLogDisplay(msg, state = 'info') {
    const statusText = document.getElementById('speechStatusText');
    if (statusText) {
      if (state === 'final') {
        statusText.innerHTML = `🗣️ Heard: <strong>"${msg}"</strong>`;
      } else if (state === 'interim') {
        statusText.innerHTML = `🎧 Listening... <em>"${msg}"</em>`;
      } else {
        statusText.textContent = msg;
      }
    }
  },

  startListening(onTranscript = null, onCommand = null, opts = {}) {
    if (!this.recognition) this.init();
    if (onTranscript) this.onTranscriptCallback = onTranscript;
    this.onCommandCallback = onCommand || null;

    this.isListening = true;
    this.autoListenMode = true;
    this.isRollMode = !!(opts && opts.isRollMode);

    if (this.recognition) {
      this.recognition.lang = (opts && opts.lang) || 'en-IN';
      this.recognition.continuous = (opts && opts.continuous !== undefined) ? opts.continuous : (this.isRollMode ? false : true);
      this.recognition.interimResults = (opts && opts.interimResults !== undefined) ? opts.interimResults : (this.isRollMode ? false : true);
    }

    if (this.speechActive) {
      console.log("AutoScribe: Speech output currently active; postponing recognition start.");
      return;
    }

    try {
      this.recognition.stop();
    } catch (e) {}

    setTimeout(() => {
      try {
        if (this.isListening && !this.speechActive && this.recognition) {
          this.recognition.start();
          console.log("[AutoScribe SpeechEngine] recognition started. Lang:", this.recognition.lang);
          this.playChime('listen');
          const statusDot = document.getElementById('statusDot');

          if (statusDot) statusDot.classList.add('active');
        }
      } catch (e) {
        console.warn("AutoScribe SpeechRecognition start tick:", e);
      }
    }, 80);
  },

  stopListening() {
    this.isListening = false;
    this.autoListenMode = false;
    if (this.recognition) {
      try {
        this.recognition.stop();
        this.playChime('pause');
        const statusDot = document.getElementById('statusDot');
        if (statusDot) statusDot.classList.remove('active');
      } catch (e) {}
    }
  },


  normalizeText(text) {
    if (!text) return '';
    let result = text.trim();
    result = result
      .replace(/\bblank\s+space\b/gi, ' ')
      .replace(/\bspace\s+character\b/gi, ' ')
      .replace(/\bspace\b/gi, ' ')
      .replace(/\bperiod\b/gi, '.')
      .replace(/\bfull stop\b/gi, '.')
      .replace(/\bcomma\b/gi, ',')
      .replace(/\bquestion mark\b/gi, '?')
      .replace(/\bexclamation mark\b/gi, '!')
      .replace(/\bnew line\b/gi, '\n')
      .replace(/\bnew paragraph\b/gi, '\n\n')
      .replace(/[ \t]+/g, ' ');

    result = result.replace(/(^\s*|[.!?]\s+)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
    return result;
  },

  normalizeRollNumber(text) {
    if (!text) return '';
    let str = String(text).trim();
    if (!str) return '';

    // 1. Strip preamble phrases (e.g. "my roll number is", "student id is", "roll number")
    str = str.replace(/^(my\s+)?(roll\s+number|registration\s+id|student\s+id|id|number)(\s+is)?\s*/i, '');
    str = str.replace(/^(it\s+is|is)\s*/i, '');

    // 2. Map spoken punctuation words
    str = str.replace(/\b(dash|hyphen|minus)\b/gi, '-');
    str = str.replace(/\b(slash)\b/gi, '/');
    str = str.replace(/\b(dot|period|full\s+stop)\b/gi, '');
    str = str.replace(/\b(blank\s+space|space\s+character|space)\b/gi, '');
    str = str.replace(/[,.!?]/g, '');

    // 3. Map STT phonetic letter representations
    const letterPhoneticMap = {
      'double you': 'W', 'double-you': 'W', 'doubleyou': 'W',
      'ay': 'A', 'bee': 'B', 'see': 'C', 'sea': 'C', 'dee': 'D',
      'ee': 'E', 'eff': 'F', 'gee': 'G', 'aitch': 'H', 'eye': 'I',
      'jay': 'J', 'kay': 'K', 'el': 'L', 'em': 'M', 'en': 'N',
      'oh': 'O', 'pee': 'P', 'cue': 'Q', 'queue': 'Q', 'are': 'R',
      'ess': 'S', 'tee': 'T', 'you': 'U', 'vee': 'V', 'ex': 'X',
      'why': 'Y', 'zee': 'Z', 'zed': 'Z'
    };

    for (const [phonetic, letter] of Object.entries(letterPhoneticMap)) {
      const regex = new RegExp(`\\b${phonetic}\\b`, 'gi');
      str = str.replace(regex, letter);
    }

    // 4. Map spoken compound tens and teens to digits
    const compoundTensMap = {
      'twenty one': '21', 'twenty two': '22', 'twenty three': '23', 'twenty four': '24', 'twenty five': '25',
      'twenty six': '26', 'twenty seven': '27', 'twenty eight': '28', 'twenty nine': '29',
      'thirty one': '31', 'thirty two': '32', 'thirty three': '33', 'thirty four': '34', 'thirty five': '35',
      'thirty six': '36', 'thirty seven': '37', 'thirty eight': '38', 'thirty nine': '39',
      'forty one': '41', 'forty two': '42', 'forty three': '43', 'forty four': '44', 'forty five': '45',
      'forty six': '46', 'forty seven': '47', 'forty eight': '48', 'forty nine': '49',
      'fifty one': '51', 'fifty two': '52', 'fifty three': '53', 'fifty four': '54', 'fifty five': '55',
      'fifty six': '56', 'fifty seven': '57', 'fifty eight': '58', 'fifty nine': '59',
      'sixty one': '61', 'sixty two': '62', 'sixty three': '63', 'sixty four': '64', 'sixty five': '65',
      'sixty six': '66', 'sixty seven': '67', 'sixty eight': '68', 'sixty nine': '69',
      'seventy one': '71', 'seventy two': '72', 'seventy three': '73', 'seventy four': '74', 'seventy five': '75',
      'seventy six': '76', 'seventy seven': '77', 'seventy eight': '78', 'seventy nine': '79',
      'eighty one': '81', 'eighty two': '82', 'eighty three': '83', 'eighty four': '84', 'eighty five': '85',
      'eighty six': '86', 'eighty seven': '87', 'eighty eight': '88', 'eighty nine': '89',
      'ninety one': '91', 'ninety two': '92', 'ninety three': '93', 'ninety four': '94', 'ninety five': '95',
      'ninety six': '96', 'ninety seven': '97', 'ninety eight': '98', 'ninety nine': '99',
      'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13', 'fourteen': '14', 'fifteen': '15',
      'sixteen': '16', 'seventeen': '17', 'eighteen': '18', 'nineteen': '19',
      'twenty': '20', 'thirty': '30', 'forty': '40', 'fifty': '50', 'sixty': '60', 'seventy': '70', 'eighty': '80', 'ninety': '90'
    };

    for (const [phrase, num] of Object.entries(compoundTensMap)) {
      const regex = new RegExp(`\\b${phrase}\\b`, 'gi');
      str = str.replace(regex, num);
    }

    // 5. Map single digit words
    const numMap = {
      'zero': '0', 'oh': '0', 'null': '0',
      'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
      'six': '6', 'seven': '7', 'eight': '8', 'nine': '9'
    };

    str = str.replace(/\b(zero|oh|null|one|two|three|four|five|six|seven|eight|nine)\b/gi, (m) => numMap[m.toLowerCase()] || m);

    // 6. Remove all internal whitespace to preserve complete alphanumeric sequence
    // (e.g. "25 ISR 023" -> "25ISR023", "two five I S R 0 2 3" -> "25ISR023")
    str = str.replace(/\s+/g, '');

    return str.toUpperCase();
  },

  parseSpokenRollNumber(text) {
    return this.normalizeRollNumber(text);
  },

  parseSpokenNameOrSpelling(text) {
    if (!text) return '';
    let str = text.trim();

    // Standardize spoken space tokens to a placeholder token
    str = str.replace(/\b(blank\s+space|space\s+character|space)\b/gi, ' __SPACE__ ');
    str = str.replace(/[,.!?]/g, ' ');

    const tokens = str.split(/\s+/).filter(t => t.length > 0);
    let words = [];
    let currentLetters = '';

    for (const token of tokens) {
      if (token === '__SPACE__') {
        if (currentLetters) {
          words.push(currentLetters);
          currentLetters = '';
        }
      } else if (token.length === 1 && /[a-zA-Z]/.test(token)) {
        currentLetters += token;
      } else {
        if (currentLetters) {
          words.push(currentLetters);
          currentLetters = '';
        }
        words.push(token);
      }
    }
    if (currentLetters) {
      words.push(currentLetters);
    }

    const formatted = words.join(' ').replace(/\s+/g, ' ').trim();
    return formatted.split(' ').map(w => {
      if (!w) return '';
      if (w.length === 1) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
  },

  normalizeFullName(text) {
    if (!text) return '';
    let str = text.trim();

    // Strip preamble phrases
    str = str.replace(/^(my\s+)?(full\s+)?name\s+(is\s+)?/i, '');
    str = str.replace(/^i\s+am\s+/i, '');

    // Convert spoken "space", "blank space", or "space character" into ONE real space
    str = str.replace(/\bblank\s+space\b/gi, ' ');
    str = str.replace(/\bspace\s+character\b/gi, ' ');
    str = str.replace(/\bspace\b/gi, ' ');

    // Remove accidentally inserted commas, periods, full stops, and question/exclamation marks
    str = str.replace(/[,.!?]/g, '');

    // Collapse multiple spaces
    str = str.replace(/\s+/g, ' ').trim();

    return str.split(' ').map(w => {
      if (!w) return '';
      if (w.length === 1) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  },

  parseSpellingName(text) {
    if (!text) return '';
    let str = text.trim();

    // Replace punctuation with space
    str = str.replace(/[,.!?]/g, ' ');

    // Standardize spoken space tokens to a placeholder token
    str = str.replace(/\b(blank\s+space|space\s+character|space)\b/gi, ' __SPACE__ ');

    // Map spoken numbers
    const numMap = {
      'zero': '0', 'oh': '0', 'null': '0',
      'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
      'six': '6', 'seven': '7', 'eight': '8', 'nine': '9'
    };
    str = str.replace(/\b(zero|oh|null|one|two|three|four|five|six|seven|eight|nine)\b/gi, (m) => numMap[m.toLowerCase()] || m);

    const tokens = str.split(/\s+/).filter(t => t.length > 0);
    let result = '';

    for (const token of tokens) {
      if (token === '__SPACE__') {
        result += ' ';
      } else {
        result += token;
      }
    }

    // Strip any remaining punctuation
    result = result.replace(/[,.!?]/g, '');
    result = result.replace(/\s+/g, ' ').trim();

    return result.toUpperCase();
  },

  parseSpellingRollNumber(text) {
    if (!text) return '';
    let str = text.trim().toLowerCase();

    // Map spoken dash/hyphen/slash
    str = str.replace(/\b(dash|hyphen|minus)\b/gi, '-');
    str = str.replace(/\b(slash)\b/gi, '/');

    // Replace punctuation with space
    str = str.replace(/[,.!?]/g, ' ');

    // Ignore spoken spaces for roll numbers
    str = str.replace(/\b(blank\s+space|space\s+character|space)\b/gi, '');

    // Map spoken numbers
    const numMap = {
      'zero': '0', 'oh': '0', 'null': '0',
      'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
      'six': '6', 'seven': '7', 'eight': '8', 'nine': '9'
    };
    str = str.replace(/\b(zero|oh|null|one|two|three|four|five|six|seven|eight|nine)\b/gi, (m) => numMap[m.toLowerCase()] || m);

    // Remove all whitespace
    str = str.replace(/\s+/g, '');

    // Strip punctuation
    str = str.replace(/[,.!?]/g, '');

    return str.toUpperCase();
  },

  formatSpellingForReadback(value, isName = true) {
    if (!value) return '';
    const chars = value.split('');
    const parts = [];

    for (const char of chars) {
      if (char === ' ') {
        if (isName) {
          parts.push('space');
        }
      } else {
        parts.push(char);
      }
    }

    if (isName) {
      return parts.map(p => p === 'space' ? ', space, ' : p).join(' ').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
    } else {
      return parts.join(' ');
    }
  },

  parseGlobalCommands(rawText) {
    const isLoginPage = window.location.pathname.endsWith('login.html') || window.location.href.includes('login.html');
    if (isLoginPage) return false;

    const text = rawText.toLowerCase().trim();

    // Login voice command patterns
    if (/\b(login|log in|student login|open login|go to login|sign in)\b/i.test(text)) {
      this.playChime('confirm');
      if (window.AutoScribeApp && typeof window.AutoScribeApp.navigateToLogin === 'function') {
        window.AutoScribeApp.navigateToLogin();
      } else {
        this.speak("Opening student login.", () => {
          window.location.href = 'login.html';
        });
      }
      return true;
    }

    if (/\b(go to dashboard|dashboard page|exam list|dashboard)\b/i.test(text)) {
      this.playChime('confirm');
      this.speak("Opening dashboard.", () => {
        window.location.href = 'dashboard.html';
      });
      return true;
    }

    // Start Exam voice command patterns
    if (/\b(start exam|begin exam|open exam|launch exam)\b/i.test(text)) {
      this.playChime('confirm');
      if (window.AutoScribeApp && typeof window.AutoScribeApp.navigateToExam === 'function') {
        window.AutoScribeApp.navigateToExam();
      } else {
        this.speak("Starting exam.", () => {
          window.location.href = 'exam.html';
        });
      }
      return true;
    }

    if (/\b(high contrast|toggle contrast)\b/i.test(text)) {
      if (window.AutoScribeApp) AutoScribeApp.toggleHighContrast();
      return true;
    }

    if (/\b(help|voice guide|what can i say)\b/i.test(text)) {
      this.speak("Commands: Read question, Start answer, Read answer, Next question, Previous question, and Submit exam.");
      return true;
    }

    return false;
  },

  parseVoiceCommands(rawText) {
    const isExamPage = window.location.pathname.endsWith('exam.html') || window.location.href.includes('exam.html');
    if (!isExamPage) return false;

    const text = rawText.toLowerCase().trim();

    const commandPatterns = [
      { pattern: /\b(change\s+(an\s+)?answer|review\s+(an\s+)?answer|want\s+to\s+change|want\s+to\s+review|modify\s+(an\s+)?answer|edit\s+(an\s+)?answer)\b/, action: "CHANGE_ANSWER" },
      { pattern: /\b(next question|next|go to next question|move forward|forward)\b/, action: "NEXT_QUESTION" },
      { pattern: /\b(previous question|previous|prev question|go to previous question|go back|back)\b/, action: "PREV_QUESTION" },
      { pattern: /\b(confirm submit|yes submit|submit now|yes confirm)\b/, action: "CONFIRM_SUBMIT" },
      { pattern: /\b(submit exam|submit answers|finish exam|end exam)\b/, action: "SUBMIT_EXAM" },
      { pattern: /\b(read my answer|read answer|read back answer|check my answer|review answer)\b/, action: "READ_ANSWER" },
      { pattern: /\b(delete last sentence|delete sentence|undo sentence|remove last sentence|delete line)\b/, action: "DELETE_SENTENCE" },
      { pattern: /\b(clear answer|clear text|erase answer|delete all)\b/, action: "CLEAR_ANSWER" },
      { pattern: /\b(save answer|save response|save)\b/, action: "SAVE_ANSWER" },
      { pattern: /\b(start answer|start recording|record answer|begin answer|start dictation)\b/, action: "START_ANSWER" },
      { pattern: /\b(stop recording|stop answer|pause recording|stop dictation|pause mic|stop|stop here)\b/, action: "STOP_RECORDING" },
      { pattern: /\b(read question|repeat question|read the question|tell me question|read question again|shall i continue|continue reading|continue)\b/, action: "READ_QUESTION" },
      { pattern: /\b(is this okay|is it okay|okay|yes|yeah|sure|ready)\b/, action: "USER_CONFIRM_OKAY" }
    ];

    for (const item of commandPatterns) {
      if (item.pattern.test(text)) {
        console.log(`AutoScribe Command Match: "${text}" -> [${item.action}]`);
        this.playChime('confirm');
        if (this.onCommandCallback) {
          this.onCommandCallback(item.action, text);
        }
        return true;
      }
    }

    return false;
  }
};
