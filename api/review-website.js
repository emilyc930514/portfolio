// This function does real work before it ever talks to an AI model:
// 1. Fetches the page HTML server-side
// 2. Parses it with cheerio (a real HTML parser, not string-guessing)
// 3. Runs deterministic rule checks (title length, alt text, etc.) — these
//    produce the score. The score is NOT an AI guess.
// 4. Checks a capped sample of links for broken status
// 5. Only THEN calls the AI, and only to interpret the already-computed
//    findings — it never sees the raw page and can't invent facts.

import * as cheerio from "cheerio";

const LINK_CHECK_LIMIT = 8;
const LINK_CHECK_TIMEOUT_MS = 5000;
const PAGE_FETCH_TIMEOUT_MS = 9000;
const MAX_HTML_BYTES = 3 * 1024 * 1024; // 3MB cap on what we'll read

// ---------- Basic SSRF guard ----------
// Not exhaustive (doesn't defend against DNS rebinding), but blocks the
// obvious cases of pointing this tool at internal/private addresses.
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local")) return true;
  const privatePatterns = [
    /^127\./, /^10\./, /^192\.168\./, /^169\.254\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, /^0\.0\.0\.0$/, /^::1$/
  ];
  return privatePatterns.some(re => re.test(h));
}

function validateUrl(input) {
  let url;
  try { url = new URL(input); } catch { return { ok: false, error: "That doesn't look like a valid URL." }; }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, error: "Only http and https URLs are supported." };
  }
  if (isBlockedHost(url.hostname)) {
    return { ok: false, error: "That host isn't allowed." };
  }
  return { ok: true, url };
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = PAGE_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------- Readability (Flesch-Kincaid Grade Level), computed ourselves ----------
function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g);
  let count = groups ? groups.length : 1;
  if (w.endsWith("e") && count > 1) count -= 1;
  return Math.max(count, 1);
}

function computeReadability(text) {
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  const words = text.split(/\s+/).map(w => w.trim()).filter(Boolean);
  if (sentences.length === 0 || words.length < 30) return null; // not enough text to judge
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const grade = 0.39 * (words.length / sentences.length) + 11.8 * (syllables / words.length) - 15.59;
  return { grade: Math.max(0, Math.round(grade)), wordCount: words.length, sentenceCount: sentences.length };
}

