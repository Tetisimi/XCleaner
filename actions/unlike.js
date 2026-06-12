import { logger } from '../utils/logger.js';
import { randomDelay, SafetyTracker, delay } from '../utils/delay.js';
import chalk from 'chalk';

// ─────────────────────────────────────────────────────────────────────────────
// SENSITIVITY CACHES (module-level so they persist across calls)
// ─────────────────────────────────────────────────────────────────────────────

/** tweetId → boolean — X's own `possibly_sensitive` flag per tweet */
const tweetSensitiveCache = new Map();

/** authorHref (lowercase) → boolean — X's own user-level sensitivity */
const userSensitiveCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// DETECTION LAYER 1 — Intercept X's Likes timeline GraphQL response
//
// When X loads the liked-tweets page, it fires a GraphQL query whose response
// contains EVERY tweet's author user data AND the tweet's `possibly_sensitive`
// flag. This is X's own content moderation verdict — no keyword guessing needed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively walks the GraphQL JSON to extract tweet and user sensitivity.
 * Stores results in the two module-level caches above.
 */
function extractSensitivityFromGraphQL(obj, depth = 0) {
  if (depth > 25 || !obj || typeof obj !== 'object') return;

  // Tweet result — has rest_id + legacy.full_text
  if (obj.rest_id && obj.legacy && typeof obj.legacy.full_text === 'string') {
    const tweetId = String(obj.rest_id);
    // `possibly_sensitive` on the tweet = X believes this tweet's media is adult/explicit
    const isSensitive = obj.legacy.possibly_sensitive === true;
    if (!tweetSensitiveCache.has(tweetId)) {
      tweetSensitiveCache.set(tweetId, isSensitive);
    }

    // While we're here — extract the author's user data from core.user_results
    const userResult = obj.core?.user_results?.result;
    if (userResult?.legacy?.screen_name) {
      flagUserFromResult(userResult);
    }
  }

  // Standalone user result (e.g., from UserByScreenName hover card responses)
  if (obj.legacy?.screen_name && !obj.rest_id) {
    flagUserFromResult(obj);
  }

  // Recurse into arrays and objects
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const item of val) extractSensitivityFromGraphQL(item, depth + 1);
    } else if (val && typeof val === 'object') {
      extractSensitivityFromGraphQL(val, depth + 1);
    }
  }
}

function flagUserFromResult(userResult) {
  const legacy = userResult?.legacy;
  if (!legacy?.screen_name) return;

  const authorHref = `/${legacy.screen_name}`.toLowerCase();
  if (userSensitiveCache.has(authorHref)) return; // Already cached

  const isSensitive =
    userResult.profile_interstitial_type === 'sensitive' ||
    userResult.profile_interstitial_type === 'adult' ||
    legacy.possibly_sensitive_editable === true ||
    legacy.sensitive_media_settings?.adult_content_setting === true;

  userSensitiveCache.set(authorHref, isSensitive);
  if (isSensitive) {
    logger.info(chalk.red(`  [GraphQL] X flagged @${legacy.screen_name} as sensitive (profile_interstitial: "${userResult.profile_interstitial_type || 'n/a'}")`));
  }
}

/**
 * Attaches a persistent response interceptor.
 * Catches ALL GraphQL responses: likes timeline, hover card UserByScreenName,
 * and any other X API calls that contain tweet/user data.
 */
function attachSensitivityInterceptor(page) {
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!url.includes('/graphql/')) return;

      // We're interested in: Likes, FavoritedBy, UserByScreenName, and
      // any timeline query that contains tweet data
      const isRelevant =
        url.includes('Likes') ||
        url.includes('Favorites') ||
        url.includes('FavoritedBy') ||
        url.includes('UserByScreenName') ||
        url.includes('UserResultByScreenName') ||
        url.includes('Timeline');

      if (!isRelevant) return;

      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;

      const json = await response.json().catch(() => null);
      if (!json) return;

      extractSensitivityFromGraphQL(json);
    } catch {}
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTION LAYER 2 — Explicit keywords, emojis, adult platform domains
// ─────────────────────────────────────────────────────────────────────────────

