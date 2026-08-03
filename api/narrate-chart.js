// This file runs on Vercel's servers, NOT in the browser.
// Your API key stays here. The uploaded image passes through this function
// and is sent to Anthropic for analysis — it is never written to a database
// or disk here, and this function keeps no record of it after responding.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { image, mediaType, dateRange, objective, metricsInfo } = req.body;

  if (!image || !mediaType) {
    return res.status(400).json({ error: "Missing image" });
  }

  const allowedTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  if (!allowedTypes.includes(mediaType)) {
    return res.status(400).json({ error: "Unsupported image type" });
  }

  const contextLines = [];
  if (dateRange) contextLines.push(`Date range: ${dateRange}`);
  if (objective) contextLines.push(`Business objective: ${objective}`);
  if (metricsInfo) contextLines.push(`What the metrics represent: ${metricsInfo}`);
  const contextBlock = contextLines.length
    ? `\n\nAdditional context provided by the user:\n${contextLines.join("\n")}`
    : `\n\nNo additional context was provided — base your analysis only on what is visible in the image.`;

  const prompt = `You are a careful, precise marketing/data analyst reviewing a screenshot of a chart or dashboard. You can only see what is in the image — you have no access to the underlying data, historical trends beyond what's shown, or business context beyond what the user tells you.

Analyze the image and respond with ONLY valid JSON, no markdown fences, no preamble, matching exactly this shape:

{
  "what_it_shows": "1-3 sentences describing the chart type, axes/labels, and the metrics visible",
  "key_observations": ["3-5 short, specific factual observations about trends, peaks, dips, or comparisons that are directly visible in the image"],
  "possible_explanations": ["2-4 plausible hypotheses for the patterns observed — clearly speculative, not confirmed causes"],
  "investigate_next": ["2-4 specific follow-up questions or additional data that would be needed to confirm the explanations or act on the trends"]
}

Be precise about what is actually visible vs. what would require more information. Do not invent specific numbers you cannot clearly read from the image.${contextBlock}`;

  try {
    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        temperature: 0.3,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
              { type: "text", text: prompt }
            ]
          }
        ]
      })
    });

    if (!anthropicResponse.ok) {
      const errText = await anthropicResponse.text();
      return res.status(anthropicResponse.status).json({ error: errText });
    }

    const data = await anthropicResponse.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Something went wrong analyzing the chart." });
  }
}
