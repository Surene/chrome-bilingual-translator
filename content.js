(() => {
  if (globalThis.__deepseekBilingualTranslatorLoaded) return;
  globalThis.__deepseekBilingualTranslatorLoaded = true;

  const MARKER = "data-ds-bilingual-source";
  const MAX_BATCH_ITEMS = 8;
  const MAX_BATCH_CHARS = 4000;
  const DRAFT_STORAGE_KEY = "translationPracticeDraftsV1";
  const VOCABULARY_STORAGE_KEY = "translationVocabularyV1";
  const MAX_VOCABULARY_ENTRIES = 1000;
  const MAX_PRACTICE_DRAFTS = 100;
  let runId = 0;
  let state = emptyState();
  let lastSelectedText = "";
  let lookupRequestId = 0;
  let activeSpeechAudio = null;
  let speechAudioContext = null;
  let activeSpeechSource = null;

  document.addEventListener("selectionchange", () => {
    const selected = window.getSelection()?.toString().trim();
    if (selected) lastSelectedText = selected;
  });
  document.addEventListener("mouseup", showWordLookup);
  document.addEventListener("mousedown", (event) => {
    if (!event.target.closest(".ds-word-lookup")) document.querySelector(".ds-word-lookup")?.remove();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") document.querySelector(".ds-word-lookup")?.remove();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "pageStatus") {
      sendResponse({ ok: true, translated: Boolean(document.querySelector(".ds-bilingual-translation")), ...state });
      return;
    }
    if (message.type === "restore") {
      runId += 1;
      restore();
      state = emptyState();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "openPractice") {
      const source = String(message.source || "").trim() || window.getSelection()?.toString().trim() || lastSelectedText;
      if (!source) {
        sendResponse({ ok: false, error: "请先在网页中选中一段需要练习翻译的原文。" });
        return;
      }
      if (source.length > 6000) {
        sendResponse({ ok: false, error: "选中的文本过长，请选择不超过 6000 个字符的内容。" });
        return;
      }
      openPracticePanel(source);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "translatePage") {
      if (state.phase === "translating") {
        sendResponse({ ok: true, alreadyRunning: true, ...state });
        return;
      }
      const currentRun = ++runId;
      translatePage(currentRun)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }))
        .finally(() => {
          if (currentRun === runId && state.phase === "translating") state.phase = "completed";
        });
      return true;
    }
  });

  function emptyState() {
    return { phase: "idle", total: 0, completed: 0, translated: 0, skipped: 0, cached: 0, batch: 0, batches: 0, startedAt: 0, error: "" };
  }

  function restore() {
    document.querySelectorAll(".ds-bilingual-translation").forEach((node) => node.remove());
    document.querySelectorAll(`[${MARKER}]`).forEach((node) => node.removeAttribute(MARKER));
  }

  async function translatePage(currentRun) {
    const candidates = collectTextNodes();
    const batches = makeBatches(candidates);
    state = { phase: "translating", total: candidates.length, completed: 0, translated: 0, skipped: 0, cached: 0, batch: 0, batches: batches.length, startedAt: Date.now(), error: "" };
    if (candidates.length === 0) {
      state.phase = "completed";
      return state;
    }

    try {
      for (let index = 0; index < batches.length; index += 1) {
        if (currentRun !== runId) return { cancelled: true };
        const batch = batches[index];
        state.batch = index + 1;
        const result = await requestTranslation(batch.map((item) => item.text));
        const translations = result.translations;
        state.cached += result.cached || 0;
        if (currentRun !== runId) return { cancelled: true };
        translations.forEach((rawTranslation, translationIndex) => {
          const item = batch[translationIndex];
          const translation = typeof rawTranslation === "string" ? rawTranslation : "";
          if (!translation.trim() || translation.trim() === item.text.trim()) {
            state.skipped += 1;
            return;
          }
          insertTranslation(item.node, translation);
          state.translated += 1;
        });
        state.completed += batch.length;
      }
      state.phase = "completed";
      return state;
    } catch (error) {
      state.phase = "error";
      state.error = error.message || "翻译请求失败。";
      throw error;
    }
  }

  function collectTextNodes() {
    const root = findArticleRoot();
    const title = document.querySelector("h1");
    const blocks = [...root.querySelectorAll("h1, h2, h3, h4, p, li, blockquote, figcaption")];
    if (title && !blocks.includes(title)) blocks.unshift(title);
    return blocks
      .filter((element) => isTranslatableBlock(element))
      .map((element) => ({ node: element, text: element.innerText.replace(/\s+/g, " ").trim() }));
  }

  function findArticleRoot() {
    const candidates = [...document.querySelectorAll("article, [itemprop='articleBody'], main, [role='main']")];
    if (candidates.length === 0) return document.body;
    return candidates.reduce((best, candidate) => articleScore(candidate) > articleScore(best) ? candidate : best);
  }

  function articleScore(element) {
    const paragraphLength = [...element.querySelectorAll("p")].reduce((total, paragraph) => total + paragraph.innerText.length, 0);
    return paragraphLength * 10 + Math.min(element.innerText.length, 10000);
  }

  function isTranslatableBlock(element) {
    const text = element.innerText.replace(/\s+/g, " ").trim();
    if (!text || text.length < 2 || text.length > 1800) return false;
    if (element.closest("script, style, noscript, textarea, input, select, option, button, a, code, pre, svg, [contenteditable='true'], .ds-bilingual-translation")) return false;
    if (element.hasAttribute(MARKER) || element.closest(`[${MARKER}]`)) return false;
    if (element.matches("li") && element.querySelector("p, li")) return false;
    return containsTranslatableCharacters(text);
  }

  function containsTranslatableCharacters(text) {
    return /[\u4e00-\u9fff]|[A-Za-z]{3,}/.test(text);
  }

  function makeBatches(items) {
    const batches = [];
    let batch = [];
    let chars = 0;
    for (const item of items) {
      if (batch.length && (batch.length >= MAX_BATCH_ITEMS || chars + item.text.length > MAX_BATCH_CHARS)) {
        batches.push(batch);
        batch = [];
        chars = 0;
      }
      batch.push(item);
      chars += item.text.length;
    }
    if (batch.length) batches.push(batch);
    return batches;
  }

  function requestTranslation(texts) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "translate", texts }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response?.ok) return reject(new Error(response?.error || "翻译请求失败。"));
        resolve({ translations: response.translations, cached: response.cached || 0 });
      });
    });
  }

  function insertTranslation(source, translation) {
    if (!source?.parentNode) return;
    source.setAttribute(MARKER, "true");
    const translated = document.createElement("span");
    translated.className = "ds-bilingual-translation";
    translated.lang = /[\u4e00-\u9fff]/.test(translation) ? "zh-CN" : "en";
    translated.textContent = translation;
    source.after(translated);
  }

  async function showWordLookup(event) {
    if (event.target.closest(".ds-word-lookup")) return;
    const selection = window.getSelection();
    const term = selection?.toString().trim() || "";
    const card = selection?.anchorNode?.parentElement?.closest(".ds-bilingual-translation");
    if (!term || term.length > 100 || !card || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const requestId = ++lookupRequestId;
    const tooltip = renderWordTooltip(rect, term, "正在查询词义…");
    try {
      const lookupContext = getLookupContext(card, term);
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "lookupWord", term, context: lookupContext }, (result) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(result);
        });
      });
      if (requestId !== lookupRequestId) return;
      if (!response?.ok) throw new Error(response?.error || "词义查询失败。");
      tooltip.querySelector(".ds-word-lookup-term").textContent = response.lookup.term;
      tooltip.querySelector(".ds-word-lookup-meaning").textContent = response.lookup.translation;
      tooltip.querySelector(".ds-word-lookup-note").textContent = response.lookup.note;
      const referent = tooltip.querySelector(".ds-word-lookup-referent");
      referent.textContent = response.lookup.referent ? `上下文指代：${response.lookup.referent}` : "";
      referent.hidden = !response.lookup.referent;
      const saveButton = tooltip.querySelector(".ds-word-lookup-save");
      saveButton.hidden = false;
      saveButton.addEventListener("click", async () => {
        saveButton.disabled = true;
        try {
          await saveVocabulary(term, response.lookup, lookupContext);
          saveButton.textContent = "已加入生词本";
        } catch {
          saveButton.textContent = "保存失败，请重试";
          saveButton.disabled = false;
        }
      });
      tooltip.classList.remove("is-loading");
    } catch (error) {
      if (requestId !== lookupRequestId) return;
      tooltip.querySelector(".ds-word-lookup-meaning").textContent = error.message || "词义查询失败。";
      tooltip.classList.remove("is-loading");
    }
  }

  function renderWordTooltip(rect, term, status) {
    document.querySelector(".ds-word-lookup")?.remove();
    const tooltip = document.createElement("aside");
    tooltip.className = "ds-word-lookup is-loading";
    tooltip.innerHTML = '<div class="ds-word-lookup-heading"><span class="ds-word-lookup-term"></span><button class="ds-word-lookup-speak" type="button" aria-label="朗读单词" title="朗读单词">🔊</button></div><small class="ds-word-lookup-speech-status" aria-live="polite"></small><strong class="ds-word-lookup-meaning"></strong><small class="ds-word-lookup-note"></small><small class="ds-word-lookup-referent" hidden></small><button class="ds-word-lookup-save" type="button" hidden>加入生词本</button>';
    tooltip.querySelector(".ds-word-lookup-term").textContent = term;
    tooltip.querySelector(".ds-word-lookup-meaning").textContent = status;
    const speakButton = tooltip.querySelector(".ds-word-lookup-speak");
    const speechStatus = tooltip.querySelector(".ds-word-lookup-speech-status");
    speakButton.addEventListener("click", async () => {
      speakButton.disabled = true;
      speechStatus.textContent = "正在准备朗读…";
      try {
        const result = await speakTerm(term);
        speechStatus.textContent = result.provider === "doubao"
          ? "正在使用豆包语音朗读"
          : result.provider === "edge"
            ? "正在使用 Edge TTS 朗读"
          : result.fallbackError
            ? `${result.fallbackProvider === "edge" ? "Edge TTS" : "豆包语音"}未生效，已改用 Chrome：${result.fallbackError}`
            : "正在使用 Chrome 朗读";
      } catch (error) {
        speechStatus.textContent = isExtensionContextInvalidated(error)
          ? "扩展刚刚更新，请刷新当前网页后再试。"
          : error.message || "朗读启动失败，请重试。";
      } finally {
        speakButton.disabled = false;
      }
    });
    document.body.append(tooltip);
    const width = tooltip.getBoundingClientRect().width;
    tooltip.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    tooltip.style.top = `${Math.min(rect.bottom + 10, window.innerHeight - tooltip.getBoundingClientRect().height - 12)}px`;
    return tooltip;
  }

  async function speakTerm(term) {
    unlockSpeechAudio();
    const text = term.replace(/\s+/g, " ").replace(/[—–]/g, ", ").trim();
    const isChinese = /[\u4e00-\u9fff]/.test(text);
    const settings = await chrome.storage.local.get([
      "speechProvider", "edgeTtsEndpoint", "edgeTtsVoice",
      "doubaoApiKey", "doubaoChineseVoice", "doubaoEnglishVoice"
    ]);
    if (settings.speechProvider === "doubaoTts") {
      const doubaoResult = await speakWithDoubao(text, isChinese, settings);
      if (doubaoResult.ok) return { provider: "doubao" };
      const fallbackResult = await speakWithBrowser(text, isChinese, settings);
      return { provider: "browser", fallbackError: doubaoResult.error, ...fallbackResult };
    }
    if (!isChinese && settings.speechProvider === "edgeTts") {
      const edgeResult = await speakWithEdgeTts(text, settings);
      if (edgeResult.ok) return { provider: "edge" };
      const fallbackResult = await speakWithBrowser(text, isChinese, settings);
      return { provider: "browser", fallbackProvider: "edge", fallbackError: edgeResult.error, ...fallbackResult };
    }
    return speakWithBrowser(text, isChinese, settings);
  }

  function isExtensionContextInvalidated(error) {
    return /extension context invalidated/i.test(String(error?.message || error || ""));
  }

  async function speakWithBrowser(text, isChinese, settings) {
    if (!("speechSynthesis" in window)) return { provider: "none", fallbackError: "浏览器不支持本机朗读" };
    activeSpeechSource?.stop();
    activeSpeechSource = null;
    activeSpeechAudio?.pause();
    activeSpeechAudio = null;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = isChinese ? "zh-CN" : "en-US";
    const isSentence = text.length > 42 || /[.!?。！？]/.test(text);
    utterance.rate = isSentence ? 0.98 : 0.86;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
    return { provider: "browser" };
  }

  async function speakWithEdgeTts(text, settings) {
    const endpoint = String(settings.edgeTtsEndpoint || "http://127.0.0.1:8765").replace(/\/$/, "");
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(endpoint)) {
      return { ok: false, error: "本地服务地址无效" };
    }
    try {
      if (!await isEdgeTtsAvailable(endpoint)) {
        return { ok: false, error: "本地 Edge TTS 服务未启动" };
      }
      window.speechSynthesis?.cancel();
      activeSpeechAudio?.pause();
      const response = await fetch(`${endpoint}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: settings.edgeTtsVoice || "en-US-AriaNeural" })
      });
      if (!response.ok) throw new Error(`Edge TTS 服务返回 ${response.status}`);
      const blob = await response.blob();
      if (!blob.size) throw new Error("Edge TTS 未返回音频");
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      activeSpeechAudio = audio;
      audio.addEventListener("ended", () => {
        URL.revokeObjectURL(audioUrl);
        if (activeSpeechAudio === audio) activeSpeechAudio = null;
      }, { once: true });
      audio.addEventListener("error", () => URL.revokeObjectURL(audioUrl), { once: true });
      await audio.play();
      return { ok: true };
    } catch (error) {
      console.info("Edge TTS 不可用，已回退至浏览器朗读。", error);
      return { ok: false, error: error.message || "无法连接本地 Edge TTS 服务" };
    }
  }

  async function isEdgeTtsAvailable(endpoint) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1600);
    try {
      const response = await fetch(`${endpoint}/health`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json().catch(() => null);
      return response.ok && payload?.ok === true && payload?.service === "edge-tts";
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function speakWithDoubao(text, isChinese, settings) {
    if (!settings.doubaoApiKey?.trim()) return { ok: false, error: "未填写豆包语音 API Key" };
    try {
      window.speechSynthesis?.cancel();
      activeSpeechAudio?.pause();
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "synthesizeDoubao", text, isChinese }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      });
      if (!result?.ok || !result.audioBase64) throw new Error(result?.error || "豆包未返回音频");
      const bytes = Uint8Array.from(atob(result.audioBase64), (character) => character.charCodeAt(0));
      await playDecodedAudio(bytes);
      return { ok: true };
    } catch (error) {
      console.info("豆包语音不可用，已回退至浏览器朗读。", error);
      return { ok: false, error: error.message || "无法连接豆包语音服务" };
    }
  }

  function unlockSpeechAudio() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    speechAudioContext ||= new AudioContext();
    if (speechAudioContext.state === "suspended") speechAudioContext.resume().catch(() => {});
  }

  async function playDecodedAudio(bytes) {
    unlockSpeechAudio();
    if (!speechAudioContext) throw new Error("浏览器不支持音频播放上下文");
    if (speechAudioContext.state === "suspended") await speechAudioContext.resume();
    activeSpeechSource?.stop();
    const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const audioBuffer = await speechAudioContext.decodeAudioData(input);
    const source = speechAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(speechAudioContext.destination);
    source.addEventListener("ended", () => { if (activeSpeechSource === source) activeSpeechSource = null; }, { once: true });
    activeSpeechSource = source;
    source.start();
  }

  function getLookupContext(card, term) {
    const source = card.previousElementSibling?.hasAttribute(MARKER) ? card.previousElementSibling : null;
    const root = card.closest("article, [itemprop='articleBody'], main, [role='main']") || document.body;
    const sourceBlocks = [...root.querySelectorAll(`[${MARKER}]`)];
    const currentIndex = source ? sourceBlocks.indexOf(source) : -1;
    const priorSource = currentIndex > 0
      ? sourceBlocks.slice(Math.max(0, currentIndex - 2), currentIndex).map((block) => block.innerText.trim()).join("\n\n")
      : "";
    return {
      translatedText: card.textContent.trim(),
      selectedSentence: findSentence(card.textContent, term),
      sourceParagraph: source?.innerText.trim() || "",
      priorSource
    };
  }

  function findSentence(text, term) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    const termIndex = value.toLocaleLowerCase().indexOf(String(term).toLocaleLowerCase());
    if (termIndex < 0) return value;
    const before = value.slice(0, termIndex);
    const after = value.slice(termIndex + term.length);
    const start = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("。"), before.lastIndexOf("！"), before.lastIndexOf("？")) + 1;
    const endings = [".", "!", "?", "。", "！", "？"].map((punctuation) => {
      const index = after.indexOf(punctuation);
      return index < 0 ? Infinity : index;
    });
    const endOffset = Math.min(...endings);
    const end = endOffset === Infinity ? value.length : termIndex + term.length + endOffset + 1;
    return value.slice(start, end).trim();
  }

  async function saveVocabulary(term, lookup, context) {
    const { [VOCABULARY_STORAGE_KEY]: vocabulary = {} } = await chrome.storage.local.get(VOCABULARY_STORAGE_KEY);
    const sentence = context.selectedSentence || context.translatedText || term;
    const canonicalTerm = normalizeVocabularyTerm(term);
    const matchingEntries = Object.entries(vocabulary).filter(([, item]) => normalizeVocabularyTerm(item.term) === canonicalTerm);
    const existing = matchingEntries[0]?.[1] || {};
    const existingExamples = matchingEntries.flatMap(([, item]) => vocabularyExamples(item));
    matchingEntries.forEach(([key]) => delete vocabulary[key]);
    const newExample = { sentence, sourceSentence: lookup.sourceSentence || context.sourceParagraph || "", addedAt: Date.now() };
    const examples = uniqueExamples([...existingExamples, newExample]);
    const key = vocabularyKey(canonicalTerm);
    vocabulary[key] = {
      ...existing,
      term: canonicalTerm,
      translation: lookup.translation,
      sentence,
      sourceSentence: newExample.sourceSentence,
      examples,
      note: lookup.note || "",
      referent: lookup.referent || "",
      sourceParagraph: context.sourceParagraph || "",
      translatedText: context.translatedText || "",
      status: existing.status || "learning",
      reviewCount: existing.reviewCount || 0,
      addedAt: existing.addedAt || Date.now(),
      updatedAt: Date.now()
    };
    const entries = Object.entries(vocabulary).sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0));
    await chrome.storage.local.set({ [VOCABULARY_STORAGE_KEY]: Object.fromEntries(entries.slice(0, MAX_VOCABULARY_ENTRIES)) });
  }

  function vocabularyKey(term) {
    let hash = 2166136261;
    for (const character of term.trim().toLowerCase()) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function normalizeVocabularyTerm(term) {
    const value = String(term || "").trim().toLowerCase();
    if (!/^[a-z][a-z'-]+$/i.test(value) || value.length <= 3 || /(?:ss|is|was|has)$/.test(value)) return value;
    if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
    if (value.endsWith("s")) return value.slice(0, -1);
    return value;
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

  function openPracticePanel(source) {
    document.querySelector(".ds-practice-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "ds-practice-overlay";
    overlay.innerHTML = `
      <section class="ds-practice-card" role="dialog" aria-modal="true" aria-label="翻译练习">
        <header class="ds-practice-header"><div><p>TRANSLATION PRACTICE</p><h2>我的翻译练习</h2></div><button class="ds-practice-close" type="button" aria-label="关闭">×</button></header>
        <div class="ds-practice-section"><span class="ds-practice-label">原文</span><p class="ds-practice-source"></p></div>
        <label class="ds-practice-section"><span class="ds-practice-label">我的译文</span><textarea class="ds-practice-input" placeholder="在这里写下你的翻译…" autofocus></textarea></label>
        <div class="ds-practice-actions"><button class="ds-practice-submit" type="button">提交并获取批改</button><span class="ds-practice-status"></span></div>
        <div class="ds-practice-result" hidden></div>
      </section>`;
    overlay.querySelector(".ds-practice-source").textContent = source;
    const input = overlay.querySelector(".ds-practice-input");
    const status = overlay.querySelector(".ds-practice-status");
    let draftTimer;
    const saveCurrentDraft = async (showStatus = true) => {
      const text = input.value.trim();
      if (!text) { if (showStatus) status.textContent = "请先写下译文再保存。"; return; }
      await savePracticeDraft(source, text);
      if (showStatus) status.textContent = "草稿已保存到本机。";
    };
    const close = () => {
      clearTimeout(draftTimer);
      if (input.value.trim()) saveCurrentDraft(false).catch(() => {});
      overlay.remove();
    };
    overlay.querySelector(".ds-practice-close").addEventListener("click", close);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
    input.addEventListener("input", () => {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        saveCurrentDraft(true).catch(() => { status.textContent = "草稿自动保存失败。"; });
      }, 700);
    });
    overlay.querySelector(".ds-practice-submit").addEventListener("click", async () => {
      const button = overlay.querySelector(".ds-practice-submit");
      const userTranslation = input.value.trim();
      if (!userTranslation) { status.textContent = "请先写下你的译文。"; return; }
      button.disabled = true;
      status.textContent = "DeepSeek 正在批改…";
      try {
        const response = await sendPracticeRequest(source, userTranslation);
        if (!response?.ok) throw new Error(response?.error || "批改请求失败。");
        renderPracticeResult(overlay.querySelector(".ds-practice-result"), response.evaluation);
        status.textContent = "批改完成";
      } catch (error) {
        status.textContent = error.message || "批改失败，请重试。";
      } finally {
        button.disabled = false;
      }
    });
    document.body.append(overlay);
    loadPracticeDraft(source).then((draft) => {
      if (draft && !input.value) {
        input.value = draft;
        status.textContent = "已恢复本机草稿。";
      }
      input.focus();
    }).catch(() => input.focus());
  }

  function sendPracticeRequest(source, userTranslation) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "evaluateTranslation", source, userTranslation }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(response);
      });
    });
  }

  function renderPracticeResult(container, evaluation) {
    const list = (items, empty) => items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p>${empty}</p>`;
    const sentenceAnalyses = renderSentenceAnalyses(evaluation.sentenceAnalyses || []);
    container.innerHTML = `
      <div class="ds-practice-score"><strong>${evaluation.score}</strong><span>/ 100 分</span></div>
      <p class="ds-practice-summary">${escapeHtml(evaluation.summary)}</p>
      <div class="ds-practice-grid"><section><h3>做得好</h3>${list(evaluation.strengths, "继续保持。")}</section><section><h3>建议改进</h3>${list(evaluation.improvements, "表达准确自然。")}</section></div>
      ${sentenceAnalyses}
      <section class="ds-practice-answer"><h3>参考译文</h3><p>${escapeHtml(evaluation.referenceTranslation)}</p></section>
      <section class="ds-practice-answer"><h3>建议修改版</h3><p>${escapeHtml(evaluation.correctedTranslation)}</p></section>`;
    container.hidden = false;
  }

  function renderSentenceAnalyses(analyses) {
    if (!analyses.length) return "";
    return `<section class="ds-sentence-analysis"><h3>逐句对照讲解</h3>${analyses.map((item, index) => {
      const issues = item.issues.length
        ? `<div class="ds-analysis-issues">${item.issues.map((issue) => `<article><span>${escapeHtml(issue.category)}</span><p>${escapeHtml(issue.explanation)}</p>${issue.sourceFragment || issue.learnerFragment ? `<small>原文：${escapeHtml(issue.sourceFragment || "—")}<br>练习：${escapeHtml(issue.learnerFragment || "—")}</small>` : ""}${issue.suggestion ? `<strong>建议：${escapeHtml(issue.suggestion)}</strong>` : ""}</article>`).join("")}</div>`
        : `<p class="ds-analysis-clear">这一句表达准确，没有需要修正的关键错误。</p>`;
      const points = item.knowledgePoints.length
        ? `<div class="ds-knowledge-points">${item.knowledgePoints.map((point) => `<article><span>${escapeHtml(point.type)}</span><strong>${escapeHtml(point.point)}</strong><p>${escapeHtml(point.explanation)}</p></article>`).join("")}</div>`
        : "";
      return `<article class="ds-sentence-card"><header><span>第 ${index + 1} 句</span><p>${escapeHtml(item.verdict)}</p></header><div class="ds-sentence-compare"><section><h4>原文</h4><p>${escapeHtml(item.source)}</p></section><section><h4>参考译文</h4><p>${escapeHtml(item.reference)}</p></section><section><h4>我的译文</h4><p>${escapeHtml(item.learner)}</p></section></div><h4 class="ds-analysis-heading">问题与改进</h4>${issues}${points ? `<h4 class="ds-analysis-heading">知识点</h4>${points}` : ""}</article>`;
    }).join("")}</section>`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  }

  async function loadPracticeDraft(source) {
    const { [DRAFT_STORAGE_KEY]: drafts = {} } = await chrome.storage.local.get(DRAFT_STORAGE_KEY);
    const draft = drafts[draftKey(source)];
    return draft?.source === source && typeof draft.translation === "string" ? draft.translation : "";
  }

  async function savePracticeDraft(source, translation) {
    const { [DRAFT_STORAGE_KEY]: drafts = {} } = await chrome.storage.local.get(DRAFT_STORAGE_KEY);
    drafts[draftKey(source)] = { source, translation, savedAt: Date.now() };
    const entries = Object.entries(drafts).sort(([, a], [, b]) => (b.savedAt || 0) - (a.savedAt || 0));
    await chrome.storage.local.set({ [DRAFT_STORAGE_KEY]: Object.fromEntries(entries.slice(0, MAX_PRACTICE_DRAFTS)) });
  }

  function draftKey(source) {
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }
})();
