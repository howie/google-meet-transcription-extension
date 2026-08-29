(function runPopup() {
  "use strict";

  const core = globalThis.MeetTranscriptCore;
  const elements = {
    statusDot: document.querySelector("#statusDot"),
    statusText: document.querySelector("#statusText"),
    statusHint: document.querySelector("#statusHint"),
    segmentCount: document.querySelector("#segmentCount"),
    startButton: document.querySelector("#startButton"),
    stopButton: document.querySelector("#stopButton"),
    actionMessage: document.querySelector("#actionMessage"),
    sessionSelect: document.querySelector("#sessionSelect"),
    markdownButton: document.querySelector("#markdownButton"),
    jsonButton: document.querySelector("#jsonButton")
  };

  let activeTab = null;
  let contentStatus = null;
  let sessions = [];

  function isMeetTab(tab) {
    try {
      return new URL(tab && tab.url).hostname === "meet.google.com";
    } catch (_error) {
      return false;
    }
  }

  function setMessage(text, isError = false) {
    elements.actionMessage.textContent = text || "";
    elements.actionMessage.classList.toggle("error", isError);
  }

  function selectedSession() {
    return sessions.find((item) => item.id === elements.sessionSelect.value) || null;
  }

  function renderStatus() {
    elements.statusDot.className = "status-dot";
    elements.startButton.disabled = true;
    elements.stopButton.disabled = true;

    if (!isMeetTab(activeTab)) {
      elements.statusText.textContent = "目前不是 Google Meet";
      elements.statusHint.textContent = "開啟 Meet 會議後即可開始擷取";
      elements.segmentCount.textContent = selectedSession()?.segments?.length || 0;
      return;
    }

    if (!contentStatus) {
      elements.statusDot.classList.add("error");
      elements.statusText.textContent = "尚未連上 Meet 分頁";
      elements.statusHint.textContent = "重新整理 Meet 分頁後再試一次";
      elements.segmentCount.textContent = selectedSession()?.segments?.length || 0;
      return;
    }

    elements.segmentCount.textContent = contentStatus.segmentCount || 0;
    if (contentStatus.capturing && contentStatus.captionDetected) {
      elements.statusDot.classList.add("capturing");
      elements.statusText.textContent = "正在擷取字幕";
      elements.statusHint.textContent = "可以關閉這個視窗，擷取仍會繼續";
      elements.stopButton.disabled = false;
    } else if (contentStatus.capturing) {
      elements.statusDot.classList.add("waiting");
      elements.statusText.textContent = "正在等待字幕";
      elements.statusHint.textContent = "請在 Meet 下方開啟「即時字幕」";
      elements.stopButton.disabled = false;
    } else {
      elements.statusText.textContent = "尚未開始";
      elements.statusHint.textContent = "先開啟 Meet 即時字幕，再按開始擷取";
      elements.startButton.disabled = false;
    }

    if (contentStatus.lastError) {
      elements.statusDot.className = "status-dot error";
      elements.statusText.textContent = "本機保存發生錯誤";
      elements.statusHint.textContent = contentStatus.lastError;
    }
  }

  function sessionLabel(session) {
    const date = new Date(session.startedAt);
    const dateText = Number.isNaN(date.getTime())
      ? "未知時間"
      : date.toLocaleString("zh-TW", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        });
    const count = Array.isArray(session.segments) ? session.segments.length : 0;
    return `${dateText} · ${session.meetingCode} · ${count} 段`;
  }

  function renderSessions(preferredSessionId) {
    const previousSelection = preferredSessionId || elements.sessionSelect.value;
    elements.sessionSelect.replaceChildren();

    if (sessions.length === 0) {
      const option = document.createElement("option");
      option.textContent = "尚無逐字稿";
      elements.sessionSelect.append(option);
      elements.sessionSelect.disabled = true;
      elements.markdownButton.disabled = true;
      elements.jsonButton.disabled = true;
      return;
    }

    for (const item of sessions) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = sessionLabel(item);
      elements.sessionSelect.append(option);
    }

    if (sessions.some((item) => item.id === previousSelection)) {
      elements.sessionSelect.value = previousSelection;
    }
    elements.sessionSelect.disabled = false;
    updateExportButtons();
  }

  function updateExportButtons() {
    const item = selectedSession();
    const hasSegments = Boolean(item && Array.isArray(item.segments) && item.segments.length);
    elements.markdownButton.disabled = !hasSegments;
    elements.jsonButton.disabled = !hasSegments;
    if (!contentStatus || !contentStatus.capturing) {
      elements.segmentCount.textContent = item?.segments?.length || 0;
    }
  }

  async function loadSessions() {
    const indexResult = await chrome.storage.local.get(core.STORAGE_KEYS.index);
    const index = Array.isArray(indexResult[core.STORAGE_KEYS.index])
      ? indexResult[core.STORAGE_KEYS.index]
      : [];
    if (index.length === 0) {
      sessions = [];
      return;
    }

    const keys = index.map(core.sessionStorageKey);
    const stored = await chrome.storage.local.get(keys);
    sessions = index
      .map((id) => stored[core.sessionStorageKey(id)])
      .filter(Boolean)
      .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
  }

  function sendToMeet(message) {
    return new Promise((resolve) => {
      if (!activeTab || !activeTab.id) {
        resolve(null);
        return;
      }

      chrome.tabs.sendMessage(activeTab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    });
  }

  async function refresh(preferredSessionId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0] || null;
    contentStatus = isMeetTab(activeTab)
      ? await sendToMeet({ type: "MEET_TRANSCRIPT_GET_STATUS" })
      : null;

    await loadSessions();
    renderSessions(preferredSessionId || contentStatus?.sessionId);
    renderStatus();
  }

  async function handleCaptureAction(type) {
    setMessage("");
    elements.startButton.disabled = true;
    elements.stopButton.disabled = true;

    const response = await sendToMeet({ type });
    if (!response || response.ok === false) {
      setMessage(response?.error || "無法連上 Meet；請重新整理該分頁。", true);
      await refresh();
      return;
    }

    contentStatus = response;
    await loadSessions();
    renderSessions(response.sessionId);
    renderStatus();
    setMessage(type === "MEET_TRANSCRIPT_START" ? "已開始保存字幕。" : "逐字稿已停止並保存。");
  }

  function downloadText(filename, mimeType, content) {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  async function exportSelected(format) {
    const chosen = selectedSession();
    if (!chosen) return;

    const key = core.sessionStorageKey(chosen.id);
    const result = await chrome.storage.local.get(key);
    const latest = result[key] || chosen;

    if (format === "md") {
      downloadText(core.exportFilename(latest, "md"), "text/markdown", core.formatMarkdown(latest));
      setMessage("Markdown 已下載。");
    } else {
      downloadText(core.exportFilename(latest, "json"), "application/json", core.formatJson(latest));
      setMessage("JSON 已下載。");
    }
  }

  elements.startButton.addEventListener("click", () => {
    void handleCaptureAction("MEET_TRANSCRIPT_START");
  });
  elements.stopButton.addEventListener("click", () => {
    void handleCaptureAction("MEET_TRANSCRIPT_STOP");
  });
  elements.sessionSelect.addEventListener("change", updateExportButtons);
  elements.markdownButton.addEventListener("click", () => void exportSelected("md"));
  elements.jsonButton.addEventListener("click", () => void exportSelected("json"));

  chrome.storage.onChanged.addListener((_changes, areaName) => {
    if (areaName === "local") void refresh(elements.sessionSelect.value);
  });

  void refresh().catch((error) => {
    setMessage(error instanceof Error ? error.message : String(error), true);
    renderStatus();
  });
})();