const explicitKeywords = [
  'nsfw', '18+', 'onlyfans', 'fansly', 'porn', 'xxx', 'erotic', 'nude', 'hentai',
  'kink', 'fetish', 'escort', 'hookup', 'sensual', 'boobs', 'playboy', 'camgirl',
  'findom', 'tits', 'dick', 'cock', 'pussy', 'vagina', 'chudai', 'chudaai',
  'randi', 'bobs', 'vagene', 'fans.ly', 'beacons.ai', 'allmylinks', 'campsite.bio',
  'ppv', 'naughty', 'of account', 'free of', 'paid of', 'exclusive of', 'sub to my',
  'link in thread', 'sexy', 'thirsty', 'butt', 'ass', 'slutt', 'slut',
];

// Adult platform & vanity domain patterns
const adultDomainPatterns = [
  /onlyfans\.com/i, /fansly\.com/i, /fans\.ly/i, /manyvids\.com/i,
  /admireme\.vip/i, /loyalfans\.com/i, /fanvue\.com/i, /unfiltrd\.me/i,
  /frisk\.chat/i, /unlockd\.me/i, /4based\.com/i, /ifans\.com/i,
  /\.vip\b/i,           // .vip TLD — very common for adult creator vanity domains
];

// Sexual emojis in bio context
const explicitEmojiRe = /🔞|🍆|🍑|💦|🌮|🫦/;

function hasExplicitKeywords(rawText) {
  if (!rawText) return false;
  if (/\bOF\b/.test(rawText) || /\bO\.F\b/.test(rawText)) return true;
  const n = rawText.toLowerCase();
  if (/\bwataa+\b/.test(n)) return true;
  if (explicitEmojiRe.test(rawText)) return true;
  for (const pattern of adultDomainPatterns) {
    if (pattern.test(rawText)) return true;
  }
  for (const kw of explicitKeywords) {
    if (/^[a-z0-9]+$/i.test(kw)) {
      if (new RegExp(`\\b${kw}\\b`, 'i').test(n)) return true;
    } else {
      if (n.includes(kw)) return true;
    }
  }
  return false;
}

