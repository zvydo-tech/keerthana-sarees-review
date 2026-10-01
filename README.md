# Keerthana Sarees review page

A small review page for Keerthana Sarees. The customer picks what they liked, a free Gemini model writes one plain English review from those facts, and they copy it to Google.

There is no review template. If the Gemini key is missing, the page does not invent a review.

## Free AI setup

1. Create a key at [Google AI Studio](https://aistudio.google.com/apikey).
2. The page calls Gemini 3.5 Flash-Lite first, because it is the faster model on this key. Gemini 2.5 names do not work on new keys.

## Run locally

```bash
node server.js
```

Create a file named `.env` in this folder:

```bash
GEMINI_API_KEY=your-key-here
```

Then run the server and open the address it prints, usually http://127.0.0.1:3000. If that port is taken, it uses the next free port. Do not commit `.env`.

## Deploy on Vercel

1. Push this folder to GitHub.
2. Import the repository in Vercel. Framework preset: Other.
3. Add an environment variable: `GEMINI_API_KEY` = your key.
4. Deploy.

The site is a static page plus one serverless function at `/api/review`. The key stays on the server.

## Change the shop

Edit `config.js`:

```js
export const CONFIG = {
  businessName: "Keerthana Sarees",
  businessLine: "Keerthana Sarees | Wholesale & Retail Ladies Wear | Vijayawada",
  city: "Vijayawada",
  googleReviewUrl: "https://g.page/r/CcgyVL-IbGXdEBE/review",
};
```

`googleReviewUrl` must be your Google Business Profile review link.
