#!/usr/bin/env node
// Translate a single Markdown file to Simplified Chinese.
//
// Usage: node scripts/translate-zh.mjs <input.md> <output.md>
//
// Env:
//   TRANSLATE_BACKEND     : openai | claude | deepl   (default: openai)
//
//   OPENAI_API_KEY        : required when backend=openai
//   OPENAI_BASE_URL       : default https://api.openai.com/v1
//   OPENAI_MODEL          : default gpt-4o-mini
//
//   ANTHROPIC_API_KEY     : required when backend=claude
//   ANTHROPIC_BASE_URL    : default https://api.anthropic.com
//   ANTHROPIC_MODEL       : default claude-haiku-4-5-20251001
//
//   DEEPL_API_KEY         : required when backend=deepl
//   DEEPL_BASE_URL        : default https://api-free.deepl.com (free key)
//                           use https://api.deepl.com for a Pro key
//
// Skeleton mode: when the selected key is absent, the file is written as-is
// with a visible "pending translation" marker so the pipeline runs end-to-end.
// Drop the key into GitHub Secrets and the same code starts translating for real.

import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: translate-zh.mjs <input.md> <output.md>");
  process.exit(1);
}

const BACKEND = process.env.TRANSLATE_BACKEND || "openai";

// Per-backend config. Key absent → skeleton mode.
const CONFIG = {
  openai: {
    key: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  },
  claude: {
    key: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
  },
  deepl: {
    key: process.env.DEEPL_API_KEY,
    baseUrl: process.env.DEEPL_BASE_URL || "https://api-free.deepl.com",
  },
};

if (!CONFIG[BACKEND]) {
  console.error(`Unknown backend: ${BACKEND} (use openai | claude | deepl)`);
  process.exit(1);
}
const KEY = CONFIG[BACKEND].key;

const PROMPT =
  "Translate the following Markdown text to Simplified Chinese (简体中文). " +
  "Preserve all Markdown formatting, line breaks, list markers, and links exactly. " +
  "Do NOT translate anything inside  N  placeholders, URLs, or code. " +
  "Keep technical terms and proper nouns in English when that is clearer. " +
  "Output ONLY the translated text, nothing else.";

// Protect inline `code` within a prose chunk with  N  placeholders the model
// is told to leave alone, translate, then restore.
async function translateProse(chunk) {
  if (!chunk.trim()) return chunk;
  const inlineRe = /`[^`\n]+`/g;
  const placeholders = [];
  const protected_ = chunk.replace(inlineRe, (code) => {
    placeholders.push(code);
    return ` ${placeholders.length - 1} `;
  });
  const translated = await translateText(protected_);
  return translated.replace(/ (\d+) /g, (_, n) => placeholders[Number(n)] ?? "");
}

// Translate a body (everything after frontmatter), leaving fenced code blocks
// untouched and translating the prose between them.
async function translateBody(body) {
  const fenceRe = /```[\s\S]*?```/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = fenceRe.exec(body)) !== null) {
    parts.push(await translateProse(body.slice(last, m.index)));
    parts.push(m[0]); // fenced code block — untouched
    last = m.index + m[0].length;
  }
  parts.push(await translateProse(body.slice(last)));
  return parts.join("");
}

async function translateText(text) {
  if (!KEY) {
    // Skeleton mode: pass through unchanged. A single top-of-file marker is
    // added in main() so the output stays clean.
    return text;
  }
  if (BACKEND === "claude") return translateClaude(text);
  if (BACKEND === "openai") return translateOpenAI(text);
  if (BACKEND === "deepl") return translateDeepL(text);
  throw new Error(`Unknown backend: ${BACKEND}`);
}

async function translateClaude(text) {
  const { key, baseUrl, model } = CONFIG.claude;
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      messages: [{ role: "user", content: `${PROMPT}\n\n${text}` }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.map((b) => b.text).join("");
}

async function translateOpenAI(text) {
  const { key, baseUrl, model } = CONFIG.openai;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: `${PROMPT}\n\n${text}` }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function translateDeepL(text) {
  const { key, baseUrl } = CONFIG.deepl;
  const res = await fetch(`${baseUrl}/v2/translate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      auth_key: key,
      text,
      target_lang: "ZH",
      tag_handling: "markdown",
    }),
  });
  if (!res.ok) throw new Error(`DeepL ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.translations.map((t) => t.text).join("");
}

async function main() {
  const raw = readFileSync(input, "utf8");
  let result;
  let prefix = "";
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---\n", 4);
    if (end !== -1) {
      prefix = raw.slice(0, end + 5);
      result = await translateBody(raw.slice(end + 5));
    } else {
      result = await translateBody(raw);
    }
  } else {
    result = await translateBody(raw);
  }
  if (!KEY) {
    prefix += `<!-- 待翻译：未配置 ${BACKEND} API key，以下为原文占位 -->\n`;
  }
  writeFileSync(output, prefix + result, "utf8");
  console.error(`translated: ${input} -> ${output} (${KEY ? BACKEND : "skeleton"})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
