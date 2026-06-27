import { logger } from '../utils/logger.js';
import { randomDelay, delay } from '../utils/delay.js';
import chalk from 'chalk';

// ─────────────────────────────────────────────────────────────────────────────
// SENSITIVITY CACHES (module-level so they persist across calls)
// ─────────────────────────────────────────────────────────────────────────────

/** tweetId → boolean — X's own `possibly_sensitive` flag per tweet */
const tweetSensitiveCache = new Map();

/** authorHref (lowercase) → boolean — X's own user-level sensitivity */
const userSensitiveCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// DETECTION LAYER 1 — Intercept X's Bookmarks timeline GraphQL response
// ─────────────────────────────────────────────────────────────────────────────

function extractSensitivityFromGraphQL(obj, depth = 0) {
  if (depth > 25 || !obj || typeof obj !== 'object') return;

  if (obj.rest_id && obj.legacy && typeof obj.legacy.full_text === 'string') {
    const tweetId = String(obj.rest_id);
    const isSensitive = obj.legacy.possibly_sensitive === true;
    if (!tweetSensitiveCache.has(tweetId)) {
      tweetSensitiveCache.set(tweetId, isSensitive);
    }

    const userResult = obj.core?.user_results?.result;
    if (userResult?.legacy?.screen_name) {
      flagUserFromResult(userResult);
    }
  }

  if (obj.legacy?.screen_name && !obj.rest_id) {
    flagUserFromResult(obj);
  }

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
  if (userSensitiveCache.has(authorHref)) return;

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

function attachSensitivityInterceptor(page) {
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!url.includes('/graphql/')) return;

      const isRelevant =
        url.includes('Bookmark') ||
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
  'nsfw', '18+', '18 +', '21+', '21 +', '20+', '17+',
  'onlyfans', 'fansly', 'porn', 'xxx', 'erotic', 'nude', 'hentai',
  'kink', 'fetish', 'escort', 'hookup', 'sensual', 'boobs', 'playboy', 'camgirl',
  'findom', 'tits', 'dick', 'cock', 'pussy', 'vagina', 'chudai', 'chudaai',
  'randi', 'bobs', 'vagene', 'fans.ly', 'beacons.ai', 'allmylinks', 'campsite.bio',
  'ppv', 'naughty', 'of account', 'free of', 'paid of', 'exclusive of', 'sub to my',
  'link in thread', 'sexy', 'thirsty', 'butt', 'ass', 'slutt', 'slut',
  'adults only', 'adults-only', 'content removal', 'promos', 'promo page',
  'of link', 'my of', 'check of', 'sub my of', 'of 🔗', 'of👇', 'of below',
  'spicy content', 'explicit content', 'uncensored',
  // Adult fan/clip page self-descriptions
  'solo content', 'content account', 'clips account', 'leak account', 'leaks account',
  'leaked content', 'nude content', 'adult content', 'xxx content',
  'dm for credits', 'dm for credit', 'dm for collab', 'send me your',
];

const adultDomainPatterns = [
  /onlyfans\.com/i, /fansly\.com/i, /fans\.ly/i, /manyvids\.com/i,
  /admireme\.vip/i, /loyalfans\.com/i, /fanvue\.com/i, /unfiltrd\.me/i,
  /frisk\.chat/i, /unlockd\.me/i, /4based\.com/i, /ifans\.com/i,
  /\.vip\b/i,
];

const explicitEmojiRe = /🔞|🍆|🍑|💦|🌮|🫦/;

// Matches age-gate patterns like |21+|, (21+), 21+ etc.
// Requires the number to be preceded by a non-alphanumeric boundary
// and NOT followed by a dot (to avoid "Node 20+" or "Python 3.11+" etc.).
const ageGateRe = /(?<![\w.])(?:1[678]|19|20|21|22|23|24|25)\s*\+(?!\s*\d)/;

