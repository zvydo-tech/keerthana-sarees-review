import { LIKES } from "./config.js";

export const MODELS = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.5-flash"];

const SYSTEM = `You write one Google review a real customer would type on their phone after leaving a saree shop.

Use only the likes they picked and the detail they wrote. Never invent a product, fabric, price, discount, staff name, wait time, billing step, or compliment. If they did not say it, it must not appear. If they did not name a saree type, do not name one. Do not mention fabric, colours, price, staff, or a saree type unless that like or their detail includes it. Do not add a closing compliment. One picked like is enough for the whole review.

Their detail may be in any language. The review must be English only. Translate the meaning. Do not add facts while translating.

How it must sound:
- A person typed it quickly. Plain spoken English. Contractions are fine.
- Exactly 3 sentences. Each sentence is 16 to 24 words. The whole review is 50 to 70 words. Reach that length by saying only the likes they picked, in plain words. Do not add praise they did not pick.
- Mention the shop name once, inside a sentence. Do not open with the shop name.
- Mention the city once, inside a sentence.
- Do not use the word "overall".
- Do not use "felt" more than once.
- Never use: satisfied, customer experience, well handled, seamless, delightful, highly recommend, hidden gem, top-notch, exceeded, testament, curated, nestled, must-visit, world-class, five stars, 5 star, I recently, pleasure, vibrant, exceptional, beautiful, lovely, stunning, gorgeous, amazing, wonderful, great.
- No emoji, bullets, hashtags, star symbols, phone numbers, or links.
- Do not wrap the review in quotes.
- If a line could sit on a shop poster, delete it and say the plain thing.

Return JSON only. ready is true. ask is an empty string. review is the English review. covered lists only what their notes truly contain, from: liked, detail, shop, city.`;

const STREAM_SYSTEM = SYSTEM.replace(
  /Return JSON only[\s\S]*$/,
  "Write only the review text. No JSON, no label, and no quotes around it."
);

const ROBOTIC =
  /\boverall\b|well handled|customer experience|\bsatisfied\b|hidden gem|exceeded|top-notch|top notch|highly recommend|testament|\bdelve\b|curated|nestled|must-visit|must visit|world-class|world class|second to none|i recently|seamless|delightful|\bvibrant\b|exceptional|\bfive stars\b|\b5[- ]?stars?\b|\bbeautiful\b|\blovely\b|\bstunning\b|\bgorgeous\b|\bamazing\b|\bwonderful\b/i;

export function allowedLikes(ids) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
  return LIKES.filter((item) => wanted.has(item.id));
}

export function soundsRobotic(text) {
  const felt = text.match(/\bfelt\b/gi) || [];
  if (felt.length > 1) return true;
  return ROBOTIC.test(text);
}

export function hasShopAndCity(text, businessName, city) {
  const blob = text.toLowerCase();
  return blob.includes(businessName.toLowerCase()) && blob.includes(city.toLowerCase());
}