// ---------- Rule checks ----------
function runChecks({ title, metaDescription, canonical, viewport, lang, h1Count, headingSkips, totalImages, missingAltCount, internalLinks, htmlBytes, brokenLinkCount, checkedLinkCount, readability }) {
  const checks = []; // { id, category, severity: 'pass'|'warn'|'fail', message }

  // SEO
  if (!title) checks.push({ id: "title", category: "seo", severity: "fail", message: "No <title> tag found." });
  else if (title.length < 30 || title.length > 60) checks.push({ id: "title", category: "seo", severity: "warn", message: `Title is ${title.length} characters (ideal range is ~30–60).` });
  else checks.push({ id: "title", category: "seo", severity: "pass", message: `Title length is good (${title.length} characters).` });

  if (!metaDescription) checks.push({ id: "meta_desc", category: "seo", severity: "fail", message: "No meta description found." });
  else if (metaDescription.length < 70 || metaDescription.length > 160) checks.push({ id: "meta_desc", category: "seo", severity: "warn", message: `Meta description is ${metaDescription.length} characters (ideal range is ~70–160).` });
  else checks.push({ id: "meta_desc", category: "seo", severity: "pass", message: `Meta description length is good (${metaDescription.length} characters).` });

  if (h1Count === 0) checks.push({ id: "h1", category: "seo", severity: "fail", message: "No H1 heading found on the page." });
  else if (h1Count > 1) checks.push({ id: "h1", category: "seo", severity: "warn", message: `Page has ${h1Count} H1 headings — typically there should be exactly one.` });
  else checks.push({ id: "h1", category: "seo", severity: "pass", message: "Exactly one H1 found." });

  if (!canonical) checks.push({ id: "canonical", category: "seo", severity: "warn", message: "No canonical link tag found." });
  else checks.push({ id: "canonical", category: "seo", severity: "pass", message: "Canonical tag present." });

  if (headingSkips > 0) checks.push({ id: "heading_order", category: "seo", severity: "warn", message: `Heading order skips a level in ${headingSkips} place(s) (e.g. H1 straight to H3).` });
  else checks.push({ id: "heading_order", category: "seo", severity: "pass", message: "Heading levels are in order." });

  if (internalLinks === 0) checks.push({ id: "internal_links", category: "seo", severity: "warn", message: "No internal links found on this page." });
  else checks.push({ id: "internal_links", category: "seo", severity: "pass", message: `${internalLinks} internal link(s) found.` });

  // Accessibility
  if (totalImages > 0 && missingAltCount > 0) {
    checks.push({ id: "alt_text", category: "accessibility", severity: missingAltCount > 5 ? "fail" : "warn", message: `${missingAltCount} of ${totalImages} image(s) are missing alt text.` });
  } else if (totalImages > 0) {
    checks.push({ id: "alt_text", category: "accessibility", severity: "pass", message: `All ${totalImages} image(s) have alt text.` });
  }

  if (!lang) checks.push({ id: "lang", category: "accessibility", severity: "warn", message: "The <html> tag has no lang attribute." });
  else checks.push({ id: "lang", category: "accessibility", severity: "pass", message: `Language attribute set (${lang}).` });

  // Readability
  if (readability) {
    checks.push({
      id: "readability",
      category: "readability",
      severity: readability.grade > 12 ? "warn" : "pass",
      message: readability.grade > 12
        ? `Estimated reading grade level is ${readability.grade} — consider shorter sentences and simpler words.`
        : `Estimated reading grade level is ${readability.grade}.`
    });
  } else {
    checks.push({ id: "readability", category: "readability", severity: "warn", message: "Not enough visible text on the page to estimate readability." });
  }

  // Technical health
  if (!viewport) checks.push({ id: "viewport", category: "technical", severity: "warn", message: "No mobile viewport meta tag found." });
  else checks.push({ id: "viewport", category: "technical", severity: "pass", message: "Mobile viewport meta tag present." });

  const kb = Math.round(htmlBytes / 1024);
  if (kb > 500) checks.push({ id: "page_weight", category: "technical", severity: "warn", message: `HTML document is ${kb}KB — on the heavier side (this measures HTML only, not images/scripts).` });
  else checks.push({ id: "page_weight", category: "technical", severity: "pass", message: `HTML document size is reasonable (${kb}KB).` });

  if (checkedLinkCount > 0) {
    if (brokenLinkCount > 0) checks.push({ id: "broken_links", category: "technical", severity: "fail", message: `${brokenLinkCount} of ${checkedLinkCount} checked link(s) appear broken.` });
    else checks.push({ id: "broken_links", category: "technical", severity: "pass", message: `All ${checkedLinkCount} checked link(s) responded normally.` });
  }

  return checks;
}

