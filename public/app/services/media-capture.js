export class MediaCaptureService {
  constructor() {
    this.maxDurationMs = 30000;
    this.activeSession = null;
    this.pendingCapture = null;
  }

  inspectAvailableSources() {
    const mediaElements = findMediaElements();
    const candidates = mediaElements.map((element, index) => describeMediaElement(element, index));

    return {
      supported: {
        mediaRecorder: typeof window.MediaRecorder === "function",
        audioContext: typeof window.AudioContext === "function" || typeof window.webkitAudioContext === "function"
      },
      candidates,
      recordableCandidates: candidates
        .filter((candidate) => candidate.canUseSrcObject || candidate.canUseCaptureStream)
        .map((candidate) => ({ ...candidate }))
    };
  }

  async captureSnippet(options = {}) {
    if (typeof window.MediaRecorder !== "function") {
      throw new Error("MediaRecorder is not available in this runtime.");
    }

    const durationMs = normalizeDuration(options.durationMs, this.maxDurationMs);
    const source = await resolveCaptureSource(options);
    const mimeType = pickMimeType(options.mimeType);
    const recorder = new MediaRecorder(source.stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    const signalMonitor = startSignalMonitor(source.stream);

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    const stopped = waitForStop(recorder);
    recorder.start(options.timesliceMs ?? 250);

    try {
      await wait(durationMs);
    } finally {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }

    await stopped;
    const signal = stopSignalMonitor(signalMonitor);
    cleanupSource(source);

    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
    const audioBase64 = await blobToBase64(blob);

    return {
      source: source.description,
      signal,
      fileName: options.fileName ?? buildFileName(blob.type),
      mimeType: blob.type || "audio/webm",
      sizeBytes: blob.size,
      durationMs,
      metadata: options.metadata ?? null,
      audioBase64
    };
  }

  async startCapture(options = {}) {
    if (typeof window.MediaRecorder !== "function") {
      throw new Error("MediaRecorder is not available in this runtime.");
    }

    if (this.activeSession) {
      throw new Error("An audio capture session is already in progress.");
    }

    if (this.pendingCapture) {
      throw new Error("A completed recording is waiting for confirm or cancel.");
    }

    const source = await resolveCaptureSource(options);
    const mimeType = pickMimeType(options.mimeType);
    const recorder = new MediaRecorder(source.stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    const startedAt = Date.now();
    const signalMonitor = startSignalMonitor(source.stream);

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    recorder.start(options.timesliceMs ?? 250);
    this.activeSession = {
      recorder,
      source,
      signalMonitor,
      chunks,
      startedAt,
      options
    };

    return {
      recording: true,
      startedAt: new Date(startedAt).toISOString(),
      source: source.description,
      fileName: options.fileName ?? null,
      metadata: options.metadata ?? null
    };
  }

  async stopCapture(options = {}) {
    if (!this.activeSession) {
      throw new Error("No audio capture session is currently active.");
    }

    const session = this.activeSession;
    this.activeSession = null;
    const { recorder, source, signalMonitor, chunks, startedAt, options: startedOptions } = session;
    const stopped = waitForStop(recorder);

    if (recorder.state !== "inactive") {
      recorder.stop();
    }

    await stopped;
  const signal = stopSignalMonitor(signalMonitor);
    cleanupSource(source);

    const mimeType = recorder.mimeType || pickMimeType(startedOptions.mimeType) || "audio/webm";
    const blob = new Blob(chunks, { type: mimeType });
    const audioBase64 = await blobToBase64(blob);
    const durationMs = Date.now() - startedAt;

    const completedCapture = {
      source: source.description,
      signal,
      fileName: options.fileName ?? startedOptions.fileName ?? buildFileName(blob.type),
      mimeType: blob.type || "audio/webm",
      sizeBytes: blob.size,
      durationMs,
      startedAt: new Date(startedAt).toISOString(),
      stoppedAt: new Date().toISOString(),
      metadata: options.metadata ?? startedOptions.metadata ?? null,
      audioBase64
    };

    this.pendingCapture = completedCapture;
    return {
      source: completedCapture.source,
      signal: completedCapture.signal,
      fileName: completedCapture.fileName,
      mimeType: completedCapture.mimeType,
      sizeBytes: completedCapture.sizeBytes,
      durationMs: completedCapture.durationMs,
      startedAt: completedCapture.startedAt,
      stoppedAt: completedCapture.stoppedAt,
      metadata: completedCapture.metadata,
      awaitingConfirmation: true
    };
  }

  cancelCapture() {
    if (!this.pendingCapture) {
      throw new Error("No completed recording is waiting to be discarded.");
    }

    const discardedCapture = this.pendingCapture;
    this.pendingCapture = null;

    return {
      discarded: true,
      fileName: discardedCapture.fileName ?? null,
      durationMs: discardedCapture.durationMs ?? null,
      metadata: discardedCapture.metadata ?? null
    };
  }

  confirmCapture(options = {}) {
    if (!this.pendingCapture) {
      throw new Error("No completed recording is waiting for confirmation.");
    }

    const captureToConfirm = this.pendingCapture;
    this.pendingCapture = null;
    const metadata = options.metadata ?? captureToConfirm.metadata ?? null;

    return {
      ...captureToConfirm,
      fileName: options.fileName ?? captureToConfirm.fileName ?? null,
      metadata,
      confirmedAt: new Date().toISOString()
    };
  }

  getCaptureStatus() {
    if (!this.activeSession) {
      return this.pendingCapture
        ? {
          recording: false,
          awaitingConfirmation: true,
          fileName: this.pendingCapture.fileName ?? null,
          metadata: this.pendingCapture.metadata ?? null,
          startedAt: this.pendingCapture.startedAt ?? null,
          stoppedAt: this.pendingCapture.stoppedAt ?? null,
          durationMs: this.pendingCapture.durationMs ?? null
        }
        : {
          recording: false,
          awaitingConfirmation: false
        };
    }

    return {
      recording: true,
      awaitingConfirmation: false,
      startedAt: new Date(this.activeSession.startedAt).toISOString(),
      source: this.activeSession.source.description,
      fileName: this.activeSession.options.fileName ?? null,
      metadata: this.activeSession.options.metadata ?? null
    };
  }
}

function startSignalMonitor(stream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  if (typeof AudioContextClass !== "function") {
    return null;
  }

  const audioContext = new AudioContextClass();
  const sourceNode = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  const sampleBuffer = new Float32Array(analyser.fftSize);
  let sampleCount = 0;
  let activeSampleCount = 0;
  let totalRms = 0;
  let peak = 0;
  let timerId = null;

  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.2;
  sourceNode.connect(analyser);

  const measure = () => {
    analyser.getFloatTimeDomainData(sampleBuffer);
    let sumSquares = 0;
    let localPeak = 0;

    for (let index = 0; index < sampleBuffer.length; index += 1) {
      const sample = sampleBuffer[index];
      sumSquares += sample * sample;
      localPeak = Math.max(localPeak, Math.abs(sample));
    }

    const rms = Math.sqrt(sumSquares / sampleBuffer.length);
    totalRms += rms;
    peak = Math.max(peak, localPeak);
    sampleCount += 1;

    if (rms > 0.001 || localPeak > 0.01) {
      activeSampleCount += 1;
    }
  };

  timerId = window.setInterval(measure, 100);
  measure();

  return {
    audioContext,
    sourceNode,
    analyser,
    timerId,
    getSummary() {
      return {
        averageRms: sampleCount > 0 ? roundTo(totalRms / sampleCount, 6) : 0,
        peak: roundTo(peak, 6),
        activeSampleRatio: sampleCount > 0 ? roundTo(activeSampleCount / sampleCount, 4) : 0,
        probablySilent: activeSampleCount === 0
      };
    }
  };
}

function stopSignalMonitor(monitor) {
  if (!monitor) {
    return null;
  }

  const summary = monitor.getSummary();

  if (monitor.timerId !== null) {
    window.clearInterval(monitor.timerId);
  }

  monitor.sourceNode?.disconnect?.();
  monitor.analyser?.disconnect?.();
  monitor.audioContext?.close?.().catch?.(() => {});
  return summary;
}

function roundTo(value, digits) {
  return Number.parseFloat(Number(value).toFixed(digits));
}

function describeMediaElement(element, index) {
  const srcObject = element.srcObject instanceof MediaStream ? element.srcObject : null;
  const captureStream = typeof element.captureStream === "function" || typeof element.mozCaptureStream === "function";
  const descriptor = buildSelectorDescriptor(element, index);

  return {
    selector: descriptor.selector,
    description: descriptor.description,
    tagName: element.tagName.toLowerCase(),
    id: element.id || null,
    className: element.className || null,
    paused: Boolean(element.paused),
    muted: Boolean(element.muted),
    autoplay: Boolean(element.autoplay),
    readyState: element.readyState ?? null,
    currentSrc: element.currentSrc || element.src || null,
    hasSrcObject: Boolean(srcObject),
    srcObjectAudioTracks: srcObject?.getAudioTracks?.().length ?? 0,
    srcObjectVideoTracks: srcObject?.getVideoTracks?.().length ?? 0,
    canUseSrcObject: Boolean(srcObject?.getAudioTracks?.().length),
    canUseCaptureStream: captureStream
  };
}

async function resolveCaptureSource(options) {
  const selector = typeof options.selector === "string" && options.selector.trim()
    ? options.selector.trim()
    : null;

  if (selector) {
    const element = findElement(selector);

    if (!element) {
      const availableSelectors = findMediaElements()
        .map((candidate, index) => buildSelectorDescriptor(candidate, index).selector)
        .slice(0, 5);
      const details = availableSelectors.length > 0
        ? ` Available media selectors: ${availableSelectors.join(", ")}.`
        : " No visible audio or video elements were found in the document or open shadow roots.";

      throw new Error(`No media element matched selector: ${selector}.${details}`);
    }

    return createSourceFromElement(element, selector);
  }

  const candidates = sortMediaElementsForCapture(findMediaElements());

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];

    try {
      return createSourceFromElement(candidate, buildSelectorDescriptor(candidate, index).selector);
    } catch {
      continue;
    }
  }

  throw new Error("No recordable media element was found. The widget cannot currently see a live call audio stream.");
}

