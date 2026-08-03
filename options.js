const token = document.querySelector("#token");
const model = document.querySelector("#model");
const speechProvider = document.querySelector("#speechProvider");
const edgeTtsEndpoint = document.querySelector("#edgeTtsEndpoint");
const edgeTtsVoice = document.querySelector("#edgeTtsVoice");
const edgeTtsStatus = document.querySelector("#edgeTtsStatus");
const doubaoApiKey = document.querySelector("#doubaoApiKey");
const doubaoChineseVoice = document.querySelector("#doubaoChineseVoice");
const doubaoEnglishVoice = document.querySelector("#doubaoEnglishVoice");
const status = document.querySelector("#status");
const VOCABULARY_STORAGE_KEY = "translationVocabularyV1";
let vocabulary = {};
let activeReviewKey = null;
let speechAudioContext = null;
let activeSpeechSource = null;

init();

async function init() {
  const settings = await chrome.storage.local.get([
    "deepseekToken", "deepseekModel",
    "speechProvider", "edgeTtsEndpoint", "edgeTtsVoice", "doubaoApiKey", "doubaoChineseVoice", "doubaoEnglishVoice"
  ]);
  token.value = settings.deepseekToken || "";
  model.value = ["deepseek-v4-flash", "deepseek-v4-pro"].includes(settings.deepseekModel)
    ? settings.deepseekModel
    : "deepseek-v4-flash";
  document.querySelector("#toggleToken").addEventListener("click", toggleToken);
  document.querySelector("#save").addEventListener("click", save);
  document.querySelector("#clear").addEventListener("click", clearToken);
  document.querySelector("#clearCache").addEventListener("click", clearCache);
  speechProvider.addEventListener("change", async () => {
    updateSpeechProviderVisibility();
    if (speechProvider.value === "edgeTts") await ensureEdgeTtsAvailable(true);
  });
  document.querySelector("#testDoubaoVoice").addEventListener("click", testDoubaoVoice);
  document.querySelector("#vocabularySearch").addEventListener("input", renderVocabulary);
  document.querySelector("#vocabularyFilter").addEventListener("change", renderVocabulary);
  document.querySelector("#startReview").addEventListener("click", startReview);
  document.querySelector("#vocabularyList").addEventListener("click", handleVocabularyAction);
  speechProvider.value = ["edgeTts", "doubaoTts"].includes(settings.speechProvider) ? settings.speechProvider : "browser";
  edgeTtsEndpoint.value = settings.edgeTtsEndpoint || "http://127.0.0.1:8765";
  edgeTtsVoice.value = settings.edgeTtsVoice || "en-US-AriaNeural";
  doubaoApiKey.value = settings.doubaoApiKey || "";
  doubaoChineseVoice.value = settings.doubaoChineseVoice || "zh_female_lingling_uranus_bigtts";
  doubaoEnglishVoice.value = settings.doubaoEnglishVoice || "en_female_pleasant-female_uranus_bigtts";
  updateSpeechProviderVisibility();
  if (speechProvider.value === "edgeTts") await ensureEdgeTtsAvailable(true);
  await loadVocabulary();
}

function toggleToken() {
  const isHidden = token.type === "password";
  token.type = isHidden ? "text" : "password";
  document.querySelector("#toggleToken").textContent = isHidden ? "隐藏" : "显示";
}

function updateSpeechProviderVisibility() {
  document.querySelector("#edgeTtsSettings").hidden = speechProvider.value !== "edgeTts";
  document.querySelector("#doubaoTtsSettings").hidden = speechProvider.value !== "doubaoTts";
}

async function save() {
  const value = token.value.trim();
  if (!value) return setStatus("请填写 DeepSeek API Token，或使用“清除 Token”。", true);
  if (speechProvider.value === "edgeTts") await ensureEdgeTtsAvailable(true);
  await chrome.storage.local.set({
    deepseekToken: value,
    deepseekModel: model.value,
    speechProvider: speechProvider.value,
    edgeTtsEndpoint: edgeTtsEndpoint.value.trim().replace(/\/$/, "") || "http://127.0.0.1:8765",
    edgeTtsVoice: edgeTtsVoice.value.trim() || "en-US-AriaNeural",
    doubaoApiKey: doubaoApiKey.value.trim(),
    doubaoChineseVoice: doubaoChineseVoice.value.trim() || "zh_female_lingling_uranus_bigtts",
    doubaoEnglishVoice: doubaoEnglishVoice.value.trim() || "en_female_pleasant-female_uranus_bigtts"
  });
  setStatus(`已保存，当前模型：${model.value}`);
}

function edgeTtsServiceUrl() {
  return String(edgeTtsEndpoint.value || "http://127.0.0.1:8765").replace(/\/$/, "");
}

