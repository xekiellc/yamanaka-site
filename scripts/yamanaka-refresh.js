#!/usr/bin/env node
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const NEWS_API_KEY      = process.env.NEWS_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OUTPUT_FILE       = path.join(__dirname, '..', 'articles.json');

const SEARCH_QUERIES = [
  'Yamanaka factors reprogramming',
  'partial reprogramming longevity',
  'cellular rejuvenation aging reversal',
  'iPSC stem cell therapy aging',
  'epigenetic clock reversal',
  'Altos Labs rejuvenation',
  'longevity biotech reprogramming',
];

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function httpsPost(hostname, pathStr, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname, path: pathStr, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchNewsArticles() {
  console.log('📰 Fetching news articles...');
  const allArticles = [];
  const seen = new Set();

  for (const query of SEARCH_QUERIES) {
    const encoded = encodeURIComponent(query);
    const url = `https://newsapi.org/v2/everything?q=${encoded}&sortBy=publishedAt&language=en&pageSize=10&apiKey=${NEWS_API_KEY}`;
    try {
      const data = await httpsGet(url);
      if (data.articles) {
        for (const a of data.articles) {
          if (!seen.has(a.url) && a.title && a.url && !a.title.includes('[Removed]')) {
            seen.add(a.url);
            allArticles.push({
              title:       a.title,
              url:         a.url,
              source:      a.source?.name || '',
              publishedAt: a.publishedAt,
              description: a.description || '',
            });
          }
        }
      } else {
        console.warn(`  ⚠ No articles for "${query}":`, data.message || JSON.stringify(data).slice(0, 100));
      }
    } catch (err) {
      console.warn(`  ⚠ Query "${query}" failed:`, err.message);
    }
    await sleep(300);
  }

  console.log(`  Found ${allArticles.length} unique articles`);
  return allArticles;
}

async function rankAndRewriteWithClaude(articles) {
  console.log('🤖 Sending to Claude for ranking and headline writing...');

  if (articles.length === 0) {
    throw new Error('No articles to rank — NewsAPI returned 0 results');
  }

  const candidates = articles.slice(0, 40);
  const articleList = candidates.map((a, i) =>
    `${i + 1}. TITLE: ${a.title}\n   SOURCE: ${a.source}\n   URL: ${a.url}\n   DESC: ${(a.description || '').slice(0, 120)}`
  ).join('\n\n');

  const prompt = `You are the editor of YamanakaFactors.com, a Drudge Report-style news aggregator covering Yamanaka factors, cellular reprogramming, partial reprogramming, longevity science, and related biotech.

Here are ${candidates.length} recent articles. Your job:
1. Select the most important and interesting articles (up to 13) for our readers
2. For each selected article, write a punchy, dramatic, Drudge-style headline in ALL CAPS. Max 120 characters.
3. Assign a category: "longevity", "clinical", or "science"
4. Return ONLY a valid JSON array, no other text, no markdown backticks, no explanation.

Format exactly like this:
[
  {
    "rank": 1,
    "originalIndex": 3,
    "title": "YOUR PUNCHY HEADLINE HERE",
    "category": "longevity",
    "url": "https://...",
    "source": "Nature",
    "publishedAt": "2025-03-17T00:00:00Z"
  }
]

Articles to evaluate:
${articleList}`;

  const response = await httpsPost(
    'api.anthropic.com',
    '/v1/messages',
    {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    }
  );

  if (response.error) throw new Error('Claude API error: ' + JSON.stringify(response.error));

  const rawText = response.content?.[0]?.text || '';
  console.log('Claude raw response (first 300 chars):', rawText.slice(0, 300));

  const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  let ranked;
  try {
    ranked = JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse Claude response:', rawText.slice(0, 500));
    throw new Error('Claude returned invalid JSON');
  }

  return ranked.map(item => {
    const original = candidates[(item.originalIndex || 1) - 1] || {};
    return {
      title:       item.title,
      url:         item.url || original.url,
      source:      item.source || original.source,
      publishedAt: item.publishedAt || original.publishedAt,
      category:    item.category || 'science',
    };
  });
}

function writeOutput(articles) {
  const output = { updated: new Date().toISOString(), articles };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`✅ Wrote ${articles.length} articles to articles.json`);
}

async function main() {
  console.log('🔬 YamanakaFactors.com — Article Refresh Starting');
  console.log('   Date:', new Date().toUTCString());
  if (!NEWS_API_KEY)      { console.error('❌ Missing NEWS_API_KEY');      process.exit(1); }
  if (!ANTHROPIC_API_KEY) { console.error('❌ Missing ANTHROPIC_API_KEY'); process.exit(1); }
  const raw    = await fetchNewsArticles();
  const ranked = await rankAndRewriteWithClaude(raw);
  writeOutput(ranked);
  console.log('🎉 Refresh complete!');
}

main().catch(err => { console.error('💥 Fatal error:', err); process.exit(1); });