function findMediaElements() {
  return queryAllElements("audio, video");
}

function findElement(selector) {
  const matches = queryAllElements(selector);

  if (matches.length > 1 && isGenericMediaSelector(selector)) {
    return sortMediaElementsForCapture(matches)[0] ?? null;
  }

  return matches[0] ?? null;
}

function queryAllElements(selector) {
  const results = [];
  const roots = [document];
  const seenRoots = new Set();

  while (roots.length > 0) {
    const root = roots.shift();

    if (!root || seenRoots.has(root)) {
      continue;
    }

    seenRoots.add(root);

    if (typeof root.querySelectorAll === "function") {
      results.push(...root.querySelectorAll(selector));
    }

    const hostElements = typeof root.querySelectorAll === "function"
      ? root.querySelectorAll("*")
      : [];

    hostElements.forEach((element) => {
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
      }
    });
  }

  return Array.from(new Set(results));
}

function createSourceFromElement(element, selector) {
  const srcObject = element.srcObject instanceof MediaStream ? element.srcObject : null;

  if (srcObject?.getAudioTracks?.().length) {
    return {
      stream: cloneAudioStream(srcObject),
      description: {
        strategy: "srcObject",
        selector,
        tagName: element.tagName.toLowerCase()
      }
    };
  }

  const captureStream = typeof element.captureStream === "function"
    ? () => element.captureStream()
    : typeof element.mozCaptureStream === "function"
      ? () => element.mozCaptureStream()
      : null;

  if (captureStream) {
    const stream = captureStream();
    const audioTracks = stream?.getAudioTracks?.() ?? [];

    if (audioTracks.length > 0) {
      return {
        stream: cloneAudioStream(stream),
        description: {
          strategy: "captureStream",
          selector,
          tagName: element.tagName.toLowerCase()
        }
      };
    }
  }

  throw new Error(`Media element matched by ${selector} does not expose a recordable audio stream.`);
}