async function checkEdgeTtsHealth() {
  const endpoint = edgeTtsServiceUrl();
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(endpoint)) {
    return { ok: false, error: "本地服务地址无效" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1600);
  try {
    const response = await fetch(`${endpoint}/health`, { cache: "no-store", signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true || payload?.service !== "edge-tts") {
      return { ok: false, error: "健康检查未通过" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "未检测到本地服务" };
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureEdgeTtsAvailable(announce = false) {
  const result = await checkEdgeTtsHealth();
  edgeTtsStatus.textContent = result.ok
    ? "本地 Edge TTS 服务已连接，可用于英文朗读。"
    : "未检测到本地 Edge TTS 服务，将使用 Chrome 本机朗读。";
  edgeTtsStatus.classList.toggle("error", !result.ok);
  if (result.ok) return true;
  if (speechProvider.value === "edgeTts") {
    speechProvider.value = "browser";
    updateSpeechProviderVisibility();
    await chrome.storage.local.set({ speechProvider: "browser" });
  }
  if (announce) setStatus("未检测到 Edge TTS 本地服务，已自动切换为 Chrome 本机朗读。", true);
  return false;
}

async function testDoubaoVoice() {
  const apiKey = doubaoApiKey.value.trim();
  if (!apiKey) return setStatus("请先填写豆包语音 API Key。", true);
  const button = document.querySelector("#testDoubaoVoice");
  button.disabled = true;
  setStatus("正在生成豆包英文试听音频…");
  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: "synthesizeDoubao",
        text: "Hello! This is a short test of your selected Doubao voice.",
        config: { apiKey, chineseVoice: doubaoChineseVoice.value.trim(), englishVoice: doubaoEnglishVoice.value.trim() }
      }, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });
    if (!response?.ok) throw new Error(response?.error || "豆包音色测试失败。");
    const audio = new Audio(`data:audio/mpeg;base64,${response.audioBase64}`);
    await audio.play();
    setStatus("豆包英文音色测试成功，已开始播放。");
  } catch (error) {
    setStatus(error.message || "豆包音色测试失败。", true);
  } finally {
    button.disabled = false;
  }
}

async function clearToken() {
  token.value = "";
  await chrome.storage.local.remove("deepseekToken");
  setStatus("已清除本机保存的 Token。");
}

async function clearCache() {
  await chrome.storage.local.remove("deepseekTranslationCacheV1");
  setStatus("已清除本机翻译缓存。");
}

async function loadVocabulary() {
  const data = await chrome.storage.local.get(VOCABULARY_STORAGE_KEY);
  vocabulary = normalizeVocabulary(data[VOCABULARY_STORAGE_KEY] || {});
  await chrome.storage.local.set({ [VOCABULARY_STORAGE_KEY]: vocabulary });
  renderVocabulary();
}

async function persistVocabulary() {
  await chrome.storage.local.set({ [VOCABULARY_STORAGE_KEY]: vocabulary });
  renderVocabulary();
}

function renderVocabulary() {
  const entries = Object.entries(vocabulary).sort(([, a], [, b]) => (b.updatedAt || b.addedAt || 0) - (a.updatedAt || a.addedAt || 0));
  const query = document.querySelector("#vocabularySearch").value.trim().toLowerCase();
  const filter = document.querySelector("#vocabularyFilter").value;
  const visible = entries.filter(([, item]) => {
    const text = `${item.term} ${item.translation} ${item.sentence} ${item.sourceSentence} ${item.note} ${item.referent}`.toLowerCase();
    return (!query || text.includes(query)) && (filter === "all" || item.status === filter);
  });
  document.querySelector("#vocabularyCount").textContent = `${entries.length} 词`;
  const list = document.querySelector("#vocabularyList");
  if (!visible.length) {
    list.innerHTML = `<p class="vocabulary-empty">${entries.length ? "没有符合筛选条件的生词。" : "还没有生词。请在网页译文卡片中选中词语并加入生词本。"}</p>`;
    return;
  }
  list.innerHTML = visible.map(([key, item]) => `
    <article class="vocabulary-item" data-key="${key}">
      <div><div class="vocabulary-term-row"><h3 class="vocabulary-term">${escapeHtml(item.term)}</h3><button class="vocabulary-speak" data-action="speak-term" type="button" aria-label="朗读单词" title="朗读单词">🔊</button></div><p class="vocabulary-meaning">${escapeHtml(item.translation)}</p>${renderExamples(item)}${item.note ? `<p class="vocabulary-note">${escapeHtml(item.note)}</p>` : ""}${item.referent ? `<p class="vocabulary-referent">指代：${escapeHtml(item.referent)}</p>` : ""}</div>
      <div class="vocabulary-actions"><button class="${item.status === "mastered" ? "mastered" : ""}" data-action="toggle">${item.status === "mastered" ? "已掌握" : "学习中"}</button><button class="remove" data-action="remove">删除</button></div>
    </article>`).join("");
}