function hasExplicitKeywords(rawText) {
  if (!rawText) return false;
  if (/\bOF\b/.test(rawText) || /\bO\.F\b/.test(rawText)) return true;
  const n = rawText.toLowerCase();
  if (/\bwataa+\b/.test(n)) return true;
  if (ageGateRe.test(rawText)) return true;          // catches 18+, 21+, |21+|, etc.
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
      await delay(300);
      bioText = await hoverCard.innerText().catch(() => '');
    } catch {
      // Card didn't appear — that's OK
    }

    await page.mouse.move(0, 0).catch(() => {});

    const normalizedHref = authorHref.toLowerCase();
    if (userSensitiveCache.get(normalizedHref) === true) {
      logger.info(chalk.red(`  [Hover→GraphQL] @${authorHref.replace('/', '')} flagged by X's API`));
      return true;
    }

    if (!bioText) return false;

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
      let authorDisplayName = '';
      const userNameSection = article.querySelector('[data-testid="User-Name"]');
      if (userNameSection) {
        const a = userNameSection.querySelector('a[href]');
        if (a) authorHref = a.getAttribute('href');
        // Display name is the first span/div child text before the handle
        authorDisplayName = userNameSection.innerText || '';
      }

      let tweetText = '';
      const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
      if (tweetTextEl) tweetText = tweetTextEl.innerText || '';

      // Bookmark button: X renders it as data-testid="bookmark" when bookmarked
      // or aria-label containing "Bookmark" / "Remove Bookmark"
      const hasBookmarkBtn = !!(
        article.querySelector('[data-testid="removeBookmark"]') ||
        article.querySelector('[data-testid="bookmark"]') ||
        article.querySelector('button[aria-label*="Remove from Bookmarks"]') ||
        article.querySelector('button[aria-label*="Bookmarked"]')
      );

      const fullText = article.innerText || '';
      const socialCtx = article.querySelector('[data-testid="socialContext"]');
      const isRetweet = socialCtx ? /reposted/i.test(socialCtx.innerText) : false;
      const fallbackId = authorHref
        ? `fb:${authorHref}:${fullText.substring(0, 40)}`
        : null;

      results.push({ tweetId, fallbackId, authorHref, authorDisplayName, tweetText, fullText, hasBookmarkBtn, isRetweet });
    }
    return results;
  });
}

async function clickRemoveBookmarkForTweet(page, tweetId) {
  const tweetArticle = page.locator(
    `article[data-testid="tweet"]:has(a[href*="/status/${tweetId}"])`
  ).first();

  // On the /i/bookmarks page X renders the filled bookmark as data-testid="bookmark"
  // (not "removeBookmark" which only appears in other contexts). Include all variants.
  const btn = tweetArticle.locator(
    '[data-testid="removeBookmark"], [data-testid="bookmark"], button[aria-label*="Remove from Bookmarks"], button[aria-label*="Bookmarked"]'
  ).first();

  if (!(await btn.isVisible())) return 'not_found';
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await randomDelay(200, 400);
  await btn.hover().catch(() => {});
  await randomDelay(250, 500);
  await btn.click();

  // After a real removal the tweet disappears from the bookmarks list.
  // Wait up to 3 s for the article to detach from the DOM.
  try {
    await tweetArticle.waitFor({ state: 'detached', timeout: 3000 });
    return 'confirmed'; // Tweet gone from DOM — server accepted it
  } catch {
    // Article is still visible — click may not have fired the API call
    return 'unconfirmed';
  }
}

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

