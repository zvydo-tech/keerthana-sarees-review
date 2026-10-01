import { CONFIG, LIKES } from "./config.js";

const $ = (id) => document.getElementById(id);

const WORD_COLORS = ["#4285f4", "#ea4335", "#fbbc05", "#34a853"];

const selected = new Set();
let reviewText = "";
let busy = false;
let paintTimers = [];
let pauseWritesUntil = 0;

function selectedIds() {
  return LIKES.filter((item) => selected.has(item.id)).map((item) => item.id);
}

function setStatus(id, message, isError) {
  const node = $(id);
  node.textContent = message;
  node.classList.toggle("is-error", Boolean(isError));
}

function renderLikes() {
  const group = $("likes");
  for (const item of LIKES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "like-option";
    button.textContent = item.label;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      const on = !selected.has(item.id);
      if (on) selected.add(item.id);
      else selected.delete(item.id);
      button.setAttribute("aria-pressed", on ? "true" : "false");
      setStatus("formStatus", "");
    });
    group.append(button);
  }
}

function showAsk() {
  $("askStep").hidden = false;
  $("draftStep").hidden = true;
  setStatus("formStatus", "");
}

function showDraftShell() {
  $("askStep").hidden = true;
  $("draftStep").hidden = false;
  $("draftStatusPill").classList.remove("is-ready");
  $("draftStatusText").textContent = "Writing your review";
  $("reviewText").classList.add("is-waiting");
  $("reviewText").contentEditable = "false";
  $("reviewText").textContent = "Writing from what you picked.";
  $("copyReview").disabled = true;
  $("openGoogle").disabled = true;
  $("back").disabled = true;
  setStatus("reviewStatus", "");
  $("copyLabel").textContent = "Copy review draft";
}

function clearPaint() {
  while (paintTimers.length) window.clearTimeout(paintTimers.pop());
}

function readyWords(raw) {
  const words = raw.match(/\S+/g) || [];
  return /\s$/.test(raw) ? words : words.slice(0, -1);
}

function revealReview(box) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let raw = "";
  let shown = 0;
  let timer = 0;
  let pumping = false;

  function paintNext() {
    const words = readyWords(raw);
    if (shown >= words.length) {
      pumping = false;
      timer = 0;
      return;
    }

    if (!shown) {
      box.classList.remove("is-waiting");
      box.replaceChildren();
    }

    const span = document.createElement("span");
    span.className = reduce ? "draft-word is-settled" : "draft-word";
    span.textContent = `${shown ? " " : ""}${words[shown]}`;
    if (!reduce) span.style.setProperty("--word-color", WORD_COLORS[shown % WORD_COLORS.length]);
    box.append(span);
    shown += 1;

    if (!reduce) {
      const live = window.setTimeout(() => span.classList.add("is-live"), 16);
      const settle = window.setTimeout(() => {
        span.classList.remove("is-live");
        span.classList.add("is-settled");
      }, 460);
      paintTimers.push(live, settle);
    }

    pumping = true;
    timer = window.setTimeout(paintNext, reduce ? 0 : 72);
    paintTimers.push(timer);
  }

  function kick() {
    if (!pumping) paintNext();
  }

  return {
    push(text) {
      raw += text;
      kick();
    },
    finish() {
      raw = `${raw.trimEnd()} `;
      kick();
      return new Promise((resolve) => {
        const wait = () => {
          if (shown >= readyWords(raw).length && !pumping) resolve(raw.trim());
          else window.setTimeout(wait, 40);
        };
        wait();
      });
    },
  };
}

async function readReviewStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const reveal = revealReview($("reviewText"));
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const event = eventFromLine(line);
      if (!event) continue;
      if (event.error) throw new Error(event.error);
      if (event.text) reveal.push(event.text);
    }
  }

  return reveal.finish();
}

function eventFromLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const raw = trimmed.slice(5).trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

async function requestReview({ reword = false } = {}) {
  const likes = selectedIds();
  const notes = $("detail").value.trim();

  if (!likes.length && notes.length < 8) {
    setStatus("formStatus", "Pick at least one thing you liked.", true);
    return;
  }

  if (Date.now() < pauseWritesUntil) {
    setStatus("formStatus", "The review writer is busy. Wait a moment, then try again.", true);
    return;
  }

  busy = true;
  clearPaint();
  $("writeReview").disabled = true;
  $("reword").disabled = true;
  showDraftShell();

  try {
    const response = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        likes,
        notes,
        reword,
        previous: reword ? reviewText : "",
      }),
    });

    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Could not write the review. Try again.");
    }

    reviewText = await readReviewStream(response.body);
    if (!reviewText) throw new Error("Could not write the review. Try again.");

    $("draftStatusPill").classList.add("is-ready");
    $("draftStatusText").textContent = "Draft ready";
    $("reviewText").classList.remove("is-waiting");
    $("reviewText").contentEditable = "true";
    $("copyReview").disabled = false;
    $("openGoogle").disabled = false;
    $("back").disabled = false;
    setStatus("reviewStatus", "Change any line that is not what happened. Then copy it.");
  } catch (error) {
    const message = error.message || "Could not write the review. Try again.";
    if (/wait a minute/i.test(message)) pauseWritesUntil = Date.now() + 20000;
    showAsk();
    setStatus("formStatus", message, true);
  } finally {
    busy = false;
    const paused = Date.now() < pauseWritesUntil;
    $("writeReview").disabled = paused;
    $("reword").disabled = false;
    if (paused) {
      window.setTimeout(() => {
        if (!busy) $("writeReview").disabled = false;
      }, pauseWritesUntil - Date.now());
    }
  }
}

function markCopied() {
  $("copyLabel").textContent = "Copied";
  setStatus("reviewStatus", "Copied. Paste it into Google’s review box.");
  window.setTimeout(() => {
    if ($("copyLabel").textContent === "Copied") $("copyLabel").textContent = "Copy review draft";
  }, 1400);
}

function currentReview() {
  return $("reviewText").innerText.replace(/\s+/g, " ").trim();
}

async function copyReview() {
  reviewText = currentReview();
  if (!reviewText || $("reviewText").classList.contains("is-waiting")) return;

  try {
    await navigator.clipboard.writeText(reviewText);
    markCopied();
    return;
  } catch {
    const helper = document.createElement("textarea");
    helper.value = reviewText;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.left = "-9999px";
    document.body.append(helper);
    helper.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    helper.remove();
    if (copied) {
      markCopied();
      return;
    }
    setStatus("reviewStatus", "Copy was blocked. Select the review and copy it yourself.", true);
  }
}

function openGoogle() {
  const popup = window.open(CONFIG.googleReviewUrl, "_blank", "noopener");
  if (!popup) {
    setStatus("reviewStatus", "Google didn’t open. Allow pop-ups, then try again.", true);
  }
}

$("businessName").textContent = CONFIG.businessLine;
renderLikes();

$("reviewForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!busy) requestReview();
});

$("copyReview").addEventListener("click", copyReview);
$("openGoogle").addEventListener("click", openGoogle);
$("reword").addEventListener("click", () => {
  if (!busy) requestReview({ reword: true });
});
$("back").addEventListener("click", () => {
  if (!busy) showAsk();
});

$("reviewText").addEventListener("focus", () => {
  const box = $("reviewText");
  if (!box.querySelector(".draft-word")) return;
  const text = currentReview();
  box.textContent = text;
  reviewText = text;
});

$("reviewText").addEventListener("input", () => {
  reviewText = currentReview();
});