async function handleVocabularyAction(event) {
  const action = event.target.dataset.action;
  const key = event.target.closest("[data-key]")?.dataset.key;
  if (!action || !key || !vocabulary[key]) return;
  if (action === "speak-term" || action === "speak-example") {
    const item = vocabulary[key];
    const exampleIndex = Number(event.target.dataset.exampleIndex);
    const text = action === "speak-term" ? item.term : vocabularyExamples(item)[exampleIndex]?.sentence;
    if (!text) return;
    event.target.disabled = true;
    try {
      setStatus(await speakVocabularyText(text));
    } catch (error) {
      setStatus(error.message || "朗读启动失败，请重试。", true);
    } finally {
      event.target.disabled = false;
    }
    return;
  }
  if (action === "remove") delete vocabulary[key];
  if (action === "toggle") vocabulary[key].status = vocabulary[key].status === "mastered" ? "learning" : "mastered";
  vocabulary[key] && (vocabulary[key].updatedAt = Date.now());
  await persistVocabulary();
}

function startReview() {
  const candidates = Object.entries(vocabulary).filter(([, item]) => item.status !== "mastered");
  if (!candidates.length) {
    document.querySelector("#reviewPanel").hidden = false;
    document.querySelector("#reviewPanel").innerHTML = "<p class=\"vocabulary-empty\">没有待复习的生词。先加入一些词，或将“已掌握”改回“学习中”。</p>";
    return;
  }
  const [key, item] = candidates[Math.floor(Math.random() * candidates.length)];
  const examples = vocabularyExamples(item);
  const example = examples[Math.floor(Math.random() * examples.length)] || {};
  activeReviewKey = key;
  const panel = document.querySelector("#reviewPanel");
  panel.hidden = false;
  panel.innerHTML = `<p class="review-kicker">快速复习 · ${escapeHtml(item.term)}</p><h3 class="review-term">${escapeHtml(example.sentence || item.term)}</h3>${example.sourceSentence ? `<p class="review-context">原文：${escapeHtml(example.sourceSentence)}</p>` : ""}<div class="review-answer" hidden><strong>${escapeHtml(item.translation)}</strong>${item.note ? `<p class="vocabulary-note">${escapeHtml(item.note)}</p>` : ""}${item.referent ? `<p class="vocabulary-referent">指代：${escapeHtml(item.referent)}</p>` : ""}</div><div class="review-actions"><button class="secondary" data-review="reveal">显示答案</button><button class="primary" data-review="mastered" hidden>我已掌握</button><button class="secondary" data-review="again" hidden>还不熟悉，换一个</button></div>`;
  panel.onclick = handleReviewAction;
}

