const API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const SUPPORTED_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
const CACHE_STORAGE_KEY = "deepseekTranslationCacheV1";
const WORD_LOOKUP_CACHE_KEY = "deepseekWordLookupCacheV1";
const MAX_CACHE_ENTRIES = 1500;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_CLEANUP_ALARM = "deepseekTranslationCacheCleanup";
const DOUBAO_TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const DOUBAO_RESOURCE_ID = "seed-tts-2.0";

chrome.runtime.onInstalled.addListener(() => {
  scheduleCacheCleanup();
  installContextMenu();
});
chrome.runtime.onStartup.addListener(scheduleCacheCleanup);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CACHE_CLEANUP_ALARM) removeExpiredCacheEntries();
});

function scheduleCacheCleanup() {
  chrome.alarms.create(CACHE_CLEANUP_ALARM, { periodInMinutes: 24 * 60 });
  removeExpiredCacheEntries();
}

function installContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "deepseek-translation-practice",
      title: "使用 DeepSeek 进行翻译练习",
      contexts: ["selection"]
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "deepseek-translation-practice" || !tab?.id || !info.selectionText?.trim()) return;
  openPracticeFromContextMenu(tab.id, info.selectionText.trim());
});

async function openPracticeFromContextMenu(tabId, source) {
  try {
    await sendTabMessage(tabId, { type: "openPractice", source });
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await sendTabMessage(tabId, { type: "openPractice", source });
    } catch {
      // Chrome internal and protected pages do not permit context-menu injection.
    }
  }
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "translate") {
    translate(message.texts)
      .then(({ translations, cached }) => sendResponse({ ok: true, translations, cached }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "evaluateTranslation") {
    evaluateTranslation(message.source, message.userTranslation)
      .then((evaluation) => sendResponse({ ok: true, evaluation }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "lookupWord") {
    lookupWord(message.term, message.context)
      .then((lookup) => sendResponse({ ok: true, lookup }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "synthesizeDoubao") {
    synthesizeDoubao(message.text, message.isChinese, message.config)
      .then((audioBase64) => sendResponse({ ok: true, audioBase64 }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

async function synthesizeDoubao(text, isChinese = false, config = null) {
  const settings = config || await chrome.storage.local.get([
    "doubaoApiKey", "doubaoChineseVoice", "doubaoEnglishVoice"
  ]);
  const apiKey = String(settings.apiKey ?? settings.doubaoApiKey ?? "").trim();
  const chineseVoice = String(settings.chineseVoice ?? settings.doubaoChineseVoice ?? "zh_female_lingling_uranus_bigtts").trim();
  const englishVoice = String(settings.englishVoice ?? settings.doubaoEnglishVoice ?? "en_female_pleasant-female_uranus_bigtts").trim();
  const normalizedText = String(text || "").replace(/\s+/g, " ").trim();
  // 新版火山引擎控制台只需 API Key；App ID 属于旧版鉴权，不应与新版凭证混用。
  if (!apiKey) throw new Error("请先在管理后台填写豆包语音 API Key。");
  if (!normalizedText || normalizedText.length > 3000) throw new Error("朗读文本应为 1 到 3000 个字符。");
  const response = await fetch(DOUBAO_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": DOUBAO_RESOURCE_ID,
      "X-Api-Request-Id": crypto.randomUUID()
    },
    body: JSON.stringify({
      user: { uid: "chrome-bilingual-translator" },
      req_params: {
        text: normalizedText,
        speaker: isChinese ? chineseVoice : englishVoice,
        audio_params: { format: "mp3", sample_rate: 24000 }
      }
    })
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(readDoubaoError(raw, `豆包语音请求失败（${response.status}）`));
  const audio = collectDoubaoAudio(raw);
  if (!audio.length) throw new Error(readDoubaoError(raw, "豆包未返回可播放的音频。"));
  return bytesToBase64(audio);
}

function collectDoubaoAudio(raw) {
  const chunks = [];
  let failureMessage = "";
  for (const payload of extractJsonObjects(raw)) {
    // 0 为音频分片成功；20000000 是官方定义的合成完成成功码，不能误判为失败。
    const code = Number(payload.code);
    if (Number.isFinite(code) && code !== 0 && code !== 20000000) {
      failureMessage = payload.message || payload.error || failureMessage;
    }
    const encoded = typeof payload.data === "string" ? payload.data : payload.audio;
    if (typeof encoded === "string" && encoded.length > 32) chunks.push(base64ToBytes(encoded));
  }
  if (failureMessage) throw new Error(`豆包语音：${failureMessage}`);
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const audio = new Uint8Array(length);
  let offset = 0;
  chunks.forEach((chunk) => { audio.set(chunk, offset); offset += chunk.length; });
  return audio;
}

function extractJsonObjects(raw) {
  const records = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === "{") { if (depth === 0) start = index; depth += 1; continue; }
    if (character === "}" && depth) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { records.push(JSON.parse(raw.slice(start, index + 1))); } catch { /* Ignore malformed stream fragments. */ }
        start = -1;
      }
    }
  }
  return records;
}

function readDoubaoError(raw, fallback) {
  const records = extractJsonObjects(raw);
  const message = records.find((item) => item?.message || item?.error)?.message || records.find((item) => item?.error)?.error;
  const plain = String(raw || "").replace(/\s+/g, " ").trim();
  return message ? `豆包语音：${message}` : plain ? `豆包语音：${plain.slice(0, 240)}` : fallback;
}

function base64ToBytes(value) {
  const binary = atob(value.replace(/^data:audio\/[^;]+;base64,/, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(bytes) {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(output);
}

async function translate(texts) {
  const { deepseekToken: token, deepseekModel: savedModel } =
    await chrome.storage.local.get(["deepseekToken", "deepseekModel"]);
  const model = SUPPORTED_MODELS.has(savedModel) ? savedModel : DEFAULT_MODEL;
  if (!token || !token.trim()) throw new Error("请先在插件中填写 DeepSeek Token。");
  if (!Array.isArray(texts) || texts.length === 0) return { translations: [], cached: 0 };

  const { [CACHE_STORAGE_KEY]: cache = {} } = await chrome.storage.local.get(CACHE_STORAGE_KEY);
  const removedExpired = removeExpiredEntries(cache);
  const translations = new Array(texts.length);
  const missing = [];
  let cached = 0;
  texts.forEach((text, index) => {
    const key = cacheKey(model, text);
    const entry = cache[key];
    if (entry?.source === text && typeof entry.translation === "string") {
      translations[index] = entry.translation;
      cached += 1;
    } else {
      missing.push({ index, text, key });
    }
  });
  if (missing.length === 0) {
    if (removedExpired) await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
    return { translations, cached };
  }

  try {
    const newTranslations = await requestTranslations(token, model, missing.map((item) => item.text));
    saveTranslations(cache, translations, missing, newTranslations);
  } catch (error) {
    if (!error.isTranslationFormatError || missing.length === 1) throw error;
    const newTranslations = [];
    for (const item of missing) {
      newTranslations.push(...await requestTranslations(token, model, [item.text]));
    }
    saveTranslations(cache, translations, missing, newTranslations);
  }
  await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: trimCache(cache) });
  return { translations, cached };
}

function saveTranslations(cache, translations, missing, newTranslations) {
  missing.forEach((item, index) => {
    const translation = String(newTranslations[index] ?? "");
    translations[item.index] = translation;
    cache[item.key] = { source: item.text, translation, savedAt: Date.now() };
  });
}

function trimCache(cache) {
  const entries = Object.entries(cache);
  if (entries.length <= MAX_CACHE_ENTRIES) return cache;
  entries.sort(([, a], [, b]) => (b.savedAt || 0) - (a.savedAt || 0));
  return Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES));
}

function removeExpiredEntries(cache, now = Date.now()) {
  let changed = false;
  Object.entries(cache).forEach(([key, entry]) => {
    if (!entry?.savedAt || now - entry.savedAt >= CACHE_TTL_MS) {
      delete cache[key];
      changed = true;
    }
  });
  return changed;
}

async function removeExpiredCacheEntries() {
  const { [CACHE_STORAGE_KEY]: cache = {} } = await chrome.storage.local.get(CACHE_STORAGE_KEY);
  if (removeExpiredEntries(cache)) await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
}

function cacheKey(model, text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${model}:${(hash >>> 0).toString(36)}`;
}

async function requestTranslations(token, model, texts) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token.trim()}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      max_tokens: 8192,
      messages: [
        {
          role: "system",
          content: "You are a precise webpage translator. Translate Chinese to natural English and English to natural Simplified Chinese. Preserve meaning, names, numbers, URLs, Markdown-like symbols and line breaks. Return only valid JSON in the shape {\"translations\":[\"...\"]}. The translations array must have exactly the same order and length as the input."
        },
        {
          role: "user",
          content: JSON.stringify({ texts })
        }
      ]
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `DeepSeek 请求失败（${response.status}）`);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek 没有返回翻译内容。");

  let parsed;
  try {
    parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    throw formatError("DeepSeek 返回格式无效，正在尝试逐段重试。");
  }
  if (!Array.isArray(parsed.translations) || parsed.translations.length !== texts.length) {
    throw formatError("DeepSeek 返回的译文数量不匹配，正在尝试逐段重试。");
  }
  return parsed.translations.map((text) => String(text));
}

function formatError(message) {
  const error = new Error(message);
  error.isTranslationFormatError = true;
  return error;
}

async function evaluateTranslation(source, userTranslation) {
  if (!source?.trim() || !userTranslation?.trim()) throw new Error("请先填写原文和自己的译文。");
  if (source.length > 6000 || userTranslation.length > 6000) throw new Error("练习文本过长，请选择不超过 6000 个字符的内容。");
  const { deepseekToken: token, deepseekModel: savedModel } =
    await chrome.storage.local.get(["deepseekToken", "deepseekModel"]);
  const model = SUPPORTED_MODELS.has(savedModel) ? savedModel : DEFAULT_MODEL;
  if (!token?.trim()) throw new Error("请先在管理后台填写 DeepSeek Token。");

  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.trim()}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      max_tokens: 5000,
      messages: [
        {
          role: "system",
          content: "You are an encouraging but rigorous bilingual translation tutor. Determine the translation direction from the source text. First align and analyze every sentence in the source with the learner translation, even when sentence boundaries differ. Assess accuracy, completeness, naturalness, grammar, terminology, phrases/collocations, vocabulary, punctuation and style. Explain actual errors and likely error-prone choices; do not invent errors. Return only valid JSON: {\"score\":0-100,\"referenceTranslation\":\"complete natural translation\",\"summary\":\"Chinese overall feedback\",\"strengths\":[\"Chinese point\"],\"improvements\":[\"Chinese actionable point\"],\"correctedTranslation\":\"complete improved learner translation\",\"sentenceAnalyses\":[{\"source\":\"one complete source sentence\",\"reference\":\"matching reference translation\",\"learner\":\"matching learner translation\",\"verdict\":\"Chinese one-sentence verdict\",\"issues\":[{\"category\":\"准确性/语法/短语搭配/词汇/标点/表达\",\"sourceFragment\":\"relevant source fragment\",\"learnerFragment\":\"relevant learner fragment\",\"explanation\":\"Chinese explanation\",\"suggestion\":\"specific improved wording\"}],\"knowledgePoints\":[{\"type\":\"语法/短语/词汇/易错点\",\"point\":\"term or pattern\",\"explanation\":\"Chinese explanation\"}]}]}. Include one sentenceAnalyses item for every meaningful source sentence. Use empty issues only when the sentence has no material issue, but still give useful knowledgePoints when possible. The score must be an integer. Do not penalize valid wording differences from your reference."
        },
        { role: "user", content: JSON.stringify({ sourceText: source, learnerTranslation: userTranslation }) }
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `DeepSeek 请求失败（${response.status}）`);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek 没有返回批改结果。");

  let evaluation;
  try {
    evaluation = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    throw new Error("DeepSeek 返回的批改格式无效，请重试。");
  }
  const score = Number(evaluation.score);
  if (!Number.isFinite(score) || !evaluation.referenceTranslation || !evaluation.correctedTranslation) {
    throw new Error("DeepSeek 返回的批改内容不完整，请重试。");
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    referenceTranslation: String(evaluation.referenceTranslation),
    summary: String(evaluation.summary || ""),
    strengths: Array.isArray(evaluation.strengths) ? evaluation.strengths.map(String).slice(0, 4) : [],
    improvements: Array.isArray(evaluation.improvements) ? evaluation.improvements.map(String).slice(0, 5) : [],
    correctedTranslation: String(evaluation.correctedTranslation),
    sentenceAnalyses: Array.isArray(evaluation.sentenceAnalyses) ? evaluation.sentenceAnalyses.slice(0, 20).map((item) => ({
      source: String(item.source || ""),
      reference: String(item.reference || ""),
      learner: String(item.learner || ""),
      verdict: String(item.verdict || ""),
      issues: Array.isArray(item.issues) ? item.issues.slice(0, 6).map((issue) => ({
        category: String(issue.category || "问题"),
        sourceFragment: String(issue.sourceFragment || ""),
        learnerFragment: String(issue.learnerFragment || ""),
        explanation: String(issue.explanation || ""),
        suggestion: String(issue.suggestion || "")
      })) : [],
      knowledgePoints: Array.isArray(item.knowledgePoints) ? item.knowledgePoints.slice(0, 6).map((point) => ({
        type: String(point.type || "知识点"),
        point: String(point.point || ""),
        explanation: String(point.explanation || "")
      })) : []
    })) : []
  };
}

async function lookupWord(term, context = "") {
  const selected = term?.trim();
  if (!selected || selected.length > 100) throw new Error("请选择一个较短的单词或短语。");
  const contextPayload = typeof context === "string"
    ? { translatedText: context.slice(0, 1200) }
    : {
        translatedText: String(context?.translatedText || "").slice(0, 1200),
        selectedSentence: String(context?.selectedSentence || "").slice(0, 800),
        sourceParagraph: String(context?.sourceParagraph || "").slice(0, 1200),
        priorSource: String(context?.priorSource || "").slice(0, 1800)
      };
  const { deepseekToken: token, deepseekModel: savedModel } =
    await chrome.storage.local.get(["deepseekToken", "deepseekModel"]);
  const model = SUPPORTED_MODELS.has(savedModel) ? savedModel : DEFAULT_MODEL;
  if (!token?.trim()) throw new Error("请先在管理后台填写 DeepSeek Token。");

  const { [WORD_LOOKUP_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(WORD_LOOKUP_CACHE_KEY);
  removeExpiredEntries(cache);
  const key = cacheKey(model, `${selected}\n${JSON.stringify(contextPayload)}`);
  const cached = cache[key];
  if (cached?.term === selected && typeof cached.translation === "string" && typeof cached.referent === "string" && typeof cached.sourceSentence === "string") return cached;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.trim()}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content: "You are a concise bilingual dictionary and reading tutor. Translate the selected word or short phrase into the opposite language (English to Simplified Chinese, Chinese to English) using the supplied selected sentence, matching source paragraph, and prior context. If the selected item is a pronoun, demonstrative, relative word, or any contextual reference, identify exactly what it refers to in this context. Also identify the complete source-language sentence corresponding to the selected translated sentence. Return only JSON: {\"translation\":\"concise translation\",\"note\":\"brief Chinese usage note, or empty string\",\"referent\":\"Chinese explanation of the exact antecedent, or empty string if not a reference\",\"sourceSentence\":\"matching complete source-language sentence, or source paragraph if uncertain\"}. Do not add Markdown or guess an antecedent when context is insufficient."
        },
        { role: "user", content: JSON.stringify({ selected, context: contextPayload }) }
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `DeepSeek 请求失败（${response.status}）`);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek 没有返回词义。");
  let parsed;
  try {
    parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    throw new Error("DeepSeek 返回的词义格式无效，请重试。");
  }
  if (!parsed.translation) throw new Error("DeepSeek 没有返回词义。");
  const lookup = { term: selected, translation: String(parsed.translation), note: String(parsed.note || ""), referent: String(parsed.referent || ""), sourceSentence: String(parsed.sourceSentence || contextPayload.sourceParagraph || ""), savedAt: Date.now() };
  cache[key] = lookup;
  await chrome.storage.local.set({ [WORD_LOOKUP_CACHE_KEY]: trimCache(cache) });
  return lookup;
}
