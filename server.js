/**
 * InstaMapped — Server (Railway-compatible)
 * ─────────────────────────────────────────────────────────
 * Uses bundled Chromium (puppeteer), runs headless on Railway.
 * Requires env var: INSTAGRAM_SESSION_ID  (your sessionid cookie)
 *
 * POST /api/posts  { username, cursor? }
 *   → { posts: [...], nextCursor: string|null }
 *
 * On first call for a username: scrapes all geotagged posts,
 * caches them for 10 min, returns first batch.
 * cursor is the next start index as a string ("12", "24", …).
 * ─────────────────────────────────────────────────────────
 */

const express  = require('express');
const puppeteer = require('puppeteer');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────────
const BATCH_SIZE  = 12;   // posts returned per request
const CACHE_TTL   = 10 * 60 * 1000;  // 10 minutes
const SESSION_ID  = process.env.INSTAGRAM_SESSION_ID || '';

// ── In-memory cache ───────────────────────────────────────
// key: username  value: { posts: [], ts: Date.now() }
const cache    = new Map();
const scraping = new Set();  // usernames currently being scraped

// ── Browser factory ───────────────────────────────────────
async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled'
    ]
  });
}

// ── Geocode via OpenStreetMap Nominatim ───────────────────
const geocodeCache = new Map();