async function handleReviewAction(event) {
  const action = event.target.dataset.review;
  if (!action || !activeReviewKey) return;
  const panel = document.querySelector("#reviewPanel");
  if (action === "reveal") {
    panel.querySelector(".review-answer").hidden = false;
    panel.querySelectorAll("[data-review='mastered'], [data-review='again']").forEach((button) => { button.hidden = false; });
    event.target.hidden = true;
    return;
  }
  const item = vocabulary[activeReviewKey];
  if (item) {
    item.reviewCount = (item.reviewCount || 0) + 1;
    item.updatedAt = Date.now();
    if (action === "mastered") item.status = "mastered";
    await persistVocabulary();
  }
  startReview();
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function renderExamples(item) {
  const examples = vocabularyExamples(item);
  if (!examples.length) return "";
  const content = examples.map((example, index) => `<div class="vocabulary-example"><div class="vocabulary-sentence-row"><p class="vocabulary-sentence">${escapeHtml(example.sentence)}</p><button class="vocabulary-speak sentence" data-action="speak-example" data-example-index="${index}" type="button" aria-label="朗读例句" title="朗读例句">🔊</button></div>${example.sourceSentence ? `<p class="vocabulary-source">${escapeHtml(example.sourceSentence)}</p>` : ""}</div>`).join("");
  return `<details class="vocabulary-examples" ${examples.length === 1 ? "open" : ""}><summary>例句 ${examples.length} 条</summary>${content}</details>`;
}

async function speakVocabularyText(value) {
  const text = String(value || "").replace(/\s+/g, " ").replace(/[—–]/g, ", ").trim();
  if (!text) throw new Error("没有可朗读的内容。");
  const isChinese = /[\u4e00-\u9fff]/.test(text);
  unlockSpeechAudio();
  if (speechProvider.value === "doubaoTts") {
    await speakWithDoubao(text, isChinese);
    return "正在使用豆包语音朗读。";
  }
  if (speechProvider.value === "edgeTts" && !isChinese) {
    try {
      await speakWithEdgeTts(text);
      return "正在使用 Edge TTS 朗读。";
    } catch (error) {
      speakWithBrowser(text, isChinese);
      return `Edge TTS 未生效，已改用 Chrome：${error.message || "无法连接服务"}`;
    }
  }
  speakWithBrowser(text, isChinese);
  return "正在使用 Chrome 朗读。";
}

function speakWithBrowser(text, isChinese) {
  activeSpeechSource?.stop();
  activeSpeechSource = null;
  window.speechSynthesis?.cancel();
  if (!("speechSynthesis" in window)) throw new Error("浏览器不支持本机朗读。");
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = isChinese ? "zh-CN" : "en-US";
  utterance.rate = text.length > 42 || /[.!?。！？]/.test(text) ? 0.98 : 0.86;
  window.speechSynthesis.speak(utterance);
}

async function speakWithEdgeTts(text) {
  if (!await ensureEdgeTtsAvailable(false)) throw new Error("本地 Edge TTS 服务未启动");
  const endpoint = edgeTtsServiceUrl();
  window.speechSynthesis?.cancel();
  const response = await fetch(`${endpoint}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice: edgeTtsVoice.value.trim() || "en-US-AriaNeural" })
  });
  if (!response.ok) throw new Error(`Edge TTS 服务返回 ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error("Edge TTS 未返回音频");
  await playDecodedAudio(bytes);
}

async function speakWithDoubao(text, isChinese) {
  window.speechSynthesis?.cancel();
  const response = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: "synthesizeDoubao",
      text,
      isChinese,
      config: {
        apiKey: doubaoApiKey.value.trim(),
        chineseVoice: doubaoChineseVoice.value.trim(),
        englishVoice: doubaoEnglishVoice.value.trim()
      }
    }, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
  if (!response?.ok || !response.audioBase64) throw new Error(response?.error || "豆包未返回音频");
  await playDecodedAudio(Uint8Array.from(atob(response.audioBase64), (character) => character.charCodeAt(0)));
}

function unlockSpeechAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  speechAudioContext ||= new AudioContext();
  if (speechAudioContext.state === "suspended") speechAudioContext.resume().catch(() => {});
}

async function playDecodedAudio(bytes) {
  unlockSpeechAudio();
  if (!speechAudioContext) throw new Error("浏览器不支持音频播放。");
  if (speechAudioContext.state === "suspended") await speechAudioContext.resume();
  activeSpeechSource?.stop();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const audioBuffer = await speechAudioContext.decodeAudioData(buffer);
  const source = speechAudioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(speechAudioContext.destination);
  source.addEventListener("ended", () => { if (activeSpeechSource === source) activeSpeechSource = null; }, { once: true });
  activeSpeechSource = source;
  source.start();
}

function normalizeVocabulary(records) {
  const normalized = {};
  Object.values(records).forEach((item) => {
    if (!item?.term) return;
    const term = normalizeVocabularyTerm(item.term);
    const key = vocabularyKey(term);
    const existing = normalized[key] || { ...item, term, examples: vocabularyExamples(item) };
    const examples = uniqueExamples([...vocabularyExamples(existing), ...vocabularyExamples(item)]);
    normalized[key] = {
      ...existing,
      ...item,
      term,
      examples,
      status: existing.status === "learning" || item.status === "learning" ? "learning" : "mastered",
      reviewCount: Math.max(existing.reviewCount || 0, item.reviewCount || 0),
      addedAt: Math.min(existing.addedAt || Date.now(), item.addedAt || Date.now()),
      updatedAt: Math.max(existing.updatedAt || 0, item.updatedAt || 0)
    };
  });
  return normalized;
}

function vocabularyExamples(item) {
  if (Array.isArray(item.examples)) return item.examples.filter((example) => example?.sentence);
  return item.sentence ? [{ sentence: item.sentence, sourceSentence: item.sourceSentence || "", addedAt: item.addedAt || 0 }] : [];
}

function uniqueExamples(examples) {
  const seen = new Set();
  return examples.filter((example) => {
    const key = String(example.sentence || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(-20);
}

function normalizeVocabularyTerm(term) {
  const value = String(term || "").trim().toLowerCase();
  if (!/^[a-z][a-z'-]+$/i.test(value) || value.length <= 3 || /(?:ss|is|was|has)$/.test(value)) return value;
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function vocabularyKey(term) {
  let hash = 2166136261;
  for (const character of term) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}