function computeScore(checks) {
  let score = 100;
  for (const c of checks) {
    if (c.severity === "fail") score -= 12;
    else if (c.severity === "warn") score -= 5;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

const TICKET_PRIORITY = {
  h1: "high", broken_links: "high",
  meta_desc: "medium", alt_text: "medium", viewport: "medium",
  title: "medium",
  canonical: "low", heading_order: "low", lang: "low", page_weight: "low", readability: "low", internal_links: "low"
};

function buildTickets(checks) {
  const tickets = { high: [], medium: [], low: [] };
  checks.filter(c => c.severity !== "pass").forEach(c => {
    const priority = TICKET_PRIORITY[c.id] || "low";
    tickets[priority].push(c.message);
  });
  return tickets;
}

async function checkLinks(links, baseOrigin) {
  const unique = [...new Set(links)].slice(0, LINK_CHECK_LIMIT);
  const results = await Promise.allSettled(unique.map(async (link) => {
    try {
      let res = await fetchWithTimeout(link, { method: "HEAD", redirect: "follow" }, LINK_CHECK_TIMEOUT_MS);
      if (res.status === 405) { // some servers reject HEAD
        res = await fetchWithTimeout(link, { method: "GET", redirect: "follow" }, LINK_CHECK_TIMEOUT_MS);
      }
      return { link, ok: res.status < 400, status: res.status };
    } catch {
      return { link, ok: false, status: null };
    }
  }));
  const resolved = results.map(r => r.status === "fulfilled" ? r.value : { link: "", ok: false, status: null });
  const broken = resolved.filter(r => !r.ok);
  return { checked: resolved.length, brokenCount: broken.length, broken };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { url: rawUrl, checkLinks: shouldCheckLinks } = req.body;
  if (!rawUrl || typeof rawUrl !== "string") return res.status(400).json({ error: "Missing URL" });

  const validation = validateUrl(rawUrl);
  if (!validation.ok) return res.status(400).json({ error: validation.error });
  const targetUrl = validation.url;

  // ---------- 1. Fetch the page ----------
  let html;
  try {
    const pageRes = await fetchWithTimeout(targetUrl.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PortfolioSiteReviewer/1.0)" },
      redirect: "follow"
    });
    if (!pageRes.ok) return res.status(400).json({ error: `The page responded with status ${pageRes.status}.` });
    const buf = await pageRes.arrayBuffer();
    if (buf.byteLength > MAX_HTML_BYTES) return res.status(400).json({ error: "That page is too large to analyze right now." });
    html = Buffer.from(buf).toString("utf-8");
  } catch (err) {
    return res.status(400).json({ error: "Couldn't fetch that URL — check it's correct and publicly accessible." });
  }

  // ---------- 2. Parse with cheerio ----------
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  const metaDescription = ($('meta[name="description"]').attr("content") || "").trim();
  const canonical = $('link[rel="canonical"]').attr("href") || null;
  const viewport = $('meta[name="viewport"]').attr("content") || null;
  const lang = $("html").attr("lang") || null;

  const h1s = $("h1");
  const h1Count = h1s.length;

  let headingSkips = 0;
  let lastLevel = 0;
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const level = parseInt(el.tagName.substring(1), 10);
    if (lastLevel && level > lastLevel + 1) headingSkips++;
    lastLevel = level;
  });

  const images = $("img");
  const totalImages = images.length;
  let missingAltCount = 0;
  images.each((_, el) => {
    const alt = $(el).attr("alt");
    if (alt === undefined || alt.trim() === "") missingAltCount++;
  });

  const anchors = $("a[href]");
  const allLinks = [];
  let internalLinks = 0, externalLinks = 0;
  anchors.each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    try {
      const resolved = new URL(href, targetUrl.toString());
      if (!["http:", "https:"].includes(resolved.protocol)) return;
      allLinks.push(resolved.toString());
      if (resolved.hostname === targetUrl.hostname) internalLinks++; else externalLinks++;
    } catch { /* skip invalid */ }
  });

  const bodyClone = $("body").clone();
  bodyClone.find("script, style, noscript").remove();
  const bodyText = bodyClone.text().replace(/\s+/g, " ").trim();
  const readability = computeReadability(bodyText);

  // ---------- 3. Broken link sample (optional) ----------
  let linkCheckResult = { checked: 0, brokenCount: 0, broken: [] };
  if (shouldCheckLinks) {
    try {
      linkCheckResult = await checkLinks(allLinks, targetUrl.origin);
    } catch { /* if this fails, just report zero checked */ }
  }

  // ---------- 4. Deterministic rule checks + score ----------
  const checks = runChecks({
    title, metaDescription, canonical, viewport, lang, h1Count, headingSkips,
    totalImages, missingAltCount, internalLinks,
    htmlBytes: Buffer.byteLength(html, "utf-8"),
    brokenLinkCount: linkCheckResult.brokenCount,
    checkedLinkCount: linkCheckResult.checked,
    readability
  });
  const overallScore = computeScore(checks);
  const tickets = buildTickets(checks);

  // ---------- 5. AI interprets the ALREADY-COMPUTED findings ----------
  let aiReview = { narrative: "", suggestions: [] };
  try {
    const findingsSummary = checks.map(c => `[${c.severity.toUpperCase()}] (${c.category}) ${c.message}`).join("\n");
    const prompt = `You are a marketing-savvy web reviewer. Below are the RESULTS of deterministic, already-computed checks on a webpage (not raw HTML — you cannot see the page itself). Do not invent facts beyond what's listed. Write a short, plain-English interpretation for a marketer who isn't technical, and 2-4 prioritized suggested improvements grounded strictly in these findings.

Respond with ONLY valid JSON, no markdown fences, no preamble, in this shape:
{
  "narrative": "3-5 sentences, plain English, interpreting what these findings mean for the page's marketing effectiveness",
  "suggestions": ["specific, prioritized suggestion grounded in the findings above", "..."]
}

Findings:
${findingsSummary}

Page title (for context only): "${title || "(none found)"}"`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 700,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (aiRes.ok) {
      const aiData = await aiRes.json();
      const raw = aiData.content.map(b => b.text || "").join("").trim();
      const clean = raw.replace(/^```json/i, "").replace(/```$/, "").trim();
      aiReview = JSON.parse(clean);
    }
  } catch { /* if AI step fails, report still returns with rule-based data intact */ }

  return res.status(200).json({
    url: targetUrl.toString(),
    overallScore,
    checks,
    tickets,
    linkCheck: { performed: !!shouldCheckLinks, ...linkCheckResult },
    readability,
    aiReview
  });
}
