// This file runs on Vercel's servers, NOT in the browser.
// Your API key stays here, safely — it's never sent to the visitor's browser.
// Vercel automatically turns any file in /api into a live endpoint at /api/<filename>.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Missing prompt" });
  }

  try {
    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY, // set this in Vercel's dashboard, never in code
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!anthropicResponse.ok) {
      const errText = await anthropicResponse.text();
      return res.status(anthropicResponse.status).json({ error: errText });
    }

    const data = await anthropicResponse.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Something went wrong analyzing the copy." });
  }
}
