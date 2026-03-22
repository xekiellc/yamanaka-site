#!/usr/bin/env node
/**
 * yamanaka-refresh.js
 * =====================================================================
 * Runs every Monday and Thursday (via GitHub Actions cron).
 *
 * ARCHIVE LOGIC:
 * 1. Fetches recent articles from NewsAPI
 * 2. Compares against current articles.json to find NEW articles
 * 3. If 6+ new articles found → archive current edition, post new one
 * 4. If fewer than 6 new articles → skip update, site stays unchanged
 * 5. Maintains archive-index.json listing all past editions (last 16)
 *
 * Required environment variables:
 *   NEWS_API_KEY      — from newsapi.org
 *   ANTHROPIC_API_KEY — from console.anthropic.com
 * =====================================================================
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const NEWS_API_KEY        = process.env.NEWS_API_KEY;
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const OUTPUT_FILE         = path.join(__dirname, '..', 'articles.json');
const ARCHIVE_INDEX_FILE  = path.join(__dirname, '..', 'archive-index.json');
const ARCHIVE_DIR         = path.join(__dirname, '..', 'archive');

const NEW_ARTICLE_THRESHOLD = 6;   // minimum new articles to trigger a refresh
const MAX_ARCHIVE_EDITIONS  = 16;  // keep last 16 editions (~8 weeks)

const SEARCH_QUERIES = [
  'Yamanaka factors reprogramming',
  'partial reprogramming longevity',
  'cellular rejuvenation aging reversal',
  'iPSC stem cell therapy aging',
  'epigenetic clock reversal',
  'Altos Labs rejuvenation',
  'longevity biotech reprogramming',
];

// ── Helpers ───────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'YamanakaFactors/1.0 (info@yamanakafactors.com)',
        'Accept': 'application/json',
      }
    };
    https.get(url, options, (res) => {
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

function formatDateLabel(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

function todaySlug() {
  const d = new Date();
  return d.toISOString().split('T')[0];
}

// ── Load current articles ─────────────────────────────────────────────
function loadCurrentArticles() {
  try {
    if (fs.existsSync(OUTPUT_FILE)) {
      const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      return data.articles || [];
    }
  } catch (e) {
    console.warn('Could not read current articles.json:', e.message);
  }
  return [];
}

// ── Load archive index ────────────────────────────────────────────────
function loadArchiveIndex() {
  try {
    if (fs.existsSync(ARCHIVE_INDEX_FILE)) {
      return JSON.parse(fs.readFileSync(ARCHIVE_INDEX_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Could not read archive-index.json:', e.message);
  }
  return { editions: [] };
}

// ── Step 1: Fetch articles ────────────────────────────────────────────
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
        console.warn(`  ⚠ No articles for "${query}":`, data.message || '');
      }
    } catch (err) {
      console.warn(`  ⚠ Query "${query}" failed:`, err.message);
    }
    await sleep(300);
  }

  console.log(`  Found ${allArticles.length} unique raw articles`);
  return allArticles;
}

// ── Step 2: Find new articles ─────────────────────────────────────────
function findNewArticles(fetchedArticles, currentArticles) {
  const currentUrls = new Set(currentArticles.map(a => a.url));
  const newOnes = fetchedArticles.filter(a => !currentUrls.has(a.url));
  console.log(`  ${newOnes.length} articles are NEW (not in current edition)`);
  return newOnes;
}

// ── Step 3: AI ranking ────────────────────────────────────────────────
async function rankAndRewriteWithClaude(articles) {
  console.log('🤖 Sending to Claude for ranking and headline writing...');

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

// ── Step 4: Archive current edition ───────────────────────────────────
function archiveCurrentEdition(currentArticles, currentUpdated) {
  if (!currentArticles.length) {
    console.log('  No current articles to archive — skipping archive step');
    return null;
  }

  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  const slug = currentUpdated
    ? new Date(currentUpdated).toISOString().split('T')[0]
    : todaySlug();

  const archiveFile = path.join(ARCHIVE_DIR, `edition-${slug}.json`);

  const editionData = {
    updated:  currentUpdated || new Date().toISOString(),
    slug:     slug,
    label:    formatDateLabel(currentUpdated || new Date().toISOString()),
    articles: currentArticles,
  };

  fs.writeFileSync(archiveFile, JSON.stringify(editionData, null, 2), 'utf8');
  console.log(`  📁 Archived edition to archive/edition-${slug}.json`);
  return editionData;
}

// ── Step 5: Update archive index ──────────────────────────────────────
function updateArchiveIndex(archivedEdition) {
  const index = loadArchiveIndex();

  const alreadyExists = index.editions.some(e => e.slug === archivedEdition.slug);
  if (!alreadyExists) {
    index.editions.unshift({
      slug:    archivedEdition.slug,
      label:   archivedEdition.label,
      updated: archivedEdition.updated,
      count:   archivedEdition.articles.length,
      file:    `archive/edition-${archivedEdition.slug}.json`,
    });
  }

  index.editions = index.editions.slice(0, MAX_ARCHIVE_EDITIONS);

  fs.writeFileSync(ARCHIVE_INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
  console.log(`  📋 Archive index updated — ${index.editions.length} editions on record`);
}

// ── Step 6: Write new articles.json ───────────────────────────────────
function writeOutput(articles) {
  const output = { updated: new Date().toISOString(), articles };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`✅ Wrote ${articles.length} articles to articles.json`);
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log('🔬 YamanakaFactors.com — Article Refresh Starting');
  console.log('   Date:', new Date().toUTCString());
  console.log('   Threshold: at least', NEW_ARTICLE_THRESHOLD, 'new articles required to update');
  console.log('');

  if (!NEWS_API_KEY)      { console.error('❌ Missing NEWS_API_KEY');      process.exit(1); }
  if (!ANTHROPIC_API_KEY) { console.error('❌ Missing ANTHROPIC_API_KEY'); process.exit(1); }

  const currentData     = fs.existsSync(OUTPUT_FILE)
    ? JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'))
    : { updated: null, articles: [] };
  const currentArticles = currentData.articles || [];

  console.log(`   Current edition has ${currentArticles.length} articles`);

  const fetched = await fetchNewsArticles();
  const newArticles = findNewArticles(fetched, currentArticles);

  if (newArticles.length < NEW_ARTICLE_THRESHOLD) {
    console.log('');
    console.log(`⏭  Only ${newArticles.length} new articles found — threshold is ${NEW_ARTICLE_THRESHOLD}.`);
    console.log('   Skipping update. Site remains unchanged.');
    console.log('🎉 Done (no update needed).');
    process.exit(0);
  }

  console.log(`\n✅ ${newArticles.length} new articles found — threshold met! Proceeding with update.\n`);

  const ranked = await rankAndRewriteWithClaude(fetched);

  if (currentArticles.length > 0) {
    const archived = archiveCurrentEdition(currentArticles, currentData.updated);
    if (archived) updateArchiveIndex(archived);
  }

  writeOutput(ranked);

  console.log('');
  console.log('🎉 Refresh complete!');
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
