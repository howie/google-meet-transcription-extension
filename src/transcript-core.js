(function exposeTranscriptCore(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.MeetTranscriptCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createTranscriptCore() {
  "use strict";

  const STORAGE_KEYS = Object.freeze({
    index: "meetTranscript.sessionIndex.v1",
    active: "meetTranscript.activeSessions.v1",
    sessionPrefix: "meetTranscript.session.v1."
  });

  const FINALIZE_GRACE_MS = 1_200;
  const RECONNECT_WINDOW_MS = 5 * 60 * 1_000;

  function sessionStorageKey(sessionId) {
    return `${STORAGE_KEYS.sessionPrefix}${sessionId}`;
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeSpeaker(value) {
    return normalizeText(value) || "未知講者";
  }

  function meetingCodeFromUrl(value) {
    try {
      const url = new URL(value);
      if (url.hostname !== "meet.google.com") return "unknown-meeting";

      const firstPathPart = url.pathname.split("/").filter(Boolean)[0] || "";
      if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(firstPathPart)) {
        return firstPathPart.toLowerCase();
      }
    } catch (_error) {
      // Fall through to the stable fallback below.
    }

    return "unknown-meeting";
  }

  function createId(prefix, now) {
    const randomPart =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2, 12);
    return `${prefix}-${now}-${randomPart}`;
  }

  function createSession({ meetingCode, title, now = Date.now() }) {
    const timestamp = new Date(now).toISOString();

    return {
      schemaVersion: 1,
      id: createId("session", now),
      meetingCode: normalizeText(meetingCode) || "unknown-meeting",
      title: normalizeText(title) || "Google Meet",
      status: "capturing",
      startedAt: timestamp,
      updatedAt: timestamp,
      stoppedAt: null,
      segments: []
    };
  }

  function characterBigrams(value) {
    const text = normalizeText(value).toLowerCase();
    if (text.length < 2) return new Set(text ? [text] : []);

    const result = new Set();
    for (let index = 0; index < text.length - 1; index += 1) {
      result.add(text.slice(index, index + 2));
    }
    return result;
  }

  function textSimilarity(left, right) {
    const a = characterBigrams(left);
    const b = characterBigrams(right);
    if (a.size === 0 || b.size === 0) return 0;

    let intersection = 0;
    for (const item of a) {
      if (b.has(item)) intersection += 1;
    }
    return intersection / Math.max(a.size, b.size);
  }

  function textsAreRelated(previousText, nextText) {
    const previous = normalizeText(previousText);
    const next = normalizeText(nextText);
    if (!previous || !next) return false;
    if (previous === next) return true;
    if (previous.startsWith(next) || next.startsWith(previous)) return true;
    if (previous.includes(next) || next.includes(previous)) return true;
    return textSimilarity(previous, next) >= 0.35;
  }

  function isLikelyNewUtterance(previousText, nextText) {
    const previous = normalizeText(previousText);
    const next = normalizeText(nextText);

    if (!previous || !next || textsAreRelated(previous, next)) return false;

    const substantialReset =
      previous.length >= 24 && next.length <= Math.max(16, previous.length * 0.55);
    const sentenceEnded = /[。！？.!?]$/.test(previous);
    const weakOverlap = textSimilarity(previous, next) < 0.18;

    return substantialReset || (sentenceEnded && weakOverlap);
  }

  function cloneSegments(segments) {
    return Array.isArray(segments)
      ? segments.map((segment) => ({ ...segment }))
      : [];
  }

  class CaptionAccumulator {
    constructor(segments = []) {
      this.segments = cloneSegments(segments);
      this.activeRows = new Map();
      this.boundSegmentIds = new Set();
      this.sequence = this.segments.length;
    }

    getSegments() {
      return cloneSegments(this.segments);
    }

    segmentById(segmentId) {
      return this.segments.find((segment) => segment.id === segmentId) || null;
    }

    findReconnectableSegment(speaker, text, observedAt) {
      for (let index = this.segments.length - 1; index >= 0; index -= 1) {
        const segment = this.segments[index];
        if (segment.status !== "draft" || this.boundSegmentIds.has(segment.id)) continue;
        if (normalizeSpeaker(segment.speaker) !== speaker) continue;

        const updatedAt = Date.parse(segment.updatedAt || segment.startedAt || "");
        if (Number.isFinite(updatedAt) && observedAt - updatedAt > RECONNECT_WINDOW_MS) {
          continue;
        }

        if (textsAreRelated(segment.text, text)) return segment;
      }

      return null;
    }

    appendSegment(sourceKey, speaker, text, observedAt) {
      this.sequence += 1;
      const timestamp = new Date(observedAt).toISOString();
      const segment = {
        id: `segment-${observedAt}-${this.sequence}`,
        sourceKey,
        speaker,
        text,
        status: "draft",
        startedAt: timestamp,
        updatedAt: timestamp,
        finalizedAt: null
      };

      this.segments.push(segment);
      this.boundSegmentIds.add(segment.id);
      this.activeRows.set(sourceKey, {
        segmentId: segment.id,
        lastSeenAt: observedAt,
        missingSince: null
      });
      return segment;
    }

    finalizeSegment(segment, observedAt) {
      if (!segment || segment.status === "final") return false;
      const timestamp = new Date(observedAt).toISOString();
      segment.status = "final";
      segment.updatedAt = timestamp;
      segment.finalizedAt = timestamp;
      return true;
    }

    startOrReconnectRow(sourceKey, speaker, text, observedAt) {
      const reconnectable = this.findReconnectableSegment(speaker, text, observedAt);
      if (reconnectable) {
        reconnectable.sourceKey = sourceKey;
        reconnectable.status = "draft";
        reconnectable.finalizedAt = null;
        this.boundSegmentIds.add(reconnectable.id);
        this.activeRows.set(sourceKey, {
          segmentId: reconnectable.id,
          lastSeenAt: observedAt,
          missingSince: null
        });
        return { segment: reconnectable, changed: false };
      }

      return {
        segment: this.appendSegment(sourceKey, speaker, text, observedAt),
        changed: true
      };
    }

    applySnapshot(rows, observedAt = Date.now()) {
      const normalizedRows = [];
      const seenSourceKeys = new Set();

      for (const row of Array.isArray(rows) ? rows : []) {
        const sourceKey = normalizeText(row && row.sourceKey);
        const text = normalizeText(row && row.text);
        if (!sourceKey || !text || seenSourceKeys.has(sourceKey)) continue;

        seenSourceKeys.add(sourceKey);
        normalizedRows.push({
          sourceKey,
          speaker: normalizeSpeaker(row.speaker),
          text
        });
      }

      let changed = false;

      for (const row of normalizedRows) {
        let active = this.activeRows.get(row.sourceKey);
        if (!active) {
          const started = this.startOrReconnectRow(
            row.sourceKey,
            row.speaker,
            row.text,
            observedAt
          );
          active = this.activeRows.get(row.sourceKey);
          changed = started.changed || changed;
        }

        let segment = this.segmentById(active.segmentId);
        if (!segment) {
          segment = this.appendSegment(row.sourceKey, row.speaker, row.text, observedAt);
          active = this.activeRows.get(row.sourceKey);
          changed = true;
        }

        if (
          segment.speaker !== row.speaker ||
          isLikelyNewUtterance(segment.text, row.text)
        ) {
          changed = this.finalizeSegment(segment, observedAt) || changed;
          this.boundSegmentIds.delete(segment.id);
          segment = this.appendSegment(row.sourceKey, row.speaker, row.text, observedAt);
          active = this.activeRows.get(row.sourceKey);
          changed = true;
        } else if (segment.text !== row.text) {
          // Meet occasionally renders an older, shorter interim value. Keep the
          // longer prefix until a newer revision arrives instead of regressing.
          const isTemporaryRegression = segment.text.startsWith(row.text);
          if (!isTemporaryRegression) {
            segment.text = row.text;
            segment.speaker = row.speaker;
            segment.updatedAt = new Date(observedAt).toISOString();
            changed = true;
          }
        }

        active.lastSeenAt = observedAt;
        active.missingSince = null;
      }

      for (const [sourceKey, active] of this.activeRows.entries()) {
        if (seenSourceKeys.has(sourceKey)) continue;

        if (active.missingSince === null) {
          active.missingSince = observedAt;
          continue;
        }

        if (observedAt - active.missingSince >= FINALIZE_GRACE_MS) {
          const segment = this.segmentById(active.segmentId);
          changed = this.finalizeSegment(segment, observedAt) || changed;
          this.boundSegmentIds.delete(active.segmentId);
          this.activeRows.delete(sourceKey);
        }
      }

      return changed;
    }

    finalizeAll(observedAt = Date.now()) {
      let changed = false;
      for (const active of this.activeRows.values()) {
        changed = this.finalizeSegment(this.segmentById(active.segmentId), observedAt) || changed;
      }
      this.activeRows.clear();
      this.boundSegmentIds.clear();
      return changed;
    }
  }

  function escapeMarkdownInline(value) {
    return normalizeText(value).replace(/([\\`*_{}\[\]<>])/g, "\\$1");
  }

  function displayDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未知";
    return date.toLocaleString("zh-TW", { hour12: false });
  }

  function displayTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--:--:--";
    return date.toLocaleTimeString("zh-TW", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
  }

  function exportableSegments(session) {
    return Array.isArray(session && session.segments)
      ? session.segments.filter((segment) => normalizeText(segment.text))
      : [];
  }

  function formatMarkdown(session) {
    const segments = exportableSegments(session);
    const lines = [
      "# Google Meet 逐字稿",
      "",
      `- 會議：${escapeMarkdownInline(session && session.title) || "Google Meet"}`,
      `- 會議代碼：${escapeMarkdownInline(session && session.meetingCode) || "未知"}`,
      `- 開始時間：${displayDateTime(session && session.startedAt)}`,
      `- 結束時間：${displayDateTime(
        (session && (session.stoppedAt || session.updatedAt)) || ""
      )}`,
      `- 字幕段落：${segments.length}`,
      "",
      "## 逐字內容",
      ""
    ];

    if (segments.length === 0) {
      lines.push("_尚未擷取到字幕。_", "");
      return lines.join("\n");
    }

    for (const segment of segments) {
      lines.push(
        `### ${displayTime(segment.startedAt)} — ${escapeMarkdownInline(segment.speaker)}`,
        "",
        normalizeText(segment.text),
        ""
      );
    }

    return lines.join("\n");
  }

  function formatJson(session, exportedAt = Date.now()) {
    return JSON.stringify(
      {
        schemaVersion: 1,
        exportedAt: new Date(exportedAt).toISOString(),
        session: {
          ...session,
          segments: exportableSegments(session)
        }
      },
      null,
      2
    );
  }

  function safeFilenamePart(value) {
    const cleaned = normalizeText(value)
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.\s]+|[-.\s]+$/g, "")
      .slice(0, 80);
    return cleaned || "google-meet";
  }

  function exportFilename(session, extension) {
    const date = new Date(session && session.startedAt);
    const datePart = Number.isNaN(date.getTime())
      ? "unknown-date"
      : date.toISOString().replace(/[:.]/g, "-");
    const meetingPart = safeFilenamePart(
      (session && (session.meetingCode || session.title)) || "google-meet"
    );
    return `${meetingPart}-${datePart}.${extension}`;
  }

  return Object.freeze({
    CaptionAccumulator,
    FINALIZE_GRACE_MS,
    RECONNECT_WINDOW_MS,
    STORAGE_KEYS,
    createSession,
    exportFilename,
    formatJson,
    formatMarkdown,
    isLikelyNewUtterance,
    meetingCodeFromUrl,
    normalizeSpeaker,
    normalizeText,
    sessionStorageKey,
    textSimilarity,
    textsAreRelated
  });
});
