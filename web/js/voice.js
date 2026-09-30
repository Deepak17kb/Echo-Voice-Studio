// Browser speech recognition with keep-alive, live microphone levels, and spoken replies.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const FATAL_ERRORS = new Set([
  "not-allowed",
  "service-not-allowed",
  "audio-capture",
  "network",
  "language-not-supported",
  "bad-grammar",
]);

export const speechSupported = Boolean(Recognition);

let activeSession = null;

export function recognitionErrorMessage(error) {
  if (error === "not-allowed" || error === "service-not-allowed") {
    return "Microphone access was declined. Allow it from the lock icon in the address bar to use your voice.";
  }
  if (error === "audio-capture") return "Your microphone is unavailable. Check that it's connected and not in use by another app.";
  if (error === "network") return "Your browser's speech service needs an internet connection. Typing still works.";
  if (error === "no-speech") return "I didn't catch any words. Take a breath and try again.";
  if (error === "language-not-supported") return "Your browser can't transcribe that language. Try another one.";
  if (error === "unsupported") return "Voice input isn't supported in this browser. Chrome or Edge work best; you can type instead.";
  return `Voice input stopped (${error}). You can keep typing instead.`;
}

async function startMeter(onLevel) {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !Context) return null;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const context = new Context();
  const analyser = context.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.78;
  context.createMediaStreamSource(stream).connect(analyser);
  const bins = new Uint8Array(analyser.frequencyBinCount);
  let frame = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    analyser.getByteFrequencyData(bins);
    let total = 0;
    for (let index = 0; index < bins.length; index += 1) total += bins[index];
    onLevel(Math.min(1, total / bins.length / 90), bins);
    frame = window.requestAnimationFrame(tick);
  };
  tick();
  return {
    stop() {
      stopped = true;
      window.cancelAnimationFrame(frame);
      stream.getTracks().forEach((track) => track.stop());
      context.close().catch(() => {});
    },
  };
}

/**
 * One listening session. Options: lang, continuous, keepAlive (restart after pauses until
 * stopped), meter (report mic levels via onLevel), and callbacks onStart, onInterim,
 * onFinal, onError, onEnd, onMeterUnavailable.
 */
export class VoiceSession {
  constructor(options = {}) {
    this.options = { lang: "en-US", continuous: false, keepAlive: false, meter: false, ...options };
    this.running = false;
    this.stopping = false;
    this.heardSpeech = false;
    this.error = null;
    this.recognition = null;
    this.meter = null;
    this.quickRestarts = 0;
    this.listenedAt = 0;
  }

  get isRunning() {
    return this.running;
  }

  start() {
    if (!Recognition) {
      this.options.onError?.("unsupported");
      return false;
    }
    if (activeSession && activeSession !== this) activeSession.stop();
    activeSession = this;
    this.running = true;
    this.stopping = false;
    this.heardSpeech = false;
    this.error = null;
    this.quickRestarts = 0;
    this.listen(true);
    if (this.options.meter && this.options.onLevel) {
      startMeter(this.options.onLevel)
        .then((meter) => {
          if (!meter) this.options.onMeterUnavailable?.();
          else if (this.running) this.meter = meter;
          else meter.stop();
        })
        .catch(() => this.options.onMeterUnavailable?.());
    }
    return true;
  }

  stop() {
    if (!this.running) return;
    this.stopping = true;
    try {
      this.recognition?.stop();
    } catch {
      this.finish();
    }
  }

  abort() {
    if (!this.running) return;
    this.stopping = true;
    try {
      this.recognition?.abort();
    } catch {
      // Already stopped.
    }
    this.finish();
  }

  listen(first) {
    const recognition = new Recognition();
    recognition.lang = this.options.lang;
    recognition.continuous = this.options.continuous;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      this.listenedAt = Date.now();
      if (first) this.options.onStart?.();
    };
    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          if (transcript.trim()) {
            this.heardSpeech = true;
            this.options.onFinal?.(transcript.trim());
          }
        } else {
          interim += transcript;
        }
      }
      this.options.onInterim?.(interim.trim());
    };
    recognition.onerror = (event) => {
      if (event.error === "aborted") return;
      if (event.error === "no-speech" && this.options.keepAlive && !this.stopping) return;
      this.error = event.error;
      if (FATAL_ERRORS.has(event.error) || !this.options.keepAlive) this.stopping = true;
      this.options.onError?.(event.error);
    };
    recognition.onend = () => {
      this.options.onInterim?.("");
      if (this.running && this.options.keepAlive && !this.stopping) {
        this.quickRestarts = Date.now() - this.listenedAt < 1200 ? this.quickRestarts + 1 : 0;
        if (this.quickRestarts < 5) {
          this.listen(false); // browsers end recognition after a pause; keep dictating
          return;
        }
      }
      this.finish();
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch {
      this.options.onError?.("start-failed");
      this.finish();
    }
  }

  finish() {
    if (!this.running) return;
    this.running = false;
    this.recognition = null;
    this.meter?.stop();
    this.meter = null;
    this.options.onLevel?.(0, null);
    if (activeSession === this) activeSession = null;
    this.options.onEnd?.({ heardSpeech: this.heardSpeech, error: this.error });
  }
}

export function stopAllVoice() {
  activeSession?.abort();
}

export function speak(text, lang = "en-US") {
  const synth = window.speechSynthesis;
  if (!synth || !window.SpeechSynthesisUtterance || !text) return false;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(String(text).slice(0, 4000));
  utterance.lang = lang;
  utterance.rate = 1.02;
  const voices = synth.getVoices();
  const voice = voices.find((item) => item.lang === lang) || voices.find((item) => item.lang?.startsWith(lang.slice(0, 2)));
  if (voice) utterance.voice = voice;
  synth.speak(utterance);
  return true;
}

export function stopSpeaking() {
  window.speechSynthesis?.cancel();
}