function sortMediaElementsForCapture(elements) {
  return [...elements].sort((left, right) => scoreMediaElement(right) - scoreMediaElement(left));
}

function scoreMediaElement(element) {
  const descriptor = `${element.id ?? ""} ${element.className ?? ""} ${element.getAttribute?.("aria-label") ?? ""}`.toLowerCase();
  const srcObject = element.srcObject instanceof MediaStream ? element.srcObject : null;
  const audioTrackCount = srcObject?.getAudioTracks?.().length ?? 0;
  let score = 0;

  if (audioTrackCount > 0) {
    score += 50;
  }

  if (!element.muted) {
    score += 20;
  }

  if (!element.paused) {
    score += 10;
  }

  if (descriptor.includes("remote")) {
    score += 40;
  }

  if (descriptor.includes("local")) {
    score -= 25;
  }

  if (element.tagName?.toLowerCase() === "audio") {
    score += 5;
  }

  return score;
}

function isGenericMediaSelector(selector) {
  const normalizedSelector = String(selector).trim().toLowerCase();
  return normalizedSelector === "audio"
    || normalizedSelector === "video"
    || normalizedSelector === "audio, video"
    || normalizedSelector === "video, audio";
}

function cleanupSource(source) {
  source.stream?.getTracks?.().forEach((track) => track.stop());
}

