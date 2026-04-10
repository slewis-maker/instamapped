/**
 * InstaMapped — Server
 * ─────────────────────────────────────────────────────
 * Scrapes geotagged posts from any Instagram profile using
 * your local Chrome installation (so you stay logged in).
 * Geocodes location names via OpenStreetMap Nominatim.
 * ─────────────────────────────────────────────────────
 */

const express = require('express');
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Chrome path detection ─────────────────────────────
function getChromePath() {
  if (process.platform === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ];
    return paths.find(p => fs.existsSync(p)) || paths[0];
  }
  if (process.platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];
    return paths.find(p => fs.existsSync(p)) || paths[0];
  }
  // Linux
  const paths = ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  return paths.find(p => fs.existsSync(p)) || '/usr/bin/google-chrome';
}

// ── Persistent Chrome profile (so Instagram stays logged in) ──
const PROFILE_DIR = path.join(__dirname, '.chrome-profile');

// ── Browser singleton ─────────────────────────────────
let browser = null;

async function getBrowser() {
  if (browser) {
    try {
      // Check it's still alive
      await browser.pages();
      return browser;
    } catch {
      browser = null;
    }
  }

  console.log('🌐 Launching Chrome...');
  browser = await puppeteer.launch({
    executablePath: getChromePath(),
    userDataDir: PROFILE_DIR,
    headless: false,          // Visible so you can log in if needed
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  browser.on('disconnected', () => { browser = null; });
  return browser;
}

// ── Geocode via OpenStreetMap Nominatim (free, no key) ─
const geocodeCache = new Map();

async function geocode(locationName) {
  if (geocodeCache.has(locationName)) return geocodeCache.get(locationName);

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationName)}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'InstaMapped/1.0 (local tool)' }
    });
    const data = await res.json();
    if (data && data[0]) {
      const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      geocodeCache.set(locationName, coords);
      return coords;
    }
  } catch (err) {
    console.warn(`⚠️  Geocode failed for "${locationName}":`, err.message);
  }
  return null;
}

// ── Helper: delay ─────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Scrape a single post page ─────────────────────────
async function scrapePost(page, postUrl) {
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(1000);

    return await page.evaluate(() => {
      // Location link (has a specific location ID, not the generic /explore/locations/)
      const locEl = Array.from(document.querySelectorAll('a[href*="/explore/locations/"]'))
        .find(el => el.href.match(/\/explore\/locations\/\d+\//));

      const location = locEl
        ? { name: locEl.innerText.trim(), href: locEl.href }
        : null;

      // Caption — try several selectors Instagram uses
      const capSelectors = [
        'div._a9zs h1',
        'h1[dir="auto"]',
        'div[class*="x1lliihq"] span[dir="auto"]',
        'article span[dir="auto"]'
      ];
      let caption = '';
      for (const sel of capSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText && el.innerText.trim().length > 5) {
          caption = el.innerText.trim().slice(0, 280);
          break;
        }
      }

      // Thumbnail from og:image meta tag
      const ogImg = document.querySelector('meta[property="og:image"]');
      const thumbnail = ogImg ? ogImg.content : null;

      // Likes from meta description or page content
      const descMeta = document.querySelector('meta[name="description"]');
      let likes = null;
      if (descMeta) {
        const m = descMeta.content.match(/([\d,]+)\s+likes?/i);
        if (m) likes = parseInt(m[1].replace(/,/g, ''));
      }

      // Date from time element
      const timeEl = document.querySelector('time[datetime]');
      const timestamp = timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString();

      return { location, caption, thumbnail, likes, timestamp };
    });
  } catch (err) {
    console.warn(`  ↳ Failed: ${postUrl} — ${err.message}`);
    return null;
  }
}

// ── Serve static frontend ─────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API: GET /api/posts/:username ─────────────────────
app.get('/api/posts/:username', async (req, res) => {
  const username = req.params.username.replace(/^@/, '').trim();
  if (!username) return res.status(400).json({ error: 'Username required' });

  console.log(`\n📸 Fetching posts for @${username}...`);

  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    // Block images/media to speed up scraping
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Visit profile page
    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await delay(1500);

    // Check for login wall
    const isLoggedIn = await page.evaluate(() => {
      return !document.querySelector('a[href="/accounts/login/"]') &&
             !document.querySelector('input[name="username"]');
    });

    if (!isLoggedIn) {
      await page.close();
      return res.status(401).json({
        error: 'Instagram login required. A Chrome window should have opened — please log in, then try again.'
      });
    }

    // Check profile exists
    const notFound = await page.evaluate(() =>
      document.title.toLowerCase().includes('page not found') ||
      !!document.querySelector('h2[class*="x1xmf6yo"]')
    );
    if (notFound) {
      await page.close();
      return res.status(404).json({ error: `Profile @${username} not found.` });
    }

    // Scroll down to load more posts (3 scrolls ≈ 27–36 posts)
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 2000));
      await delay(1200);
    }

    // Collect unique post URLs belonging to this user
    const postUrls = await page.evaluate((uname) => {
      const links = Array.from(document.querySelectorAll(`a[href*="/p/"]`))
        .map(a => a.href)
        .filter(h => h.includes('/p/'))
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .slice(0, 36);
      return links;
    }, username);

    console.log(`  Found ${postUrls.length} posts — checking for location tags...`);

    // Scrape each post
    const posts = [];
    for (let i = 0; i < postUrls.length; i++) {
      const url = postUrls[i];
      process.stdout.write(`  [${i + 1}/${postUrls.length}] ${url.split('/p/')[1]?.replace('/', '')} `);

      const data = await scrapePost(page, url);
      if (!data || !data.location) {
        process.stdout.write('(no location)\n');
        continue;
      }

      process.stdout.write(`→ ${data.location.name} — geocoding...`);

      const coords = await geocode(data.location.name);
      if (!coords) {
        process.stdout.write(' (geocode failed)\n');
        continue;
      }

      process.stdout.write(` ✓ (${coords.lat.toFixed(3)}, ${coords.lng.toFixed(3)})\n`);

      posts.push({
        id: url.split('/p/')[1]?.replace('/', '') || String(i),
        postUrl: url,
        username,
        location: {
          name: data.location.name,
          lat: coords.lat,
          lng: coords.lng
        },
        caption: data.caption || '',
        thumbnail: data.thumbnail,
        likes: data.likes,
        comments: null,
        timestamp: data.timestamp
      });

      // Small polite delay between requests
      await delay(400);
    }

    await page.close();

    console.log(`  ✅ Done: ${posts.length} geotagged posts found.\n`);
    res.json({ username, posts });

  } catch (err) {
    console.error('❌ Error:', err.message);
    if (page) {
      try { await page.close(); } catch {}
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok' }));

// ── Start ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🗺️  InstaMapped is running!`);
  console.log(`   Open: http://localhost:${PORT}\n`);
});
