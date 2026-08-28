"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CaptionAccumulator,
  FINALIZE_GRACE_MS,
  createSession,
  exportFilename,
  formatJson,
  formatMarkdown,
  meetingCodeFromUrl,
  normalizeText
} = require("../src/transcript-core.js");

test("normalizes whitespace and extracts a Meet code", () => {
  assert.equal(normalizeText(" 今天\n  我們  開會 "), "今天 我們 開會");
  assert.equal(
    meetingCodeFromUrl("https://meet.google.com/abc-defg-hij?authuser=0"),
    "abc-defg-hij"
  );
  assert.equal(meetingCodeFromUrl("https://example.com/abc-defg-hij"), "unknown-meeting");
});

test("progressive captions update one draft instead of creating duplicates", () => {
  const accumulator = new CaptionAccumulator();
  const startedAt = Date.parse("2026-08-28T02:58:49.000Z");

  accumulator.applySnapshot(
    [{ sourceKey: "row-1", speaker: "Howie", text: "今天" }],
    startedAt
  );
  accumulator.applySnapshot(
    [{ sourceKey: "row-1", speaker: "Howie", text: "今天我們討論" }],
    startedAt + 500
  );

  const segments = accumulator.getSegments();
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, "今天我們討論");
  assert.equal(segments[0].status, "draft");
});

test("a temporary shorter caption does not erase the longer value", () => {
  const accumulator = new CaptionAccumulator();
  const startedAt = Date.now();

  accumulator.applySnapshot(
    [{ sourceKey: "row-1", speaker: "Howie", text: "今天我們討論產品時程" }],
    startedAt
  );
  accumulator.applySnapshot(
    [{ sourceKey: "row-1", speaker: "Howie", text: "今天我們討論" }],
    startedAt + 100
  );

  assert.equal(accumulator.getSegments()[0].text, "今天我們討論產品時程");
});

test("a missing caption row is finalized after the grace period", () => {
  const accumulator = new CaptionAccumulator();
  const startedAt = Date.now();

  accumulator.applySnapshot(
    [{ sourceKey: "row-1", speaker: "Howie", text: "第一段字幕" }],
    startedAt
  );
  accumulator.applySnapshot([], startedAt + 100);
  accumulator.applySnapshot([], startedAt + 100 + FINALIZE_GRACE_MS);

  assert.equal(accumulator.getSegments()[0].status, "final");
});

test("a speaker change on a reused DOM row starts another segment", () => {
  const accumulator = new CaptionAccumulator();
  const startedAt = Date.now();

  accumulator.applySnapshot(
    [{ sourceKey: "row-1", speaker: "Howie", text: "第一位講者" }],
    startedAt
  );
  accumulator.applySnapshot(
    [{ sourceKey: "row-1", speaker: "Alice", text: "第二位講者" }],
    startedAt + 1_000
  );

  const segments = accumulator.getSegments();
  assert.equal(segments.length, 2);
  assert.equal(segments[0].status, "final");
  assert.equal(segments[1].speaker, "Alice");
});

test("a reloaded content script reconnects to the persisted draft", () => {
  const startedAt = Date.now();
  const first = new CaptionAccumulator();
  first.applySnapshot(
    [{ sourceKey: "old-row", speaker: "Howie", text: "重新整理前的字幕" }],
    startedAt
  );

  const restored = new CaptionAccumulator(first.getSegments());
  restored.applySnapshot(
    [{ sourceKey: "new-row", speaker: "Howie", text: "重新整理前的字幕仍在增加" }],
    startedAt + 1_000
  );

  const segments = restored.getSegments();
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, "重新整理前的字幕仍在增加");
});

test("exports readable Markdown and structured JSON", () => {
  const session = createSession({
    meetingCode: "abc-defg-hij",
    title: "產品例會",
    now: Date.parse("2026-08-28T02:58:49.000Z")
  });
  session.status = "stopped";
  session.stoppedAt = "2026-08-28T03:00:00.000Z";
  session.segments = [
    {
      id: "segment-1",
      sourceKey: "row-1",
      speaker: "Howie",
      text: "今天討論產品時程。",
      status: "final",
      startedAt: "2026-08-28T02:58:49.000Z",
      updatedAt: "2026-08-28T02:58:55.000Z",
      finalizedAt: "2026-08-28T02:58:55.000Z"
    }
  ];

  const markdown = formatMarkdown(session);
  assert.match(markdown, /# Google Meet 逐字稿/);
  assert.match(markdown, /Howie/);
  assert.match(markdown, /今天討論產品時程。/);

  const json = JSON.parse(formatJson(session, Date.parse("2026-08-28T03:01:00.000Z")));
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.session.segments[0].speaker, "Howie");
  assert.match(exportFilename(session, "md"), /^abc-defg-hij-.*\.md$/);
});
