/**
 * AutoScribe - Exam Session Manager
 * Short, clear, student-friendly instructions spoken via Sarvam AI Text-to-Speech (bulbul:v3).
 */

window.AutoScribeExamSession = {
  activeExam: null,
  currentIndex: 0,
  answers: {},
  timerInterval: null,
  autoSaveInterval: null,
  remainingSeconds: 3600,
  totalSeconds: 3600,
  lastReminderMinute: 0,
  pendingTimeReminder: null,
  reviewState: 'IDLE', // 'IDLE', 'AWAITING_CHANGE_CONFIRMATION', 'AWAITING_QUESTION_SELECTION', 'AWAITING_REWRITE_CONFIRMATION'
  mathState: 'IDLE', // 'IDLE', 'MATH_AWAITING_READ_WRITE', 'MATH_RECORDING_ANSWER', 'MATH_AWAITING_CONFIRMATION'
  questionState: 'IDLE',
  answerMode: false,
  waitingForAnswer: false,
  questionChoiceMode: false,
  isRewritingAnswer: false,
  awaitingSubmitConfirmation: false,

  async initSession() {
    const isExamPage = window.location.pathname.endsWith('exam.html') || window.location.href.includes('exam.html');
    if (!isExamPage) {
      console.warn("AutoScribe: Blocked exam session initialization on non-exam page.");
      return;
    }

    this.currentIndex = 0;
    const params = new URLSearchParams(window.location.search);
    const rawId = (params.get('id') || params.get('subject') || '').toLowerCase().trim();

    const exams = await AutoScribeDB.getExams();
    this.activeExam = (exams && exams.length > 0) ? (exams.find(e => 
      e.id.toLowerCase() === rawId || 
      e.id.toLowerCase() === 'exam_' + rawId || 
      e.title.toLowerCase() === rawId ||
      (rawId.includes('math') && e.id === 'exam_math') ||
      (rawId.includes('phys') && e.id === 'exam_phys') ||
      (rawId.includes('chem') && e.id === 'exam_chem') ||
      (rawId.includes('cs') && e.id === 'exam_cs') ||
      (rawId.includes('comp') && e.id === 'exam_cs') ||
      (rawId.includes('bio') && e.id === 'exam_bio') ||
      (rawId.includes('eng') && e.id === 'exam_eng')
    ) || exams[0]) : null;

    if (!this.activeExam || !Array.isArray(this.activeExam.questions) || this.activeExam.questions.length === 0) {
      alert("Exam question data could not be loaded!");
      window.location.href = 'dashboard.html';
      return;
    }

    this.remainingSeconds = (this.activeExam.durationMinutes || 90) * 60;
    this.totalSeconds = this.remainingSeconds;
    this.lastReminderMinute = 0;
    this.pendingTimeReminder = null;
    this.reviewState = 'IDLE';
    this.mathState = 'IDLE';
    this.isRewritingAnswer = false;

    // Sync student details display on exam page
    let user = AutoScribeApp.currentUser;
    if (!user) {
      const stored = sessionStorage.getItem('autoscribe_user') || localStorage.getItem('autoscribe_user');
      if (stored) {
        try {
          user = JSON.parse(stored);
          AutoScribeApp.currentUser = user;
        } catch (e) {}
      }
    }

    if (user) {
      const name = user.name || user.studentName || '';
      const roll = user.rollNumber || user.studentId || '';
      const nameEl = document.getElementById('examStudentName');
      const rollEl = document.getElementById('examRollNumber');
      if (nameEl && name) nameEl.textContent = name;
      if (rollEl && roll) rollEl.textContent = roll;
    }

    try {
      this.loadSavedAnswers();
    } catch (e) {
      console.warn("Failed to load saved answers:", e);
    }

    // Immediately render question statement to DOM synchronously
    this.renderQuestion();
    this.startTimers();
    this.initVoiceEngine();

    // Concise Sarvam AI Voice Prompt for ALL subjects
    let examStarted = false;
    const triggerStart = () => {
      if (examStarted) return;
      examStarted = true;
      this.startQuestionFlow();
    };

    setTimeout(triggerStart, 400);

    const triggerExamGesture = () => {
      AutoScribeSpeech.getAudioContext();
      triggerStart();
    };

    document.body.addEventListener('click', triggerExamGesture);
    document.body.addEventListener('keydown', triggerExamGesture);
  },

  loadSavedAnswers() {
    const user = AutoScribeApp.currentUser || JSON.parse(sessionStorage.getItem('autoscribe_user') || localStorage.getItem('autoscribe_user') || '{"studentId":"STD-1001"}');
    const studentId = user.rollNumber || user.studentId || 'STD-1001';
    if (!this.activeExam || !Array.isArray(this.activeExam.questions)) return;
    this.activeExam.questions.forEach(q => {
      const key = `autoscribe_ans_${studentId}_${this.activeExam.id}_q${q.id}`;
      const saved = localStorage.getItem(key);
      this.answers[q.id] = saved || '';
    });
  },

  renderQuestion() {
    if (!this.activeExam || !Array.isArray(this.activeExam.questions) || this.activeExam.questions.length === 0) return;
    const question = this.activeExam.questions[this.currentIndex] || this.activeExam.questions[0];
    if (!question) return;

    const questionHeader = document.getElementById('questionHeader');
    const questionText = document.getElementById('questionText');
    const answerInput = document.getElementById('answerInput');
    const questionProgress = document.getElementById('questionProgress');

    const sectionBadge = question.section ? `<span style="font-size: 0.9rem; background: var(--accent-blue); color: #fff; padding: 0.2rem 0.6rem; border-radius: 6px; margin-left: 0.75rem; vertical-align: middle;">${question.section}</span>` : '';
    if (questionHeader) questionHeader.innerHTML = `Question ${this.currentIndex + 1} of ${this.activeExam.questions.length} (${question.marks} Marks) ${sectionBadge}`;
    if (questionText) questionText.textContent = question.text;
    if (answerInput) answerInput.value = this.answers[question.id] || '';
    if (questionProgress) questionProgress.textContent = `Progress: Q${this.currentIndex + 1}/${this.activeExam.questions.length} | Subject: ${this.activeExam.title}${this.activeExam.code ? ` (${this.activeExam.code})` : ''}`;

    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    if (prevBtn) prevBtn.disabled = this.currentIndex === 0;
    if (nextBtn) {
      nextBtn.textContent = (this.currentIndex === this.activeExam.questions.length - 1) ? "Review Answers" : "Next Question";
    }
  },

  saveCurrentAnswerSilently() {
    const question = this.activeExam.questions[this.currentIndex];
    const answerInput = document.getElementById('answerInput');
    if (question && answerInput) {
      this.answers[question.id] = answerInput.value;
      const user = AutoScribeApp.currentUser || JSON.parse(sessionStorage.getItem('autoscribe_user') || localStorage.getItem('autoscribe_user') || '{"studentId":"STD-1001"}');
      const studentId = user.rollNumber || user.studentId || 'STD-1001';
      AutoScribeDB.saveAnswer(studentId, this.activeExam.id, question.id, answerInput.value);
    }
  },

  startTimers() {
    const timerDisplay = document.getElementById('timerDisplay');
    const totalSecs = (this.activeExam.durationMinutes || 90) * 60;
    this.totalSeconds = totalSecs;

    this.timerInterval = setInterval(() => {
      this.remainingSeconds--;
      if (this.remainingSeconds <= 0) {
        clearInterval(this.timerInterval);
        this.autoSubmitTimeExpired();
      } else {
        if (timerDisplay) {
          const mins = Math.floor(this.remainingSeconds / 60);
          const secs = this.remainingSeconds % 60;
          timerDisplay.textContent = `Time Remaining: ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }

        // Check for 10-Minute Automatic Time Reminder
        const elapsedSecs = this.totalSeconds - this.remainingSeconds;
        const elapsedMins = Math.floor(elapsedSecs / 60);

        if (elapsedMins > 0 && elapsedMins % 10 === 0 && elapsedMins !== this.lastReminderMinute) {
          this.lastReminderMinute = elapsedMins;
          this.queueTimeReminder();
        }
      }
    }, 1000);

    // 30-Second Silent Cloud Sync
    this.autoSaveInterval = setInterval(() => {
      this.saveCurrentAnswerSilently();
      const statusText = document.getElementById('saveStatus');
      if (statusText) {
        statusText.textContent = `Auto-saved at ${new Date().toLocaleTimeString()}`;
      }
    }, 30000);
  },

  queueTimeReminder() {
    const remMinsTotal = Math.round(this.remainingSeconds / 60);
    const remHours = Math.floor(remMinsTotal / 60);
    const remMins = remMinsTotal % 60;

    let reminderText = '';
    if (remHours > 0 && remMins > 0) {
      reminderText = `You have ${remHours} hour${remHours > 1 ? 's' : ''} and ${remMins} minute${remMins > 1 ? 's' : ''} remaining.`;
    } else if (remHours > 0 && remMins === 0) {
      reminderText = `You have ${remHours} hour${remHours > 1 ? 's' : ''} remaining.`;
    } else if (remHours === 0 && remMins > 0) {
      reminderText = `You have ${remMins} minute${remMins > 1 ? 's' : ''} remaining.`;
    }

    if (!reminderText) return;

    // Non-interruptive logic: if speech or rewriting is active, queue reminder; otherwise announce immediately
    if (AutoScribeSpeech.speechActive || this.isRewritingAnswer) {
      this.pendingTimeReminder = reminderText;
    } else {
      AutoScribeSpeech.speak(reminderText, () => {
        if (!AutoScribeSpeech.speechActive) {
          AutoScribeSpeech.startListening(
            (text) => this.handleSpokenDictation(text),
            (cmd, rawText) => this.handleVoiceCommand(cmd, rawText)
          );
        }
      });
    }
  },

  checkPendingReminder() {
    if (this.pendingTimeReminder && !AutoScribeSpeech.speechActive && !this.isRewritingAnswer) {
      const msg = this.pendingTimeReminder;
      this.pendingTimeReminder = null;
      AutoScribeSpeech.speak(msg, () => {
        AutoScribeSpeech.startListening(
          (text) => this.handleSpokenDictation(text),
          (cmd, rawText) => this.handleVoiceCommand(cmd, rawText)
        );
      });
    }
  },

  initVoiceEngine() {
    AutoScribeSpeech.init();

    const recordBtn = document.getElementById('recordToggleBtn');
    if (recordBtn) {
      recordBtn.addEventListener('click', () => {
        if (AutoScribeSpeech.isListening) {
          AutoScribeSpeech.stopListening();
          recordBtn.classList.remove('listening');
          recordBtn.innerHTML = `🎤 Start Voice Recording`;
        } else {
          AutoScribeSpeech.startListening(
            (text) => this.handleSpokenDictation(text),
            (cmd, rawText) => this.handleVoiceCommand(cmd, rawText)
          );
          recordBtn.classList.add('listening');
          recordBtn.innerHTML = `🛑 Listening... Click to Stop`;
        }
      });
    }
  },

  handleSpokenDictation(text) {
    const answerInput = document.getElementById('answerInput');
    if (!answerInput) return;

    if (this.isRewritingAnswer) {
      // Replace previous answer completely
      answerInput.value = text;
      this.saveCurrentAnswerSilently();
      this.isRewritingAnswer = false;
      this.reviewState = 'IDLE';

      const saveStatus = document.getElementById('saveStatus');
      if (saveStatus) saveStatus.textContent = `Answer updated: "${text.slice(0, 30)}..."`;

      AutoScribeSpeech.speak("Your answer has been updated.", () => {
        this.checkPendingReminder();
        AutoScribeSpeech.startListening(
          (t) => this.handleSpokenDictation(t),
          (cmd, rawText) => this.handleVoiceCommand(cmd, rawText)
        );
      });
      return;
    }

    const current = answerInput.value;
    answerInput.value = current ? `${current} ${text}` : text;
    this.saveCurrentAnswerSilently();
    
    const saveStatus = document.getElementById('saveStatus');
    if (saveStatus) saveStatus.textContent = `Voice captured: "${text.slice(0, 30)}..."`;

    this.checkPendingReminder();
  },

  parseTargetQuestion(rawText) {
    if (!rawText || !this.activeExam || !this.activeExam.questions) return -1;
    const text = rawText.toLowerCase().trim();
    const questions = this.activeExam.questions;

    const wordNums = {
      'first': 1, '1st': 1, 'one': 1, '1': 1,
      'second': 2, '2nd': 2, 'two': 2, '2': 2,
      'third': 3, '3rd': 3, 'three': 3, '3': 3,
      'fourth': 4, '4th': 4, 'four': 4, '4': 4,
      'fifth': 5, '5th': 5, 'five': 5, '5': 5,
      'sixth': 6, '6th': 6, 'six': 6, '6': 6,
      'seventh': 7, '7th': 7, 'seven': 7, '7': 7,
      'eighth': 8, '8th': 8, 'eight': 8, '8': 8,
      'ninth': 9, '9th': 9, 'nine': 9, '9': 9,
      'tenth': 10, '10th': 10, 'ten': 10, '10': 10,
      'eleventh': 11, '11th': 11, 'eleven': 11, '11': 11,
      'twelfth': 12, '12th': 12, 'twelve': 12, '12': 12,
      'thirteenth': 13, '13th': 13, 'thirteen': 13, '13': 13,
      'fourteenth': 14, '14th': 14, 'fourteen': 14, '14': 14
    };

    const isTenMarkSection = /\b(ten\s+mark|10\s+mark|part\s+b|long\s+answer)\b/.test(text);
    const isTwoMarkSection = /\b(two\s+mark|2\s+mark|part\s+a|short\s+answer)\b/.test(text);

    let targetNum = null;
    const matchDigit = text.match(/\b(question|q|no|num|number)?\s*(\d+)\b/);
    if (matchDigit) {
      targetNum = parseInt(matchDigit[2]);
    } else {
      for (const [word, val] of Object.entries(wordNums)) {
        if (new RegExp(`\\b${word}\\b`).test(text)) {
          targetNum = val;
          break;
        }
      }
    }

    if (!targetNum) return -1;

    if (isTenMarkSection) {
      const tenMarkIndices = [];
      questions.forEach((q, idx) => {
        if (q.marks === 10 || (q.section && q.section.includes('10 Marks'))) {
          tenMarkIndices.push(idx);
        }
      });

      if (tenMarkIndices.length > 0) {
        if (targetNum <= tenMarkIndices.length) {
          return tenMarkIndices[targetNum - 1];
        }
        const absIdx = questions.findIndex(q => q.id === targetNum);
        if (absIdx !== -1) return absIdx;
      }
    }

    if (isTwoMarkSection) {
      const twoMarkIndices = [];
      questions.forEach((q, idx) => {
        if (q.marks === 2 || (q.section && q.section.includes('2 Marks'))) {
          twoMarkIndices.push(idx);
        }
      });

      if (twoMarkIndices.length > 0) {
        if (targetNum <= twoMarkIndices.length) {
          return twoMarkIndices[targetNum - 1];
        }
      }
    }

    const directIdx = questions.findIndex(q => q.id === targetNum);
    if (directIdx !== -1) return directIdx;

    if (targetNum >= 1 && targetNum <= questions.length) {
      return targetNum - 1;
    }

    return -1;
  },

  handleVoiceCommand(command, rawText = '') {
    const question = this.activeExam.questions[this.currentIndex];
    const answerInput = document.getElementById('answerInput');
    const text = (rawText || '').toLowerCase().trim();

    const isYes = (str) => /\b(yes|yeah|yep|sure|correct|right|okay|ok|confirm|true|perfect)\b/.test(str.toLowerCase());
    const isNo = (str) => /\b(no|nope|nah|incorrect|wrong|repeat|retry|change|not correct|false|stop)\b/.test(str.toLowerCase());

    // Review / Change Answer State Machine
    if (this.reviewState === 'AWAITING_CHANGE_CONFIRMATION') {
      if (isYes(text) || command === 'USER_CONFIRM_OKAY') {
        this.reviewState = 'AWAITING_QUESTION_SELECTION';
        AutoScribeSpeech.speak("Which question do you want to change?", () => {
          AutoScribeSpeech.startListening(
            (t) => this.handleSpokenDictation(t),
            (c, r) => this.handleVoiceCommand(c, r)
          );
        });
      } else {
        this.reviewState = 'IDLE';
        AutoScribeSpeech.speak("Okay. Continuing with your exam.");
      }
      return;
    }

    if (this.reviewState === 'AWAITING_QUESTION_SELECTION') {
      const targetIdx = this.parseTargetQuestion(text);
      if (targetIdx !== -1) {
        this.saveCurrentAnswerSilently();
        this.currentIndex = targetIdx;
        this.renderQuestion();
        this.reviewState = 'AWAITING_REWRITE_CONFIRMATION';

        const targetQ = this.activeExam.questions[this.currentIndex];
        AutoScribeSpeech.speak(`Question ${this.currentIndex + 1}. ${targetQ.text}. Do you want to change your answer?`, () => {
          AutoScribeSpeech.startListening(
            (t) => this.handleSpokenDictation(t),
            (c, r) => this.handleVoiceCommand(c, r)
          );
        });
      } else {
        AutoScribeSpeech.speak("Which question do you want to change? Please say for example, question 2 in two marks, or question 3 in ten marks.");
      }
      return;
    }

    if (this.reviewState === 'AWAITING_REWRITE_CONFIRMATION') {
      if (isYes(text) || command === 'USER_CONFIRM_OKAY') {
        this.isRewritingAnswer = true;
        this.reviewState = 'IDLE';
        AutoScribeSpeech.speak("Microphone active. Please speak your new answer now.", () => {
          AutoScribeSpeech.startListening(
            (t) => this.handleSpokenDictation(t),
            (c, r) => this.handleVoiceCommand(c, r)
          );
        });
      } else {
        this.reviewState = 'IDLE';
        this.isRewritingAnswer = false;
        AutoScribeSpeech.speak(`Okay. Keeping your existing answer for Question ${this.currentIndex + 1}.`);
      }
      return;
    }

    // Direct trigger for Change / Review Answer
    if (command === 'CHANGE_ANSWER' || /\b(change\s+(an\s+)?answer|review\s+(an\s+)?answer|want\s+to\s+change|want\s+to\s+review)\b/.test(text)) {
      this.reviewState = 'AWAITING_CHANGE_CONFIRMATION';
      AutoScribeSpeech.speak("Do you want to change something in your answer?", () => {
        AutoScribeSpeech.startListening(
          (t) => this.handleSpokenDictation(t),
          (c, r) => this.handleVoiceCommand(c, r)
        );
      });
      return;
    }

    switch (command) {
      case 'READ_QUESTION':
        this.startQuestionFlow();
        break;

      case 'USER_CONFIRM_OKAY':
        if (this.awaitingSubmitConfirmation) {
          this.executeFinalSubmission();
        } else {
          AutoScribeSpeech.speak("Okay. Please give your answer.");
        }
        break;

      case 'START_ANSWER':
        AutoScribeSpeech.speak("Okay, start your answer.", () => {
          AutoScribeSpeech.startListening(
            (text, finalFlag) => this.handleSubjectVoiceInput(text, finalFlag),
            (cmd, rawText) => this.handleSubjectVoiceInput(rawText, true)
          );
        });
        break;

      case 'STOP_RECORDING':
        AutoScribeSpeech.stopListening();
        AutoScribeSpeech.speak("Microphone paused.");
        break;

      case 'READ_ANSWER':
        const currentAns = answerInput ? answerInput.value : '';
        if (currentAns.trim()) {
          AutoScribeSpeech.speak(`Your answer is: ${currentAns}`);
        } else {
          AutoScribeSpeech.speak(`No answer recorded yet.`);
        }
        break;

      case 'NEXT_QUESTION':
        this.saveCurrentAnswerSilently();
        if (this.currentIndex < this.activeExam.questions.length - 1) {
          this.currentIndex++;
          this.renderQuestion();
          this.startQuestionFlow();
        } else {
          this.promptSubmissionModal();
        }
        break;

      case 'PREV_QUESTION':
        this.saveCurrentAnswerSilently();
        if (this.currentIndex > 0) {
          this.currentIndex--;
          this.renderQuestion();
          this.startQuestionFlow();
        } else {
          AutoScribeSpeech.speak("You are on Question 1.");
        }
        break;

      case 'DELETE_SENTENCE':
        if (answerInput && answerInput.value) {
          const sentences = answerInput.value.split(/(?<=[.!?])\s+/);
          sentences.pop();
          answerInput.value = sentences.join(' ');
          this.saveCurrentAnswerSilently();
          AutoScribeSpeech.speak("Last sentence deleted.");
        } else {
          AutoScribeSpeech.speak("No text to delete.");
        }
        break;

      case 'CLEAR_ANSWER':
        if (answerInput) {
          answerInput.value = '';
          this.saveCurrentAnswerSilently();
          AutoScribeSpeech.speak("Answer cleared.");
        }
        break;

      case 'SAVE_ANSWER':
        this.saveCurrentAnswerSilently();
        AutoScribeSpeech.speak("Your answer is saved.");
        break;

      case 'SUBMIT_EXAM':
        this.promptSubmissionModal();
        break;

      case 'CONFIRM_SUBMIT':
        this.executeFinalSubmission();
        break;
    }
  },

  promptSubmissionModal() {
    this.awaitingSubmitConfirmation = true;
    this.saveCurrentAnswerSilently();

    let modal = document.getElementById('submitModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'submitModal';
      modal.style.position = 'fixed';
      modal.style.top = '0';
      modal.style.left = '0';
      modal.style.width = '100%';
      modal.style.height = '100%';
      modal.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
      modal.style.display = 'flex';
      modal.style.alignItems = 'center';
      modal.style.justifyContent = 'center';
      modal.style.zIndex = '9999';

      modal.innerHTML = `
        <div class="card" style="max-width: 550px; width: 90%; text-align: center; border: 3px solid var(--accent-gold); padding: 2.5rem;">
          <h2 style="font-size: 2rem; color: var(--accent-gold); margin-bottom: 1rem;">⚠️ Confirm Submission</h2>
          <p style="font-size: 1.2rem; color: var(--text-secondary); margin-bottom: 2rem;">
            Do you want to submit your exam now?
          </p>
          <div style="display: flex; flex-direction: column; gap: 1rem;">
            <button id="finalConfirmBtn" class="btn btn-success btn-large" style="width: 100%; font-size: 1.3rem;">
              ✅ YES, SUBMIT NOW (Say "Confirm")
            </button>
            <button onclick="document.getElementById('submitModal').style.display='none';" class="btn btn-secondary btn-large" style="width: 100%;">
              ❌ Return to Exam
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      document.getElementById('finalConfirmBtn').addEventListener('click', () => {
        this.executeFinalSubmission();
      });
    } else {
      modal.style.display = 'flex';
    }

    AutoScribeSpeech.speak("Do you want to submit your exam now? Say Confirm or click Yes.");
  },

  async executeFinalSubmission() {
    this.saveCurrentAnswerSilently();
    clearInterval(this.timerInterval);
    clearInterval(this.autoSaveInterval);

    const user = AutoScribeApp.currentUser || JSON.parse(sessionStorage.getItem('autoscribe_user') || localStorage.getItem('autoscribe_user') || '{"studentId":"STD-1001","name":"Guest Student"}');
    const studentId = user.rollNumber || user.studentId || 'STD-1001';
    const name = user.name || user.studentName || 'Guest Student';

    AutoScribeSpeech.speak("Exam submitted successfully.", async () => {
      try {
        const submission = await AutoScribeDB.submitExam(studentId, name, this.activeExam.id, this.answers);
        sessionStorage.setItem('autoscribe_last_submission', JSON.stringify(submission));
      } catch (e) {
        console.warn("Submission save error caught:", e);
      }
      window.location.href = 'confirmation.html';
    });

    setTimeout(() => {
      window.location.href = 'confirmation.html';
    }, 2000);
  },

  normalizeMathSegment(rawText) {
    if (!rawText) return '';
    let str = String(rawText).trim();
    if (!str) return '';

    // Strip trailing sentence punctuation
    str = str.replace(/[,.?!]+$/g, '');

    // 1. Spoken Brackets / Parentheses
    str = str.replace(/\b(open|start)\s*(brackets?|parenthesis|paren)\b/gi, '(')
             .replace(/\b(close|end)\s*(brackets?|parenthesis|paren)\b/gi, ')');

    // 2. Spoken Inequalities & Operators
    str = str.replace(/\b(greater\s+than\s+(or\s+)?equal\s+to|greater\s+equal\s+to)\b/gi, '≥')
             .replace(/\b(less\s+than\s+(or\s+)?equal\s+to|less\s+equal\s+to)\b/gi, '≤')
             .replace(/\bgreater\s+than\b/gi, '>')
             .replace(/\bless\s+than\b/gi, '<')
             .replace(/\b(is\s+)?equals?\s*(to)?\b/gi, '=')
             .replace(/\b(is\s+)?equal\s*(to)?\b/gi, '=')
             .replace(/\b(multiplied\s+by|times)\b/gi, '×')
             .replace(/\b(divided\s+by|over)\b/gi, '÷')
             .replace(/\bplus\b/gi, '+')
             .replace(/\b(minus|subtracted\s+by)\b/gi, '−')
             .replace(/\b(percent|percentage)\b/gi, '%');

    // 3. Spoken Compound Tens & Teen Numbers
    const compoundNumbers = {
      'twenty five': '25', 'twenty four': '24', 'twenty three': '23', 'twenty two': '22', 'twenty one': '21',
      'thirty five': '35', 'thirty four': '34', 'thirty three': '33', 'thirty two': '32', 'thirty one': '31',
      'forty five': '45', 'forty four': '44', 'forty three': '43', 'forty two': '42', 'forty one': '41',
      'fifty five': '55', 'fifty four': '54', 'fifty three': '53', 'fifty two': '52', 'fifty one': '51',
      'eleven': '11', 'twelve': '12', 'thirteen': '13', 'fourteen': '14', 'fifteen': '15',
      'sixteen': '16', 'seventeen': '17', 'eighteen': '18', 'nineteen': '19',
      'twenty': '20', 'thirty': '30', 'forty': '40', 'fifty': '50', 'sixty': '60',
      'seventy': '70', 'eighty': '80', 'ninety': '90', 'hundred': '100'
    };

    for (const [phrase, num] of Object.entries(compoundNumbers)) {
      str = str.replace(new RegExp(`\\b${phrase}\\b`, 'gi'), num);
    }

    // 4. Spoken Single Digits
    const digitWords = {
      'zero': '0', 'null': '0',
      'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
      'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10'
    };

    str = str.replace(/\b(zero|null|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (m) => digitWords[m.toLowerCase()] || m);

    // 5. Merge Sequence Digits (e.g., "2 5" -> "25", "1 0 0 1" -> "1001")
    let prev = '';
    while (prev !== str) {
      prev = str;
      str = str.replace(/\b(\d+)\s+(\d+)\b/g, '$1$2');
    }

    // 6. Exponent & Power Normalization ("x cube" -> "x³", "x squared" -> "x²")
    str = str.replace(/\b([a-zA-Z0-9\)])\s*(cubed?|cube)\b/gi, '$1³')
             .replace(/\b([a-zA-Z0-9\)])\s*(squared?|square)\b/gi, '$1²')
             .replace(/\b(to\s+the\s+power\s+of|raised\s+to\s+the\s+power\s+of|raised\s+to|to\s+the\s+power|power)\b/gi, '^');

    // 7. Coefficient & Variable Joining (e.g., "5 x" -> "5x", "2 x²" -> "2x²", "4 x" -> "4x")
    str = str.replace(/\b(\d+)\s+([a-zA-Z][²³]?)\b/gi, '$1$2');

    // 8. Clean spaces around operators & brackets
    str = str.replace(/\s*([+−×÷=><≥≤^])\s*/g, '$1')
             .replace(/\(\s+/g, '(')
             .replace(/\s+\)/g, ')')
             .replace(/\s+/g, '')
             .trim();

    return str;
  },

  mergeMathBuffer(existingBuffer, newSegment) {
    if (!existingBuffer) return newSegment || '';
    if (!newSegment) return existingBuffer;

    let buf = String(existingBuffer).trim();
    let seg = String(newSegment).trim();

    if (!buf) return seg;
    if (!seg) return buf;

    // Prevent duplicate appending if seg is already at the end of buf
    if (buf.endsWith(seg)) {
      return buf;
    }

    // If new segment starts with an operator (+, −, ×, ÷, =, >, <, ≥, ≤, ^), attach directly
    if (/^[+−×÷=><≥≤^]/.test(seg)) {
      return buf + seg;
    }

    // If existing buffer ends with an operator, attach directly
    if (/[+−×÷=><≥≤^]$/.test(buf)) {
      return buf + seg;
    }

    // If existing buffer ends with a digit/letter and new segment starts with variable/digit
    if (/\d$/.test(buf) && /^[a-zA-Z]/.test(seg)) {
      return buf + seg;
    }

    return buf + seg;
  },

  normalizeMathExpression(rawText) {
    return this.normalizeMathSegment(rawText);
  },

  convertNumberWordsToDigits(text) {
    return this.normalizeMathSegment(text);
  },

  formatSpokenDictation(rawText, examId = '') {
    if (!rawText) return '';
    let text = rawText.trim();
    const isMath = (examId === 'exam_math') || 
                   (this.activeExam && (this.activeExam.id === 'exam_math' || (this.activeExam.title && this.activeExam.title.toLowerCase().includes('math'))));

    if (isMath) {
      return this.normalizeMathSegment(text);
    }
    return text.replace(/\s+/g, ' ').trim();
  },

  handleMathVoiceDictation(rawText, isFinal = false) {
    if (!rawText || !String(rawText).trim()) return;
    const text = String(rawText).trim();
    const newSeg = this.normalizeMathSegment(text);

    const question = this.activeExam ? this.activeExam.questions[this.currentIndex] : null;
    const qId = question ? question.id : 'default';

    if (typeof this.mathAnswerBuffer !== 'string') {
      this.mathAnswerBuffer = this.answers[qId] || '';
    }

    if (!isFinal) {
      console.log("[AutoScribe Math] Interim transcript:", text);
      const preview = this.mergeMathBuffer(this.mathAnswerBuffer, newSeg);
      console.log("[AutoScribe Math] Existing math buffer:", this.mathAnswerBuffer);
      console.log("[AutoScribe Math] New normalized segment:", newSeg);
      console.log("[AutoScribe Math] answerInput value:", preview);

      const answerInput = document.getElementById('answerInput');
      if (answerInput) {
        answerInput.value = preview;
      }
      return;
    }

    console.log("[AutoScribe Math] Final transcript:", text);
    console.log("[AutoScribe Math] Existing math buffer:", this.mathAnswerBuffer);
    console.log("[AutoScribe Math] New normalized segment:", newSeg);

    this.mathAnswerBuffer = this.mergeMathBuffer(this.mathAnswerBuffer, newSeg);
    console.log("[AutoScribe Math] Updated math buffer:", this.mathAnswerBuffer);

    const answerInput = document.getElementById('answerInput');
    if (answerInput) {
      answerInput.value = this.mathAnswerBuffer;
      console.log("[AutoScribe Math] answerInput value:", answerInput.value);
    }

    if (qId) {
      this.answers[qId] = this.mathAnswerBuffer;
    }
    this.saveCurrentAnswerSilently();
  },

  startQuestionFlow() {
    if (!this.activeExam) return;

    const question = this.activeExam.questions[this.currentIndex];
    if (!question) return;

    // Immediately update DOM before speaking
    this.renderQuestion();

    // Check if Mathematics Exam
    const isMath = (this.activeExam.id === 'exam_math') || 
                   (this.activeExam.title && this.activeExam.title.toLowerCase().includes('math'));

    if (isMath) {
      // Reset Math Buffer & State for Mathematics Question Flow
      this.mathAnswerBuffer = this.answers[question.id] || '';
      const answerInput = document.getElementById('answerInput');
      if (answerInput) answerInput.value = this.mathAnswerBuffer;

      this.reviewState = 'IDLE';
      this.answerMode = true;
      this.waitingForAnswer = true;
      this.questionChoiceMode = false;
      this.questionState = 'RECORDING_ANSWER';
      this.mathState = 'MATH_RECORDING_ANSWER';

      const sectionInfo = question.section ? `${question.section}. ` : '';
      const qNumText = `Question ${this.currentIndex + 1} of ${this.activeExam.questions.length}.`;
      const fullText = `${qNumText} ${sectionInfo}${question.text}`;

      const saveStatus = document.getElementById('saveStatus');
      if (saveStatus) saveStatus.textContent = `🎙️ MATH MODE: Question ${this.currentIndex + 1} active...`;

      // Sequential Chained TTS for Mathematics Flow
      console.log("[AutoScribe Math] Question read 1 started");
      AutoScribeSpeech.speak(fullText, () => {
        console.log("[AutoScribe Math] Question read 1 finished");

        console.log("[AutoScribe Math] Question read 2 started");
        AutoScribeSpeech.speak(question.text, () => {
          console.log("[AutoScribe Math] Question read 2 finished");

          console.log("[AutoScribe Math] Answer prompt started");
          AutoScribeSpeech.speak("Now, please say your answer.", () => {
            console.log("[AutoScribe Math] Answer prompt finished");

            console.log("[AutoScribe Math] Starting student microphone");
            AutoScribeSpeech.startListening(
              (rawText, isFinal) => this.handleMathVoiceDictation(rawText, isFinal),
              (cmd, rawText) => this.handleMathVoiceDictation(rawText, true)
            );
          });
        });
      });
      return;
    }

    // Non-Mathematics Subjects logic
    this.reviewState = 'IDLE';
    this.answerMode = false;
    this.waitingForAnswer = false;
    this.questionChoiceMode = true;
    this.questionState = 'AWAITING_READ_WRITE';
    this.mathState = 'MATH_AWAITING_READ_WRITE';

    const sectionInfo = question.section ? `${question.section}. ` : '';
    const qNumText = `Question ${this.currentIndex + 1} of ${this.activeExam.questions.length}.`;
    const fullText = `${qNumText} ${sectionInfo}${question.text}`;
    const promptText = `${fullText}. Can I read the question once again or will you write? Please say read again or I will write.`;

    const saveStatus = document.getElementById('saveStatus');
    if (saveStatus) saveStatus.textContent = `Voice Assistant: ${this.activeExam.title} Question ${this.currentIndex + 1} ready...`;

    AutoScribeSpeech.speak(promptText, () => {
      AutoScribeSpeech.startListening(
        (rawText, isFinal) => this.handleSubjectVoiceInput(rawText, isFinal),
        (cmd, rawText) => this.handleSubjectVoiceInput(rawText, true)
      );
    });
  },



  startMathQuestionFlow() {
    this.startQuestionFlow();
  },

  formatMathDictation(rawText) {
    return this.formatSpokenDictation(rawText, 'exam_math');
  },

  handleMathVoiceInput(rawText, isFinal = true) {
    this.handleSubjectVoiceInput(rawText, isFinal);
  },

  handleSubjectVoiceInput(rawText, isFinal = true) {
    if (!rawText || !rawText.trim()) return;
    const text = rawText.trim();
    const lower = text.toLowerCase();
    const question = this.activeExam ? this.activeExam.questions[this.currentIndex] : null;

    const currentState = this.questionState || this.mathState || 'AWAITING_READ_WRITE';
    console.log(`SubjectVoiceState [${currentState}] Q${this.currentIndex + 1} Input: "${text}" (isFinal: ${isFinal}, answerMode: ${this.answerMode})`);

    // State 1: Awaiting student choice ("read again" vs "I will write")
    if (!this.answerMode && (currentState === 'AWAITING_READ_WRITE' || currentState === 'MATH_AWAITING_READ_WRITE')) {
      const isReadAgain = /\b(read|read again|read once again|once again|read question|repeat)\b/i.test(lower) && 
                          !/\b(write|will write|i'll write|i will write)\b/i.test(lower);

      if (isReadAgain) {
        const sectionInfo = (question && question.section) ? `${question.section}. ` : '';
        const singleReadText = question ? `Question ${this.currentIndex + 1} of ${this.activeExam.questions.length}. ${sectionInfo}${question.text}.` : '';
        const promptText = `${singleReadText} Can I read the question once again or will you write? Please say read again or I will write.`;

        AutoScribeSpeech.speak(promptText, () => {
          AutoScribeSpeech.startListening(
            (t, f) => this.handleSubjectVoiceInput(t, f),
            (c, r) => this.handleSubjectVoiceInput(r, true)
          );
        });
        return;
      }

      // Check ALL variations of "I will write", "I'll write", "write", "I will write the answer", etc.
      const isWriteTrigger = /\b(i\s*will\s*write|i'll\s*write|will\s*write|i\s*will\s*write\s*the\s*answer|write|i\s*will\s*answer|i'll\s*answer|will\s*answer|start\s*writing|let\s*me\s*write|write\s*the\s*answer|writing|start|ready|begin|answer)\b/i.test(lower);

      if (isWriteTrigger) {
        console.log("Switching to WRITE_MODE");

        // CRITICAL STATE RULE: Lock permanently into WRITE MODE for this question
        this.answerMode = true;
        this.waitingForAnswer = true;
        this.questionChoiceMode = false;
        this.questionState = 'RECORDING_ANSWER';
        this.mathState = 'MATH_RECORDING_ANSWER';

        const saveStatus = document.getElementById('saveStatus');
        if (saveStatus) saveStatus.textContent = `🎙️ WRITE MODE ACTIVE: Dictating answer...`;

        // Immediately confirm and prompt student to dictate
        AutoScribeSpeech.speak("Okay, start. I am listening.", () => {
          AutoScribeSpeech.startListening(
            (t, f) => this.handleSubjectVoiceInput(t, f),
            (c, r) => this.handleSubjectVoiceInput(r, true)
          );
        });
        return;
      }

      // Unclear choice -> re-prompt
      AutoScribeSpeech.speak("Please say read again or I will write.", () => {
        AutoScribeSpeech.startListening(
          (t, f) => this.handleSubjectVoiceInput(t, f),
          (c, r) => this.handleSubjectVoiceInput(r, true)
        );
      });
      return;
    }

    // State 2: Capturing spoken answer (WRITE MODE / MATH RECORDING)
    if (this.answerMode || this.questionState === 'RECORDING_ANSWER' || this.mathState === 'MATH_RECORDING_ANSWER') {
      const isMath = (this.activeExam && (this.activeExam.id === 'exam_math' || (this.activeExam.title && this.activeExam.title.toLowerCase().includes('math'))));
      const formattedAns = this.formatSpokenDictation(text, this.activeExam ? this.activeExam.id : '');
      
      console.log("[AutoScribe ExamSession] current exam state:", currentState);
      console.log(`[AutoScribe ExamSession] raw transcript (isFinal: ${isFinal}): "${text}"`);
      console.log("[AutoScribe ExamSession] normalized math expression:", formattedAns);

      const answerInput = document.getElementById('answerInput');
      console.log("[AutoScribe ExamSession] answerInput element found:", !!answerInput);

      if (answerInput) {
        answerInput.value = formattedAns;
        console.log("[AutoScribe ExamSession] answerInput value after update:", answerInput.value);
      }
      this.saveCurrentAnswerSilently();

      // For Math Mode: Keep continuous dictation active without TTS cutting off the student mid-sentence
      if (isMath) {
        const saveStatus = document.getElementById('saveStatus');
        if (saveStatus) saveStatus.textContent = `🎙️ MATH ANSWER: ${formattedAns}`;
        return;
      }

      // Real-time interim updates during general non-math dictation
      if (isFinal === false) {
        return;
      }

      // Final dictation captured for general subjects -> transition to answer confirmation phase
      this.questionState = 'AWAITING_CONFIRMATION';
      this.mathState = 'MATH_AWAITING_CONFIRMATION';
      const readbackMsg = `Your recorded answer is: ${formattedAns}. Can I read your answer? If you want to change it, say change. Otherwise say no changes.`;

      AutoScribeSpeech.speak(readbackMsg, () => {
        AutoScribeSpeech.startListening(
          (t, f) => this.handleSubjectVoiceInput(t, f),
          (c, r) => this.handleSubjectVoiceInput(r, true)
        );
      });
      return;
    }


    // State 3: Confirming or Changing Answer
    if (this.questionState === 'AWAITING_CONFIRMATION' || this.mathState === 'MATH_AWAITING_CONFIRMATION') {
      if (/\b(change|modify|rewrite|edit|correct|wrong|different)\b/i.test(lower) && !/\bno changes?\b/i.test(lower)) {
        this.answerMode = true;
        this.waitingForAnswer = true;
        this.questionChoiceMode = false;
        this.questionState = 'RECORDING_ANSWER';
        this.mathState = 'MATH_RECORDING_ANSWER';

        AutoScribeSpeech.speak("Okay, start. I am listening.", () => {
          AutoScribeSpeech.startListening(
            (t, f) => this.handleSubjectVoiceInput(t, f),
            (c, r) => this.handleSubjectVoiceInput(r, true)
          );
        });
        return;
      }

      if (/\b(no changes|no change|no|keep|confirm|correct|fine|good|save|next|done|proceed|otherwise)\b/i.test(lower)) {
        // Exit answer mode cleanly after confirmation
        this.answerMode = false;
        this.waitingForAnswer = false;
        this.questionChoiceMode = false;

        this.saveCurrentAnswerSilently();
        AutoScribeSpeech.speak(`Answer saved for Question ${this.currentIndex + 1}.`, () => {
          this.currentIndex++;
          if (this.activeExam && this.currentIndex < this.activeExam.questions.length) {
            this.startQuestionFlow();
          } else if (this.activeExam) {
            AutoScribeSpeech.speak(`${this.activeExam.title} examination complete. Submitting your exam now.`, () => {
              this.executeFinalSubmission();
            });
          }
        });
        return;
      }

      // Unclear confirmation -> re-prompt
      AutoScribeSpeech.speak("If you want to change your answer, say change. Otherwise say no changes.", () => {
        AutoScribeSpeech.startListening(
          (t, f) => this.handleSubjectVoiceInput(t, f),
          (c, r) => this.handleSubjectVoiceInput(r, true)
        );
      });
      return;
    }
  },

  autoSubmitTimeExpired() {
    AutoScribeSpeech.speak("Time is up. Exam submitted successfully.");
    this.executeFinalSubmission();
  }
};
