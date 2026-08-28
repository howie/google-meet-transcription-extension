(function runMeetTranscriptContentScript() {
  "use strict";

  const core = globalThis.MeetTranscriptCore;
  if (!core) return;

  const CAPTION_LABEL_TOKENS = [
    "caption",
    "subtitle",
    "即時字幕",
    "字幕",
    "자막",
    "subtítulo",
    "sous-titre",
    "untertitel",
    "legenda"
  ];
  const REDISCOVER_INTERVAL_MS = 1_000;
  const SCAN_DEBOUNCE_MS = 120;
  const PERSIST_DEBOUNCE_MS = 400;
  const ACTIVE_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1_000;

  const nodeIds = new WeakMap();
  let nextNodeId = 0;
  let capturing = false;
  let captionContainer = null;
  let captionDetectedAt = null;
  let observer = null;
  let scanTimer = null;
  let pollTimer = null;
  let persistTimer = null;
  let persistChain = Promise.resolve();
  let session = null;
  let accumulator = null;
  let lastError = null;

  function nodeSourceKey(node) {
    let id = nodeIds.get(node);
    if (!id) {
      nextNodeId += 1;
      id = `caption-row-${nextNodeId}`;
      nodeIds.set(node, id);
    }
    return id;
  }

  function elementText(node) {
    return core.normalizeText(node && node.textContent);
  }

  function looksLikeProfileImage(image) {
    if (!image || image.tagName !== "IMG" || image.closest("button")) return false;
    const source = (image.getAttribute("src") || "").trim();
    return source.startsWith("https://") || source.startsWith("data:");
  }

  function parseCaptionFromImage(image) {
    if (!looksLikeProfileImage(image)) return null;

    const identityContainer = image.parentElement;
    const transcriptContainer = identityContainer && identityContainer.nextElementSibling;
    const row = identityContainer && identityContainer.parentElement;
    if (!identityContainer || !transcriptContainer || !row) return null;
    if (row.closest("button") || transcriptContainer.querySelector("button")) return null;

    const text = elementText(transcriptContainer);
    if (!text) return null;

    const siblingSpeaker = elementText(image.nextElementSibling);
    const imageSpeaker = core.normalizeText(image.getAttribute("alt"));
    const speaker = siblingSpeaker || imageSpeaker || "未知講者";

    return {
      row,
      sourceKey: nodeSourceKey(row),
      speaker,
      text
    };
  }

  function captionRowsFrom(container) {
    if (!container || !container.querySelectorAll) return [];

    const rows = [];
    const seenNodes = new Set();
    for (const image of container.querySelectorAll("img")) {
      const parsed = parseCaptionFromImage(image);
      if (!parsed || seenNodes.has(parsed.row)) continue;
      seenNodes.add(parsed.row);
      rows.push(parsed);
    }
    return rows;
  }

  function labelLooksLikeCaptions(node) {
    const label = core.normalizeText(node && node.getAttribute("aria-label")).toLowerCase();
    return CAPTION_LABEL_TOKENS.some((token) => label.includes(token));
  }

  function hasCaptionRowPattern(node) {
    return captionRowsFrom(node).length > 0;
  }

  function isVisible(node) {
    if (!node || !node.isConnected) return false;
    const bounds = node.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  }

  function findCaptionContainer() {
    if (!document.body) return null;

    const labelledRegions = document.body.querySelectorAll('[role="region"][aria-label]');
    for (const region of labelledRegions) {
      if (labelLooksLikeCaptions(region) && (isVisible(region) || hasCaptionRowPattern(region))) {
        return region;
      }
    }

    const liveRegions = document.body.querySelectorAll(
      '[role="region"][aria-live], [aria-live="polite"], [aria-live="assertive"]'
    );
    for (const region of liveRegions) {
      if (hasCaptionRowPattern(region)) return region;
    }

    return null;
  }

  function currentMeetingCode() {
    return core.meetingCodeFromUrl(window.location.href);
  }

  async function readStoredSession(sessionId) {
    if (!sessionId) return null;
    const key = core.sessionStorageKey(sessionId);
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  }

  async function addSessionToIndex(sessionId) {
    const result = await chrome.storage.local.get(core.STORAGE_KEYS.index);
    const existing = Array.isArray(result[core.STORAGE_KEYS.index])
      ? result[core.STORAGE_KEYS.index]
      : [];
    const next = [sessionId, ...existing.filter((id) => id !== sessionId)];
    await chrome.storage.local.set({ [core.STORAGE_KEYS.index]: next });
  }

  async function markSessionActive(sessionId) {
    const result = await chrome.storage.local.get(core.STORAGE_KEYS.active);
    const active = { ...(result[core.STORAGE_KEYS.active] || {}) };
    active[currentMeetingCode()] = sessionId;
    await chrome.storage.local.set({ [core.STORAGE_KEYS.active]: active });
  }

  async function clearActiveSession(sessionId) {
    const result = await chrome.storage.local.get(core.STORAGE_KEYS.active);
    const active = { ...(result[core.STORAGE_KEYS.active] || {}) };
    if (active[currentMeetingCode()] === sessionId) {
      delete active[currentMeetingCode()];
      await chrome.storage.local.set({ [core.STORAGE_KEYS.active]: active });
    }
  }

  async function persistNow() {
    if (!session || !accumulator) return;

    const snapshot = {
      ...session,
      segments: accumulator.getSegments(),
      updatedAt: new Date().toISOString()
    };
    session = snapshot;
    const key = core.sessionStorageKey(snapshot.id);

    persistChain = persistChain
      .catch(() => undefined)
      .then(() => chrome.storage.local.set({ [key]: snapshot }))
      .then(() => {
        lastError = null;
      })
      .catch((error) => {
        lastError = error instanceof Error ? error.message : String(error);
      });

    await persistChain;
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = window.setTimeout(() => {
      persistTimer = null;
      void persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  function scanCaptions() {
    scanTimer = null;
    if (!capturing || !accumulator) return;

    if (!captionContainer || !captionContainer.isConnected) {
      captionContainer = findCaptionContainer();
      if (captionContainer && !captionDetectedAt) {
        captionDetectedAt = new Date().toISOString();
      }
    }

    const rows = captionContainer ? captionRowsFrom(captionContainer) : [];
    if (accumulator.applySnapshot(rows, Date.now())) schedulePersist();
  }

  function scheduleScan() {
    if (scanTimer || !capturing) return;
    scanTimer = window.setTimeout(scanCaptions, SCAN_DEBOUNCE_MS);
  }

  function mutationTouchesCaptionContainer(mutation) {
    if (!captionContainer) return true;
    if (!captionContainer.isConnected) return true;
    return mutation.target === captionContainer || captionContainer.contains(mutation.target);
  }

  function beginObserving() {
    if (observer || !document.body) return;

    observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesCaptionContainer)) scheduleScan();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    pollTimer = window.setInterval(scanCaptions, REDISCOVER_INTERVAL_MS);
    scanCaptions();
  }

  function endObserving() {
    if (observer) observer.disconnect();
    observer = null;

    if (scanTimer) window.clearTimeout(scanTimer);
    if (pollTimer) window.clearInterval(pollTimer);
    scanTimer = null;
    pollTimer = null;
    captionContainer = null;
  }

  async function startCapture() {
    if (capturing && session) return statusPayload();

    const now = Date.now();
    session = core.createSession({
      meetingCode: currentMeetingCode(),
      title: document.title,
      now
    });
    accumulator = new core.CaptionAccumulator();
    capturing = true;
    captionDetectedAt = null;
    lastError = null;

    await Promise.all([addSessionToIndex(session.id), markSessionActive(session.id)]);
    await persistNow();
    beginObserving();
    return statusPayload();
  }

  async function stopCapture() {
    if (!capturing || !session || !accumulator) return statusPayload();

    scanCaptions();
    accumulator.finalizeAll(Date.now());
    capturing = false;
    endObserving();
    session.status = "stopped";
    session.stoppedAt = new Date().toISOString();

    if (persistTimer) window.clearTimeout(persistTimer);
    persistTimer = null;
    await persistNow();
    await clearActiveSession(session.id);
    return statusPayload();
  }

  function statusPayload() {
    return {
      ok: true,
      isMeet: true,
      capturing,
      captionDetected: Boolean(captionContainer),
      captionDetectedAt,
      sessionId: session && session.id,
      segmentCount: accumulator ? accumulator.getSegments().length : 0,
      lastError
    };
  }

  async function restoreCaptureIfNeeded() {
    try {
      const result = await chrome.storage.local.get(core.STORAGE_KEYS.active);
      const active = result[core.STORAGE_KEYS.active] || {};
      const sessionId = active[currentMeetingCode()];
      const stored = await readStoredSession(sessionId);
      if (!stored || stored.status !== "capturing") return;

      const updatedAt = Date.parse(stored.updatedAt || stored.startedAt || "");
      if (
        Number.isFinite(updatedAt) &&
        Date.now() - updatedAt > ACTIVE_SESSION_MAX_AGE_MS
      ) {
        await clearActiveSession(sessionId);
        return;
      }

      session = stored;
      accumulator = new core.CaptionAccumulator(stored.segments);
      capturing = true;
      beginObserving();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;

    if (message.type === "MEET_TRANSCRIPT_GET_STATUS") {
      sendResponse(statusPayload());
      return false;
    }

    if (message.type === "MEET_TRANSCRIPT_START") {
      startCapture()
        .then(sendResponse)
        .catch((error) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        );
      return true;
    }

    if (message.type === "MEET_TRANSCRIPT_STOP") {
      stopCapture()
        .then(sendResponse)
        .catch((error) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        );
      return true;
    }

    return false;
  });

  window.addEventListener("pagehide", () => {
    if (capturing) void persistNow();
  });

  void restoreCaptureIfNeeded();
})();