export async function unbookmarkNsfwTweets(page, safetyTracker) {
  logger.header('Starting Bookmark Remover (NSFW/Explicit Filter Mode)');

  // Attach the persistent GraphQL interceptor
  attachSensitivityInterceptor(page);

  const targetUrl = 'https://x.com/i/bookmarks';
  logger.info(`Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await delay(4000); // Give X time to fire the Bookmarks timeline GraphQL

  let removedCount = 0;
  let skippedCount = 0;
  let serverConfirmedCount = 0;
  let consecutiveEmptyScrolls = 0;
  const maxEmptyScrolls = 4;

  const processedIds = new Set();
  const checkedAuthors = new Map(); // Final per-author decision cache

  let isApiBlocked = false;
  let blockCount = 0;
  let pageIsAlive = true;

  // ── BOOKMARK RESPONSE TRACKER ──────────────────────────────────────────────
  // Only track DELETE mutations — not the timeline load (BookmarkTimeline, etc.)
  const bookmarkHandler = async (response) => {
    try {
      const url = response.url();
      if (!url.includes('DeleteBookmark') && !url.includes('bookmark_tweet_delete')) return;
      const status = response.status();
      if (status === 401 || status === 403 || status === 429) { isApiBlocked = true; return; }
      const ct = response.headers()['content-type'] || '';
      if (status === 200 && ct.includes('application/json')) {
        const json = await response.json().catch(() => null);
        if (json?.errors?.length > 0) {
          const code = parseInt(json.errors[0]?.code, 10) || 0;
          const msg = json.errors[0]?.message || '';
          if (code === 144 || code === 34 || msg.toLowerCase().includes('not found')) {
            logger.warn(`Server: already removed (Code ${code}).`);
          } else {
            logger.warn(`X rejected: "${msg}" (Code ${code})`);
            isApiBlocked = true;
          }
        } else if (json?.data?.bookmark_tweet_delete || json?.data?.delete_bookmark) {
          serverConfirmedCount++;
          console.log(chalk.green(`  [Network] Server confirmed ✓ (total: ${serverConfirmedCount})`));
        }
      }
    } catch {}
  };

  page.on('response', bookmarkHandler);
  page.on('close', () => { pageIsAlive = false; });
  page.on('crash', () => { pageIsAlive = false; });

  try {
    while (pageIsAlive) {
      // ── API BLOCK COOLDOWN ───────────────────────────────────────────────
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

      // ── BATCH EXTRACT ────────────────────────────────────────────────────
      let tweets;
      try {
        tweets = await extractTweetsFromPage(page);
      } catch {
        logger.warn('Page closed unexpectedly. Stopping.');
        break;
      }

      const bookmarked = tweets.filter(t => t.hasBookmarkBtn && !t.isRetweet);
      const unprocessed = bookmarked.filter(t => {
        const id = t.tweetId || t.fallbackId;
        return !id || !processedIds.has(id);
      });

      // ── SCROLL WHEN ALL VISIBLE TWEETS DONE ─────────────────────────────
      if (unprocessed.length === 0) {
        const lastH = await safeEval(page, 'document.body.scrollHeight', 0);
        if (lastH === 0) break;

        const viewportH = await safeEval(page, 'window.innerHeight', 800);
        await safeEval(page, `window.scrollBy(0, ${viewportH})`, null);
        await delay(2500);
        const newH = await safeEval(page, 'document.body.scrollHeight', 0);

        if (newH === lastH) {
          consecutiveEmptyScrolls++;
          logger.warn(`End of list? (${consecutiveEmptyScrolls}/${maxEmptyScrolls})`);
          if (consecutiveEmptyScrolls >= maxEmptyScrolls) {
            logger.success('No more bookmarks. Done.');
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

        // ── NSFW FILTER ────────────────────────────────────────────────────
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

        // ★ LAYER 4: Author already decided (local cache) — check BEFORE expensive scans
        if (!isExplicit && normalizedAuthor && checkedAuthors.has(normalizedAuthor)) {
          isExplicit = checkedAuthors.get(normalizedAuthor);
          if (isExplicit) reason = 'cached NSFW author';
        }

        // ★ LAYER 3a: Tweet body keywords / emojis / domains
        if (!isExplicit && hasExplicitKeywords(tweetText)) {
          isExplicit = true;
          reason = 'keyword/emoji in tweet body';
        }

        // ★ LAYER 3b: Author display name + handle keyword check
        //    Many NSFW pages carry signals in their name ("🔞 Fan Page", "NSFW Models 18+")
        //    or handle ("/nsfwxxx", "/onlyfanspage") rather than tweet text.
        if (!isExplicit) {
          const { authorDisplayName } = tweet;
          const handleText = normalizedAuthor ? normalizedAuthor.replace(/^\//,'') : '';
          if (hasExplicitKeywords(authorDisplayName) || (handleText && hasExplicitKeywords(handleText))) {
            isExplicit = true;
            reason = 'keyword in author name/handle';
          }
        }

        // ★ LAYER 3c: Full article text scan (catches inline links, quoted tweets,
        //    follow-context banners that contain NSFW signals)
        if (!isExplicit && hasExplicitKeywords(fullText)) {
          isExplicit = true;
          reason = 'keyword in article text';
        }

        // ★ LAYER 5: Hover card bio check (last resort — slowest)
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

        // ── CLICK REMOVE BOOKMARK ──────────────────────────────────────────
        if (!tweetId) {
          logger.warn(`No status ID — skipping: "${snippet}"`);
          continue;
        }

        try {
          let result = await clickRemoveBookmarkForTweet(page, tweetId);

          if (result === 'not_found') {
            logger.warn(`Button not found: "${snippet}"`);
            continue;
          }

          if (result === 'unconfirmed') {
            // One retry: wait a bit longer then try again (DOM may have lagged)
            logger.warn(chalk.yellow(`  ↺ Retrying bookmark removal (DOM lag)...`));
            await delay(1500);
            result = await clickRemoveBookmarkForTweet(page, tweetId);
          }

          if (result === 'unconfirmed') {
            logger.warn(chalk.red(`  ⚠ Still unconfirmed after retry — skipping: "${snippet}"`))
            continue;
          }

          if (result === 'not_found') {
            // Article may have already been removed in the retry attempt
            logger.warn(`Article gone after retry — counting as removed: "${snippet}"`);
          }

          // result === 'confirmed' (or 'not_found' after retry = already gone)
          removedCount++;
          clickedThisPass = true;
          logger.success(`Removed bookmark ${removedCount}: "${snippet}"`);
          logger.stats('NSFW Unbookmark', removedCount);

          await delay(900);
          await randomDelay(600, 1400);
          await safetyTracker.registerAction(logger);

          break; // Re-extract after DOM mutation
        } catch (err) {
          if (!pageIsAlive) break;
          logger.warn(`Failed to remove bookmark: ${err.message}`);
          await randomDelay(800, 1500);
        }
      }

      if (!clickedThisPass && !isApiBlocked && pageIsAlive) {
        const stillLeft = bookmarked.filter(t => {
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
    page.off('response', bookmarkHandler);
  }

  const stats = `NSFW Bookmarks Removed: ${removedCount} | Server confirmed: ${serverConfirmedCount} | Clean (kept): ${skippedCount} | Authors inspected: ${checkedAuthors.size}`;
  logger.success(`Done. ${stats}`);
}