function hasSensitiveOverlayText(text) {
  const n = (text || '').toLowerCase();
  return n.includes('sensitive content') || n.includes('potentially sensitive') ||
    n.includes('adult content') || n.includes('sensitive media') ||
    n.includes('show media') || n.includes('view media');
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTION LAYER 3 — Hover card bio check (fallback)
// ─────────────────────────────────────────────────────────────────────────────

async function checkAuthorBioViaHover(page, authorHref) {
  try {
    const authorEl = page.locator(`[data-testid="User-Name"] a[href="${authorHref}"]`).first();
    if (!(await authorEl.isVisible())) return false;

    await authorEl.scrollIntoViewIfNeeded().catch(() => {});
    await authorEl.hover().catch(() => {});

    let bioText = '';
    try {
      await page.waitForSelector(
        '[data-testid="HoverCard"], [data-testid="userHoverCard"]',
        { state: 'visible', timeout: 2000 }
      );
      const hoverCard = page.locator('[data-testid="HoverCard"], [data-testid="userHoverCard"]').first();
      await delay(300); // Let all text + links render
      bioText = await hoverCard.innerText().catch(() => '');
    } catch {
      // Card didn't appear — that's OK
    }

    await page.mouse.move(0, 0).catch(() => {});

    // After hovering, the GraphQL interceptor may have fired a UserByScreenName
    // request and updated userSensitiveCache. Check it first.
    const normalizedHref = authorHref.toLowerCase();
    if (userSensitiveCache.get(normalizedHref) === true) {
      logger.info(chalk.red(`  [Hover→GraphQL] @${authorHref.replace('/', '')} flagged by X's API`));
      return true;
    }

    if (!bioText) return false;

    // Debug: log what the hover card actually says (first 100 chars)
    const preview = bioText.substring(0, 100).replace(/\n/g, ' ');
    console.log(chalk.dim(`     bio: "${preview}"`));

    const result = hasExplicitKeywords(bioText) || hasSensitiveOverlayText(bioText);
    if (result) logger.info(chalk.magenta(`  → NSFW bio: "${preview}"`));
    return result;
  } catch {
    await page.mouse.move(0, 0).catch(() => {});
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM BATCH EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

async function extractTweetsFromPage(page) {
  return page.evaluate(() => {
    const results = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      let tweetId = null;
      const statusLink = article.querySelector('a[href*="/status/"]');
      if (statusLink) {
        const href = statusLink.getAttribute('href') || '';
        tweetId = href.split('/status/')[1]?.split('?')[0] || null;
      }

      let authorHref = null;
      const userNameSection = article.querySelector('[data-testid="User-Name"]');
      if (userNameSection) {
        const a = userNameSection.querySelector('a[href]');
        if (a) authorHref = a.getAttribute('href');
      }

      let tweetText = '';
      const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
      if (tweetTextEl) tweetText = tweetTextEl.innerText || '';

      const hasUnlikeBtn = !!(
        article.querySelector('[data-testid="unlike"]') ||
        article.querySelector('button[aria-label*="Unlike"]') ||
        article.querySelector('button[aria-label*="Liked"]')
      );

      const fullText = article.innerText || '';
      const socialCtx = article.querySelector('[data-testid="socialContext"]');
      const isRetweet = socialCtx ? /reposted/i.test(socialCtx.innerText) : false;
      const fallbackId = authorHref
        ? `fb:${authorHref}:${fullText.substring(0, 40)}`
        : null;

      results.push({ tweetId, fallbackId, authorHref, tweetText, fullText, hasUnlikeBtn, isRetweet });
    }
    return results;
  });
}

async function clickUnlikeForTweet(page, tweetId) {
  const tweetArticle = page.locator(
    `article[data-testid="tweet"]:has(a[href*="/status/${tweetId}"])`
  ).first();
  const btn = tweetArticle.locator(
    '[data-testid="unlike"], button[aria-label*="Unlike"], button[aria-label*="Liked"]'
  ).first();
  if (!(await btn.isVisible())) return false;
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await randomDelay(200, 400);
  await btn.hover().catch(() => {});
  await randomDelay(250, 500);
  await btn.click();
  return true;
}

// Safe wrapper for page.evaluate calls that might fail if page is closed
async function safeEval(page, fn, fallback) {
  try {
    return await page.evaluate(fn);
  } catch {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

export async function unlikeTweets(page, username, safetyTracker, options = { explicitOnly: false }) {
  const modeName = options.explicitOnly ? 'NSFW/Explicit Filter Mode' : 'ALL Likes Mode';
  logger.header(`Starting Unlike Automation (${modeName})`);

  // Attach the persistent GraphQL interceptor
  attachSensitivityInterceptor(page);

  const targetUrl = `https://x.com/${username}/likes`;
  logger.info(`Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await delay(4000); // Give X time to fire the Likes timeline GraphQL

  let unlikedCount = 0;
  let skippedCount = 0;
  let serverConfirmedCount = 0;
  let consecutiveEmptyScrolls = 0;
  const maxEmptyScrolls = 4;

  const processedIds = new Set();
  const checkedAuthors = new Map(); // Final per-author decision cache

  let isApiBlocked = false;
  let blockCount = 0;
  let pageIsAlive = true;

  // ── UNFAVORITE RESPONSE TRACKER ───────────────────────────────────────────
  const unFavHandler = async (response) => {
    try {
      const url = response.url();
      if (!url.includes('UnfavoriteTweet') && !url.includes('unfavorite')) return;
      const status = response.status();
      if (status === 403 || status === 429) { isApiBlocked = true; return; }
      const ct = response.headers()['content-type'] || '';
      if (status === 200 && ct.includes('application/json')) {
        const json = await response.json().catch(() => null);
        if (json?.errors?.length > 0) {
          const code = parseInt(json.errors[0]?.code, 10) || 0;
          const msg = json.errors[0]?.message || '';
          if (code === 144 || code === 34 || msg.toLowerCase().includes('not found')) {
            logger.warn(`Server: already unliked (Code ${code}).`);
          } else {
            logger.warn(`X rejected: "${msg}" (Code ${code})`);
            isApiBlocked = true;
          }
        } else if (json?.data?.unfavorite_tweet) {
          serverConfirmedCount++;
          console.log(chalk.green(`  [Network] Server confirmed ✓ (total: ${serverConfirmedCount})`));
        }
      }
    } catch {}
  };

  page.on('response', unFavHandler);
  page.on('close', () => { pageIsAlive = false; });
  page.on('crash', () => { pageIsAlive = false; });

  try {
    while (pageIsAlive) {
      // ── API BLOCK COOLDOWN ─────────────────────────────────────────────────
      if (isApiBlocked) {
        blockCount++;
        if (blockCount >= 3) {
          logger.error('Persistent block from X. Stopping.');
          break;
        }
        logger.warn('X is blocking. Cooling down 90 seconds...');
        isApiBlocked = false;
        await delay(90000);
        if (!pageIsAlive) break;
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await delay(4000);
        continue;
      }

      // ── BATCH EXTRACT ──────────────────────────────────────────────────────
      let tweets;
      try {
        tweets = await extractTweetsFromPage(page);
      } catch {
        logger.warn('Page closed unexpectedly. Stopping.');
        break;
      }

      const likeable = tweets.filter(t => t.hasUnlikeBtn && !t.isRetweet);
      const unprocessed = likeable.filter(t => {
        const id = t.tweetId || t.fallbackId;
        return !id || !processedIds.has(id);
      });

      // ── SCROLL WHEN ALL VISIBLE TWEETS DONE ───────────────────────────────
      if (unprocessed.length === 0) {
        const lastH = await safeEval(page, 'document.body.scrollHeight', 0);
        if (lastH === 0) break; // Page closed

        const viewportH = await safeEval(page, 'window.innerHeight', 800);
        await safeEval(page, `window.scrollBy(0, ${viewportH})`, null);
        await delay(2500);
        const newH = await safeEval(page, 'document.body.scrollHeight', 0);

        if (newH === lastH) {
          consecutiveEmptyScrolls++;
          logger.warn(`End of list? (${consecutiveEmptyScrolls}/${maxEmptyScrolls})`);
          if (consecutiveEmptyScrolls >= maxEmptyScrolls) {
            logger.success('No more liked tweets. Done.');
            break;
          }
        } else {
          consecutiveEmptyScrolls = 0;
        }
        continue;
      }

      consecutiveEmptyScrolls = 0;
      let clickedThisPass = false;

      for (const tweet of unprocessed) {
        if (isApiBlocked || !pageIsAlive) break;

        const id = tweet.tweetId || tweet.fallbackId;
        const { tweetId, authorHref, tweetText, fullText } = tweet;
        const normalizedAuthor = (authorHref || '').toLowerCase();
        const snippet = (tweetText || fullText || '').substring(0, 35).replace(/\s+/g, ' ').trim() || 'media';

        // Mark as seen immediately
        if (id) processedIds.add(id);

        // ── NSFW FILTER ──────────────────────────────────────────────────────
        if (options.explicitOnly) {
          let isExplicit = false;
          let reason = '';

          // ★ LAYER 0: X's own tweet-level sensitivity flag (most reliable)
          if (tweetId && tweetSensitiveCache.get(tweetId) === true) {
            isExplicit = true;
            reason = 'tweet flagged by X';
          }

          // ★ LAYER 1: X's own user-level sensitivity flag
          if (!isExplicit && normalizedAuthor && userSensitiveCache.get(normalizedAuthor) === true) {
            isExplicit = true;
            reason = 'user flagged by X';
          }

          // ★ LAYER 2: Sensitive overlay text on the tweet itself
          if (!isExplicit && hasSensitiveOverlayText(fullText)) {
            isExplicit = true;
            reason = 'sensitive overlay detected';
          }

          // ★ LAYER 3: Tweet text keywords / emojis / domains
          if (!isExplicit && hasExplicitKeywords(tweetText)) {
            isExplicit = true;
            reason = 'keyword/emoji in tweet';
          }

          // ★ LAYER 4: Author already decided (local cache)
          if (!isExplicit && normalizedAuthor && checkedAuthors.has(normalizedAuthor)) {
            isExplicit = checkedAuthors.get(normalizedAuthor);
            if (isExplicit) reason = 'cached NSFW author';
          }

          // ★ LAYER 5: Hover card bio check
          if (!isExplicit && authorHref && !checkedAuthors.has(normalizedAuthor)) {
            process.stdout.write(chalk.cyan(`  🔍 @${authorHref.replace('/', '')}... `));
            isExplicit = await checkAuthorBioViaHover(page, authorHref);
            // Re-check GraphQL cache — hover may have triggered a new request
            if (!isExplicit && userSensitiveCache.get(normalizedAuthor) === true) {
              isExplicit = true;
              reason = 'X API flagged (post-hover)';
            }
            if (isExplicit && !reason) reason = 'bio/hover match';
            checkedAuthors.set(normalizedAuthor, isExplicit);
            process.stdout.write(isExplicit ? chalk.red('NSFW ✗\n') : chalk.dim('Clean ✓\n'));
          }

          if (!isExplicit) {
            skippedCount++;
            continue;
          }

          logger.info(chalk.yellow(`  Reason: ${reason}`));
        }

        // ── CLICK UNLIKE ─────────────────────────────────────────────────────
        if (!tweetId) {
          logger.warn(`No status ID — skipping: "${snippet}"`);
          continue;
        }

        try {
          const clicked = await clickUnlikeForTweet(page, tweetId);
          if (!clicked) {
            logger.warn(`Button not found: "${snippet}"`);
            continue;
          }

          unlikedCount++;
          clickedThisPass = true;
          logger.success(`Unlike ${unlikedCount}: "${snippet}"`);
          logger.stats(options.explicitOnly ? 'NSFW Unlike' : 'Unlike', unlikedCount);

          await delay(900);
          await randomDelay(600, 1400);
          await safetyTracker.registerAction(logger);

          break; // Re-extract after DOM mutation
        } catch (err) {
          if (!pageIsAlive) break;
          logger.warn(`Failed unlike: ${err.message}`);
          await randomDelay(800, 1500);
        }
      }

      if (!clickedThisPass && !isApiBlocked && pageIsAlive) {
        const stillLeft = likeable.filter(t => {
          const id = t.tweetId || t.fallbackId;
          return !id || !processedIds.has(id);
        });
        if (stillLeft.length === 0) {
          const viewportH = await safeEval(page, 'window.innerHeight', 800);
          await safeEval(page, `window.scrollBy(0, ${viewportH})`, null);
          await delay(2200);
        }
      }
    }
  } finally {
    page.off('response', unFavHandler);
  }

  const stats = options.explicitOnly
    ? `NSFW Unliked: ${unlikedCount} | Server confirmed: ${serverConfirmedCount} | Clean (kept): ${skippedCount} | Authors inspected: ${checkedAuthors.size}`
    : `Total unliked: ${unlikedCount} | Server confirmed: ${serverConfirmedCount}`;
  logger.success(`Done. ${stats}`);
}