function cloneAudioStream(stream) {
  const audioTracks = stream.getAudioTracks();

  if (!audioTracks.length) {
    throw new Error("The selected media source does not contain any audio tracks.");
  }

  return new MediaStream(audioTracks.map((track) => track.clone()));
}

function pickMimeType(preferredMimeType) {
  if (preferredMimeType && MediaRecorder.isTypeSupported?.(preferredMimeType)) {
    return preferredMimeType;
  }

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus"
  ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported?.(candidate)) ?? "";
}

function normalizeDuration(value, maxDurationMs) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 5000;
  }

  return Math.min(Math.floor(parsed), maxDurationMs);
}

function waitForStop(recorder) {
  return new Promise((resolve, reject) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.addEventListener("error", (event) => reject(event.error ?? new Error("MediaRecorder failed.")), { once: true });
  });
}

function wait(durationMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const [, base64 = ""] = dataUrl.split(",");
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read recorded audio."));
    reader.readAsDataURL(blob);
  });
}

function buildFileName(mimeType) {
  const extension = mimeType.includes("ogg") ? "ogg" : "webm";
  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  return `signature-${timestamp}.${extension}`;
}

function buildSelectorDescriptor(element, index) {
  if (element.id) {
    return {
      selector: `#${escapeCssIdentifier(element.id)}`,
      description: `${element.tagName.toLowerCase()}#${element.id}`
    };
  }

  const classList = Array.from(element.classList ?? []).filter(Boolean);

  if (classList.length > 0) {
    return {
      selector: `${element.tagName.toLowerCase()}.${classList.map(escapeCssIdentifier).join(".")}`,
      description: `${element.tagName.toLowerCase()}.${classList.join(".")}`
    };
  }

  return {
    selector: `${element.tagName.toLowerCase()}:nth-of-type(${index + 1})`,
    description: `${element.tagName.toLowerCase()}[${index}]`
  };
}

function escapeCssIdentifier(value) {
  if (typeof window.CSS?.escape === "function") {
    return window.CSS.escape(value);
  }

  return String(value).replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}
