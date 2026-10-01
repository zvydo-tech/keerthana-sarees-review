import { statSync } from "node:fs";
import { streamReview } from "../prompt.js";

const configFile = new URL("../config.js", import.meta.url);

async function loadConfig() {
  const version = statSync(configFile).mtimeMs;
  return import(`${configFile.href}?v=${version}`);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(501).json({ error: "Review writing is not set up on this page yet." });
    return;
  }

  const { CONFIG, LIKES } = await loadConfig();
  const wanted = new Set((Array.isArray(req.body?.likes) ? req.body.likes : []).map(String));
  const likes = LIKES.filter((item) => wanted.has(item.id));
  const notes = String(req.body?.notes || "").slice(0, 800);
  const previous = String(req.body?.previous || "").slice(0, 600);

  if (!likes.length && notes.trim().length < 8) {
    res.status(400).json({ error: "Pick at least one thing you liked." });
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const writeEvent = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    let wrote = false;
    for await (const text of streamReview({
      apiKey,
      likes,
      notes,
      previous,
      businessName: CONFIG.businessName,
      city: CONFIG.city,
      reword: Boolean(req.body?.reword),
    })) {
      if (!text) continue;
      wrote = true;
      writeEvent({ text });
    }
    if (!wrote) throw new Error("The model did not return a review.");
    writeEvent({ done: true });
    res.end();
  } catch (error) {
    console.error(error);
    const message = customerError(error.message);
    if (!res.headersSent) {
      res.status(502).json({ error: message });
      return;
    }
    writeEvent({ error: message });
    res.end();
  }
}

function customerError(message) {
  const text = String(message || "");
  if (/too many reviews|wait a minute/i.test(text)) return text;
  if (/not in english/i.test(text)) return "Could not write the review in English. Try again.";
  return "Could not write the review. Try again.";
}
