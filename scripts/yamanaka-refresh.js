#!/usr/bin/env node
/**
 * yamanaka-refresh.js
 * =====================================================================
 * Runs every Monday and Thursday (via GitHub Actions cron).
 *
 * ARCHIVE LOGIC:
 * 1. Fetches recent articles from NewsAPI
 * 2. Compares against current articles.json to find NEW articles
 * 3. If 3+ new articles found → archive current edition, post new one
 * 4. If fewer than 3 new articles → skip update, site stays unchanged
 * 5. Maintains archive-index.json listing all past editions (last 16)
 * 6. Automatically sends Beehiiv newsletter after each successful refresh
 *
 * Required environment variables:
 *   NEWS_API_KEY      — from newsapi.org
 *   ANTHROPIC_API_KEY — from console.anthropic.com
 *   BEEHIIV_API_KEY   — from app.beehiiv.com/settings/workspace/api
 * =====================================================================
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const NEWS_API_KEY        = process.env.NEWS_API_KEY;
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const BEEHIIV_API_KEY     = process.env.BEEHIIV_API_KEY;
const BEEHIIV_PUB_ID      = 'pub_f8d00ab2-c30a-4c38-983d-6af960ecfbd1';
const OUTPUT_FILE         = path.join(__dirname, '..', 'articles.json');
const ARCHIVE_INDEX_FILE  = path.join(__dirname, '..', 'archive-index.json');
const ARCHIVE_DIR         = path.join(__dirname, '..', 'archive');

const NEW_ARTICLE_THRESHOLD = 3;
const MAX_ARCHIVE_EDITIONS  = 16;

const SEARCH_QUERIES = [
  'Yamanaka factors reprogramming',
  'partial reprogramming longevity',
  'cellular rejuvenation aging reversal',
  'iPSC stem cell therapy aging',
  'epigenetic reprogramming anti-aging',
  'longevity biotech research',
  'epigenetic clock reversal',
  'senolytics senescent cells aging',
  'NAD+ longevity aging research',
  'telomere extension aging',
  'rapamycin longevity research',
  'aging reversal clinical trial',
  'Altos Labs rejuvenation research',
  'Calico aging research',
  'Unity Biotechnology senolytic',
  'stem cell therapy regenerative medicine',
  'gene therapy aging reversal',
  'longevity drug human trial',
  'biological age reversal science',
  'healthspan lifespan extension research',
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

function httpsPatch(hostname, pathStr, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname, path: pathStr, method: 'PATCH',
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

  const candidates = articles.slice(0, 60);
  const articleList = candidates.map((a, i) =>
    `${i + 1}. TITLE: ${a.title}\n   SOURCE: ${a.source}\n   URL: ${a.url}\n   DESC: ${(a.description || '').slice(0, 120)}`
  ).join('\n\n');

  const prompt = `You are the editor of YamanakaFactors.com, a Drudge Report-style news aggregator covering Yamanaka factors, cellular reprogramming, partial reprogramming, longevity science, senolytics, epigenetic clocks, stem cell therapy, NAD+ research, telomere science, and related longevity biotech.

Here are ${candidates.length} recent articles. Your job:
1. Select the most important and interesting articles (up to 13) for our readers — prioritize Yamanaka/reprogramming stories, then broader longevity science
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
    "source": "Nature"
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
      publishedAt: original.publishedAt,
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

// ── Step 7: Send Beehiiv Newsletter ───────────────────────────────────
async function sendBeehiivNewsletter(articles) {
  if (!BEEHIIV_API_KEY) {
    console.warn('⚠ No BEEHIIV_API_KEY found — skipping newsletter');
    return;
  }

  console.log('\n📧 Sending Beehiiv newsletter...');

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const YF_CORE_KEYS = [
    'yamanaka','reprogramming','reprogram','ipsc','pluripotent',
    'cellular rejuvenation','partial reprogramming','epigenetic clock',
    'altos labs','sinclair','cellular aging reversal','age reversal',
    'rejuvenation biotech','calico','unity biotechnology'
  ];

  const coreArticles = articles.filter(a => {
    const t = (a.title + ' ' + (a.category || '')).toLowerCase();
    return YF_CORE_KEYS.some(k => t.includes(k));
  });
  const longevityArticles = articles.filter(a => {
    const t = (a.title + ' ' + (a.category || '')).toLowerCase();
    return !YF_CORE_KEYS.some(k => t.includes(k));
  });

  const mainArticles = coreArticles.length >= 3 ? coreArticles : articles;
  const topStory = mainArticles[0];
  const restStories = mainArticles.slice(1);

  // Build HTML email body
  let html = `
<div style="max-width:600px;margin:0 auto;font-family:Georgia,serif;background:#f5f0e8;padding:0;">

  <!-- Header -->
  <div style="background:#0a0a0a;padding:32px 24px;text-align:center;border-bottom:4px solid #c0392b;">
    <div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:3px;color:#9a7c2b;text-transform:uppercase;margin-bottom:8px;">The Yamanaka Factors Report</div>
    <div style="font-family:Georgia,serif;font-size:42px;font-weight:900;color:#f5f0e8;letter-spacing:4px;line-height:1;">YAMANAKA<br>FACTORS</div>
    <div style="font-family:'Courier New',monospace;font-size:11px;color:#9a7c2b;letter-spacing:3px;margin-top:10px;text-transform:uppercase;">The Cellular Reprogramming Report</div>
    <div style="font-family:'Courier New',monospace;font-size:10px;color:#666;margin-top:8px;letter-spacing:2px;">${dateStr.toUpperCase()}</div>
  </div>

  <!-- Top Story -->
  <div style="background:#f5f0e8;padding:28px 24px;border-bottom:2px solid #0a0a0a;">
    <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:3px;color:#c0392b;text-transform:uppercase;margin-bottom:10px;">⚡ Top Story</div>
    <a href="${topStory.url}" style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:#0a0a0a;text-decoration:none;line-height:1.3;display:block;">${topStory.title}</a>
    <div style="font-family:'Courier New',monospace;font-size:10px;color:#5a5247;margin-top:8px;">${(topStory.source || '').toUpperCase()}</div>
  </div>

  <!-- Main Stories -->
  <div style="background:#f5f0e8;padding:20px 24px;border-bottom:2px solid #0a0a0a;">
    <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:3px;color:#9a7c2b;text-transform:uppercase;margin-bottom:16px;">🔬 Latest in Cellular Reprogramming</div>
    ${restStories.map(a => `
    <div style="padding:10px 0;border-bottom:1px dotted #ccc5b5;">
      <a href="${a.url}" style="font-family:Georgia,serif;font-size:16px;color:#0a0a0a;text-decoration:none;line-height:1.4;">${a.title}</a>
      <div style="font-family:'Courier New',monospace;font-size:10px;color:#5a5247;margin-top:3px;">${(a.source || '').toUpperCase()}</div>
    </div>`).join('')}
  </div>

  ${longevityArticles.length > 0 ? `
  <!-- Longevity Science -->
  <div style="background:#f5f0e8;padding:20px 24px;border-bottom:2px solid #0a0a0a;">
    <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:3px;color:#9a7c2b;text-transform:uppercase;margin-bottom:8px;">🧬 Also in Longevity Science</div>
    <div style="font-family:Georgia,serif;font-style:italic;font-size:12px;color:#5a5247;margin-bottom:14px;">Senolytics · Epigenetic Clocks · NAD+ · Telomeres · Stem Cells · Biotech</div>
    ${longevityArticles.slice(0, 6).map(a => `
    <div style="padding:8px 0;border-bottom:1px dotted #ccc5b5;">
      <a href="${a.url}" style="font-family:Georgia,serif;font-size:15px;color:#0a0a0a;text-decoration:none;line-height:1.4;">${a.title}</a>
      <div style="font-family:'Courier New',monospace;font-size:10px;color:#5a5247;margin-top:3px;">${(a.source || '').toUpperCase()}</div>
    </div>`).join('')}
  </div>` : ''}

  <!-- Footer -->
  <div style="background:#0a0a0a;padding:20px 24px;text-align:center;">
    <a href="https://yamanakafactors.com" style="font-family:'Courier New',monospace;font-size:12px;color:#9a7c2b;text-decoration:none;letter-spacing:2px;">YAMANAKAFACTORS.COM</a>
    <div style="font-family:'Courier New',monospace;font-size:10px;color:#444;margin-top:6px;letter-spacing:1px;">AI-CURATED · REFRESHED EVERY MON & THU · FREE</div>
  </div>

</div>`;

  const subject = `The Yamanaka Factors Report — ${dateStr}`;

  try {
    // Create draft post
    const createResponse = await httpsPost(
      'api.beehiiv.com',
      `/v2/publications/${BEEHIIV_PUB_ID}/posts`,
      { 'Authorization': `Bearer ${BEEHIIV_API_KEY}` },
      {
        subject:        subject,
        content:        { free: { web: html, email: html } },
        status:         'draft',
        audience:       'free',
        content_tags:   ['yamanaka', 'longevity', 'anti-aging'],
      }
    );

    if (createResponse.errors || !createResponse.data?.id) {
      console.warn('⚠ Beehiiv post creation failed:', JSON.stringify(createResponse));
      return;
    }

    const postId = createResponse.data.id;
    console.log(`  ✅ Draft created — post ID: ${postId}`);

    // Small delay before sending
    await sleep(2000);

    // Send the post
    const sendResponse = await httpsPost(
      'api.beehiiv.com',
      `/v2/publications/${BEEHIIV_PUB_ID}/posts/${postId}/send`,
      { 'Authorization': `Bearer ${BEEHIIV_API_KEY}` },
      { send_at: 'now' }
    );

    if (sendResponse.errors) {
      console.warn('⚠ Beehiiv send failed:', JSON.stringify(sendResponse));
      return;
    }

    console.log(`  📧 Newsletter sent successfully!`);

  } catch (err) {
    console.warn('⚠ Beehiiv newsletter error (non-fatal):', err.message);
  }
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

  await sendBeehiivNewsletter(ranked);

  console.log('');
  console.log('🎉 Refresh complete!');
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
