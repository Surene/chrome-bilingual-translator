const translateButton = document.querySelector("#translate");
const restoreButton = document.querySelector("#restore");
const practiceButton = document.querySelector("#practice");
const status = document.querySelector("#status");
const progressPanel = document.querySelector("#progressPanel");
let pollTimer;

init();

async function init() {
  const { deepseekToken = "", deepseekModel = "deepseek-v4-flash" } = await chrome.storage.local.get(["deepseekToken", "deepseekModel"]);
  document.querySelector("#modelInfo").textContent = deepseekToken
    ? `当前模型：${deepseekModel}`
    : "尚未配置 Token，请先打开管理后台。";
  translateButton.addEventListener("click", translateCurrentPage);
  restoreButton.addEventListener("click", restoreCurrentPage);
  practiceButton.addEventListener("click", openPractice);
  document.querySelector("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  await refreshProgress();
}

async function translateCurrentPage() {
  try {
    const tab = await getCurrentTab();
    await ensureContentScript(tab.id);
    const running = chrome.tabs.sendMessage(tab.id, { type: "translatePage" });
    setBusy(true, "正在提取网页内容…");
    startPolling();
    const response = await running;
    if (!response?.ok) throw new Error(response?.error || "无法翻译此页面。");
    renderProgress(response);
    setStatus(response.cancelled ? "翻译已取消。" : `已添加 ${response.translated} 段译文${response.cached ? `（其中 ${response.cached} 段来自缓存）` : ""}${response.skipped ? `，跳过 ${response.skipped} 段` : ""}。`);
  } catch (error) {
    setStatus(normalizeTabError(error), true);
  } finally {
    stopPolling();
    setBusy(false);
  }
}

async function restoreCurrentPage() {
  setBusy(true, "正在隐藏本页译文…");
  try {
    await sendToCurrentTab({ type: "restore" }, true);
    progressPanel.hidden = true;
    setStatus("已隐藏本页译文；缓存会保留，再次翻译无需重新请求。");
  } catch (error) {
    setStatus(normalizeTabError(error), true);
  } finally {
    stopPolling();
    setBusy(false);
  }
}

async function openPractice() {
  setBusy(true, "正在读取选中的原文…");
  try {
    const response = await sendToCurrentTab({ type: "openPractice" }, true);
    if (!response?.ok) throw new Error(response?.error || "无法打开翻译练习。");
    window.close();
  } catch (error) {
    setStatus(normalizeTabError(error), true);
  } finally {
    setBusy(false);
  }
}

async function refreshProgress() {
  const pageState = await getPageState();
  if (!pageState) return;
  renderProgress(pageState);
  if (pageState.phase === "translating") {
    setBusy(true, "翻译正在后台继续…");
    startPolling();
  } else if (pageState.phase === "error") {
    stopPolling();
    setBusy(false);
    setStatus(pageState.error || "翻译失败。", true);
  }
}

function startPolling() {
  if (!pollTimer) pollTimer = setInterval(refreshProgress, 500);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

async function getPageState() {
  try {
    return await sendToCurrentTab({ type: "pageStatus" }, false);
  } catch {
    return null;
  }
}

function renderProgress(pageState) {
  if (!pageState || (!pageState.total && pageState.phase === "idle")) return;
  const total = pageState.total || 0;
  const completed = Math.min(pageState.completed || 0, total);
  const percent = total ? Math.round((completed / total) * 100) : 0;
  progressPanel.hidden = false;
  document.querySelector("#progressBar").style.width = `${percent}%`;
  document.querySelector("#progressPercent").textContent = `${percent}%`;
  document.querySelector("#progressLabel").textContent = pageState.phase === "completed" ? "翻译完成" : `翻译进度 ${completed}/${total} 段`;
  const detail = document.querySelector("#progressDetail");
  if (pageState.phase === "error") detail.textContent = pageState.error || "翻译失败。";
  else if (pageState.phase === "completed") detail.textContent = `共处理 ${total} 段，已插入 ${pageState.translated || 0} 段译文${pageState.cached ? `（${pageState.cached} 段来自缓存）` : ""}。`;
  else if (completed > 0 && pageState.startedAt) {
    const elapsed = (Date.now() - pageState.startedAt) / 1000;
    const remaining = Math.max(1, Math.round((elapsed / completed) * (total - completed)));
    detail.textContent = `第 ${pageState.batch}/${pageState.batches} 批，预计还需约 ${formatSeconds(remaining)}。`;
  } else detail.textContent = `第 ${pageState.batch || 1}/${pageState.batches || 1} 批，正在估算剩余时间…`;
}

function formatSeconds(seconds) {
  return seconds >= 60 ? `${Math.ceil(seconds / 60)} 分钟` : `${seconds} 秒`;
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("未找到当前标签页。");
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "pageStatus" });
    return;
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }
}

async function sendToCurrentTab(message, ensure = false) {
  const tab = await getCurrentTab();
  if (ensure) await ensureContentScript(tab.id);
  return chrome.tabs.sendMessage(tab.id, message);
}

function setBusy(busy, message = "") {
  translateButton.disabled = busy;
  restoreButton.disabled = busy;
  practiceButton.disabled = busy;
  if (message) setStatus(message);
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function normalizeTabError(error) {
  const message = error?.message || String(error);
  if (message.includes("Cannot access") || message.includes("chrome://") || message.includes("Receiving end does not exist")) {
    return "此页面暂不支持翻译（Chrome 内置页面和 Chrome 商店无法翻译）。";
  }
  return message;
}