async function geocode(locationName) {
  if (geocodeCache.has(locationName)) return geocodeCache.get(locationName);
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationName)}&format=json&limit=1`;
    const res  = await fetch(url, { headers: { 'User-Agent': 'InstaMapped/1.0' } });
    const data = await res.json();
    if (data?.[0]) {
      const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      geocodeCache.set(locationName, coords);
      return coords;
    }
  } catch (err) {
    console.warn(`⚠️  Geocode failed for "${locationName}":`, err.message);
  }
  return null;
}

// ── Get coords from Instagram's own location page (accurate) ──
// Falls back to Nominatim if Instagram page has no coords.
async function getInstagramCoords(page, locationHref) {
  if (!locationHref) return null;
  if (geocodeCache.has(locationHref)) return geocodeCache.get(locationHref);

  try {
    await page.goto(locationHref, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(600);

    const coords = await page.evaluate(() => {
      const src = document.documentElement.innerHTML;

      // Instagram bakes "lat": and "lng": directly into page JSON
      const latM = src.match(/"lat"\s*:\s*([-\d.]+)/);
      const lngM = src.match(/"lng"\s*:\s*([-\d.]+)/);
      if (latM && lngM) {
        const lat = parseFloat(latM[1]);
        const lng = parseFloat(lngM[1]);
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && (lat !== 0 || lng !== 0)) {
          return { lat, lng };
        }
      }

      // Try JSON-LD structured data
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const d = JSON.parse(s.textContent);
          const geo = d.geo || d?.['@graph']?.[0]?.geo;
          if (geo?.latitude) return { lat: parseFloat(geo.latitude), lng: parseFloat(geo.longitude) };
        } catch {}
      }

      return null;
    });

    if (coords) {
      const label = locationHref.split('/').filter(Boolean).pop();
      console.log(`  📍 IG coords for "${label}": (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`);
      geocodeCache.set(locationHref, coords);
      return coords;
    }
    console.log(`  ↳ No coords on IG location page, falling back to Nominatim`);
  } catch (err) {
    console.warn(`  ↳ IG location page failed: ${err.message}`);
  }
  return null;
}

// ── Scrape a single post page ─────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

async function scrapePost(page, postUrl) {
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(800);

    return await page.evaluate(() => {
      const locEl = Array.from(document.querySelectorAll('a[href*="/explore/locations/"]'))
        .find(el => el.href.match(/\/explore\/locations\/\d+\/$/));

      const location = locEl ? { name: locEl.innerText.trim(), href: locEl.href } : null;

      const capSelectors = [
        'div._a9zs h1', 'h1[dir="auto"]',
        'div[class*="x1lliihq"] span[dir="auto"]', 'article span[dir="auto"]'
      ];
      let caption = '';
      for (const sel of capSelectors) {
        const el = document.querySelector(sel);
        if (el?.innerText?.trim().length > 5) { caption = el.innerText.trim().slice(0, 280); break; }
      }

      const ogImg    = document.querySelector('meta[property="og:image"]');
      const thumbnail = ogImg ? ogImg.content : null;

      let likes = null;
      const descMeta = document.querySelector('meta[name="description"]');
      if (descMeta) {
        const m = descMeta.content.match(/([\d,]+)\s+likes?/i);
        if (m) likes = parseInt(m[1].replace(/,/g, ''));
      }

      const timeEl   = document.querySelector('time[datetime]');
      const timestamp = timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString();

      return { location, caption, thumbnail, likes, timestamp };
    });
  } catch (err) {
    console.warn(`  ↳ Failed ${postUrl}: ${err.message}`);
    return null;
  }
}

// ── Full scrape for a username → array of geotagged posts ─
async function scrapeUser(username) {
  if (!SESSION_ID) throw Object.assign(new Error('No Instagram session configured.'), { status: 401 });

  const browser = await launchBrowser();
  const page    = await browser.newPage();

  try {
    // Inject session cookie so we're "logged in"
    await page.setCookie({
      name:   'sessionid',
      value:  SESSION_ID,
      domain: '.instagram.com',
      path:   '/',
      secure: true,
      httpOnly: true
    });

    // Block images/media to speed things up
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await delay(2000);

    // URL-based login check — most reliable: invalid sessions redirect to /accounts/login/
    const landedUrl = page.url();
    console.log(`  Landed URL: ${landedUrl}`);
    if (landedUrl.includes('/accounts/login') || landedUrl.includes('/accounts/emailsignup')) {
      throw Object.assign(new Error('Instagram session expired or invalid.'), { status: 401 });
    }

    // Also check DOM as fallback
    const hasLoginForm = await page.evaluate(() =>
      !!document.querySelector('input[name="username"]') ||
      document.title.toLowerCase().includes('log in')
    );
    if (hasLoginForm) throw Object.assign(new Error('Instagram session expired or invalid.'), { status: 401 });

    // Profile not found?
    const notFound = await page.evaluate(() =>
      document.title.toLowerCase().includes('page not found') ||
      document.title.toLowerCase().includes("sorry, this page") ||
      !!document.querySelector('h2[class*="x1xmf6yo"]')
    );
    if (notFound) throw Object.assign(new Error(`@${username} not found or is private.`), { status: 404 });

    // Scroll to load up to ~48 posts
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 2500));
      await delay(1200);
    }

    const postUrls = await page.evaluate(() =>
      [...new Set(
        Array.from(document.querySelectorAll('a[href*="/p/"]'))
          .map(a => a.href)
          .filter(h => h.includes('/p/'))
      )].slice(0, 48)
    );

    console.log(`  Found ${postUrls.length} post URLs for @${username}`);

    const posts = [];
    for (let i = 0; i < postUrls.length; i++) {
      const url  = postUrls[i];
      const data = await scrapePost(page, url);
      if (!data?.location) continue;

      // Instagram location pages have exact GPS — much more accurate than Nominatim
      const coords = await getInstagramCoords(page, data.location.href)
                  || await geocode(data.location.name);
      if (!coords) continue;

      posts.push({
        id:       url.split('/p/')[1]?.replace('/', '') || String(i),
        postUrl:  url,
        username,
        location: { name: data.location.name, lat: coords.lat, lng: coords.lng },
        caption:  data.caption || '',
        thumbnail: data.thumbnail,
        likes:    data.likes,
        timestamp: data.timestamp
      });

      await delay(300);
    }

    console.log(`  ✅ @${username}: ${posts.length} geotagged posts`);
    return posts;

  } finally {
    await browser.close();
  }
}

// ── POST /api/posts ───────────────────────────────────────
app.post('/api/posts', async (req, res) => {
  const { username: raw, cursor } = req.body || {};
  const username = (raw || '').replace(/^@/, '').trim();
  if (!username) return res.status(400).json({ error: 'username is required' });

  // Reject if another scrape is in-flight for the same user
  if (!cursor && scraping.has(username)) {
    return res.status(429).json({ error: 'Already scraping this user, please wait.' });
  }

  try {
    // Return from cache if fresh
    const cached = cache.get(username);
    const now    = Date.now();

    let allPosts;
    if (cached && (now - cached.ts) < CACHE_TTL) {
      allPosts = cached.posts;
    } else {
      // Need a fresh scrape
      scraping.add(username);
      try {
        allPosts = await scrapeUser(username);
        cache.set(username, { posts: allPosts, ts: now });
      } finally {
        scraping.delete(username);
      }
    }

    // Paginate
    const start      = cursor ? parseInt(cursor, 10) : 0;
    const batch      = allPosts.slice(start, start + BATCH_SIZE);
    const nextStart  = start + BATCH_SIZE;
    const nextCursor = nextStart < allPosts.length ? String(nextStart) : null;

    return res.json({ posts: batch, nextCursor });

  } catch (err) {
    const status = err.status || 500;
    console.error(`❌ /api/posts error (${status}):`, err.message);
    return res.status(status).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({
  status: 'ok',
  session: SESSION_ID ? 'configured' : 'missing'
}));

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🗺️  InstaMapped running on port ${PORT}`);
  if (!SESSION_ID) {
    console.warn('⚠️  INSTAGRAM_SESSION_ID not set — API calls will return 401');
  }
});