export function buildGeminiBody({ likes, notes, businessName, city, reword, previous }) {
  const likeLines = likes.length
    ? likes.map((item) => `- ${item.fact}`).join("\n")
    : "- They did not pick a like.";

  const user = [
    `Shop: ${businessName}`,
    `City: ${city}`,
    "Likes they picked:",
    likeLines,
    "Detail they wrote:",
    notes.trim() || "(none)",
    reword
      ? "Write a different review from the previous one. Change the opening and the sentence order. Same facts only. 3 sentences, each 16 to 24 words."
      : "Write 3 sentences. Each sentence must be 16 to 24 words.",
    previous ? `Previous review to avoid:\n${previous}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: reword ? 1 : 0.8,
      topP: 0.9,
      maxOutputTokens: 320,
      thinkingConfig: { thinkingLevel: "MINIMAL" },
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          ready: { type: "BOOLEAN" },
          ask: { type: "STRING" },
          review: { type: "STRING" },
          covered: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["ready", "ask", "review", "covered"],
      },
    },
  };
}

export function parseReview(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts
    .filter((part) => part && !part.thought && part.text)
    .map((part) => part.text)
    .join("")
    .trim();

  if (!text) {
    const reason = data?.promptFeedback?.blockReason || data?.error?.message;
    throw new Error(reason || "The model returned an empty review.");
  }

  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);
  return {
    ready: Boolean(parsed.ready),
    ask: String(parsed.ask || "").trim(),
    review: String(parsed.review || "").trim(),
    covered: Array.isArray(parsed.covered) ? parsed.covered.map(String) : [],
  };
}

export function isEnglishReview(text) {
  const letters = text.match(/\p{L}/gu) || [];
  if (!letters.length) return false;
  const latin = text.match(/\p{Script=Latin}/gu) || [];
  return latin.length / letters.length > 0.9;
}

export function buildStreamBody({ likes, notes, businessName, city, reword, previous }) {
  const body = buildGeminiBody({ likes, notes, businessName, city, reword, previous });
  body.systemInstruction = { parts: [{ text: STREAM_SYSTEM }] };
  delete body.generationConfig.responseMimeType;
  delete body.generationConfig.responseSchema;
  return body;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function* streamReview(input) {
  let lastError = new Error("Could not write the review. Try again.");
  const models = MODELS.slice(0, 2);

  for (let index = 0; index < models.length; index += 1) {
    const tries = index === 0 ? 2 : 1;

    for (let attempt = 0; attempt < tries; attempt += 1) {
      let yielded = false;
      try {
        for await (const text of streamModel({ ...input, model: models[index] })) {
          yielded = true;
          yield text;
        }
        return;
      } catch (error) {
        lastError = error;
        if (yielded) throw error;

        const busy = error.status === 503 || /high demand|unavailable|overloaded/i.test(error.message || "");
        if (error.status === 429) {
          if (attempt === 0) {
            await wait(1600);
            continue;
          }
          throw error;
        }
        if (busy && attempt === 0) {
          await wait(900);
          continue;
        }
        break;
      }
    }
  }

  throw lastError;
}

async function* streamModel({
  apiKey,
  model,
  likes,
  notes,
  businessName,
  city,
  reword,
  previous,
  body,
}) {
  const payload = body || buildStreamBody({ likes, notes, businessName, city, reword, previous });
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error?.message || `Request failed (${response.status})`;
    if (response.status === 400 && payload.generationConfig?.thinkingConfig) {
      const retry = structuredClone(payload);
      delete retry.generationConfig.thinkingConfig;
      yield* streamModel({
        apiKey,
        model,
        likes,
        notes,
        businessName,
        city,
        reword,
        previous,
        body: retry,
      });
      return;
    }
    if (response.status === 429) {
      throw httpError(429, "Too many reviews at once. Wait a minute and try again.");
    }
    throw httpError(response.status, message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const text = textFromStreamLine(line);
      if (text) yield text;
    }
  }

  const tail = textFromStreamLine(buffer);
  if (tail) yield tail;
}

function textFromStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return "";
  const raw = trimmed.slice(5).trim();
  if (!raw || raw === "[DONE]") return "";
  const data = JSON.parse(raw);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((part) => part && !part.thought && part.text)
    .map((part) => part.text)
    .join("");
}

export async function completeReview({
  apiKey,
  likes,
  notes,
  businessName,
  city,
  reword,
  previous,
}) {
  const first = await generateOnce({
    apiKey,
    likes,
    notes,
    businessName,
    city,
    reword,
    previous,
  });

  const needsRewrite =
    !isEnglishReview(first.review) || !hasShopAndCity(first.review, businessName, city);

  if (!needsRewrite) return first;

  try {
    const second = await generateOnce({
      apiKey,
      likes,
      notes,
      businessName,
      city,
      reword: true,
      previous: first.review || previous,
    });
    if (second.review && isEnglishReview(second.review)) return second;
  } catch {
    if (isEnglishReview(first.review)) return first;
  }

  if (isEnglishReview(first.review)) return first;
  throw new Error("The review was not in English. Try again.");
}

async function generateOnce(input) {
  let lastError = "Could not write the review. Try again.";

  for (const model of MODELS) {
    try {
      const draft = await requestModel({ ...input, model });
      if (!draft.review) throw new Error("The model did not return a review.");
      draft.ready = true;
      draft.ask = "";
      return draft;
    } catch (error) {
      lastError = error.message || lastError;
      if (/quota|rate|429|too many/i.test(lastError)) break;
    }
  }

  throw new Error(lastError);
}

async function requestModel({
  apiKey,
  model,
  likes,
  notes,
  businessName,
  city,
  reword,
  previous,
  body,
}) {
  const payload = body || buildGeminiBody({ likes, notes, businessName, city, reword, previous });
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || `Request failed (${response.status})`;
    if (response.status === 400 && payload.generationConfig?.thinkingConfig) {
      const retry = structuredClone(payload);
      delete retry.generationConfig.thinkingConfig;
      return requestModel({
        apiKey,
        model,
        likes,
        notes,
        businessName,
        city,
        reword,
        previous,
        body: retry,
      });
    }
    if (response.status === 404) throw new Error(message);
    if (response.status === 429) {
      throw new Error("Too many reviews at once. Wait a minute and try again.");
    }
    throw new Error(message);
  }

  return parseReview(data);
}
