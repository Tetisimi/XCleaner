import { logger } from '../utils/logger.js';
import { randomDelay, SafetyTracker, delay } from '../utils/delay.js';
import chalk from 'chalk';

// Targeted explicit keywords
const explicitKeywords = [
  'nsfw', '18+', 'onlyfans', 'fansly', 'link in bio', 'porn', 'sex', 'xxx', 'adult',
  'erotic', 'nude', 'hentai', 'leaks', 'kink', 'fetish', 'escort', 'hookup', 'sensual',
  'boobs', 'butt', 'ass', 'babe', 'sexy', 'playboy', 'camgirl', 'linkinbio', 'linktree',
  'findom', 'tits', 'dick', 'cock', 'pussy', 'vagina', 'chudai', 'chudaai', 'randi',
  'bobs', 'vagene', 'fans.ly', 'beacons.ai', 'allmylinks', 'campsite.bio', 'subscribe',
  'exclusive content', 'ppv', 'pay per view', 'selling', 'naughty', 'thirsty', 'of account'
];

function hasExplicitKeywords(rawText) {
  if (!rawText) return false;
  if (/\bOF\b/.test(rawText) || /\bO\.F\b/.test(rawText)) return true;
  const n = rawText.toLowerCase();
  if (/\bwataa+\b/.test(n)) return true;
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

/**
 * FAST hover card bio check.
 * Hovers over the author link and waits for the hover card using a dynamic waitForSelector.
 * No fixed sleeps — reacts as soon as the card is ready.
 * @param {import('playwright').Page} page
 * @param {string} authorHref
 * @returns {Promise<boolean>}
 */
async function checkAuthorBioViaHover(page, authorHref) {
  try {
    // Find author link on the current page using the known href
    const authorSelector = `a[href="${authorHref}"][role="link"]`;
    const authorEl = page.locator(authorSelector).first();
    if (!(await authorEl.isVisible())) return false;

    // Scroll to author and hover
    await authorEl.scrollIntoViewIfNeeded().catch(() => {});
    await authorEl.hover().catch(() => {});

    // Dynamically wait for hover card — no fixed sleep
    let bioText = '';
    try {
      await page.waitForSelector(
        '[data-testid="HoverCard"], [data-testid="userHoverCard"]',
        { state: 'visible', timeout: 1800 }
      );
      const hoverCard = page.locator('[data-testid="HoverCard"], [data-testid="userHoverCard"]').first();
      await delay(250); // Minimal wait for bio text to fill in
      bioText = await hoverCard.innerText().catch(() => '');
    } catch {
      // Card never appeared — that's okay, just return false
    }

    // Move mouse away to dismiss
    await page.mouse.move(0, 0).catch(() => {});

    if (!bioText) return false;
    const result = hasExplicitKeywords(bioText) || hasSensitiveOverlayText(bioText);
    if (result) logger.info(chalk.magenta(`  → NSFW bio: "${bioText.substring(0, 60).replace(/\n/g, ' ')}"`));
    return result;
  } catch {
    await page.mouse.move(0, 0).catch(() => {});
    return false;
  }
}

/**
 * Batch-extracts all tweet data from the current page in ONE browser round-trip.
 * Returns an array of tweet info objects.
 * @param {import('playwright').Page} page
 * @returns {Promise<Array>}
 */
async function extractTweetsFromPage(page) {
  return page.evaluate(() => {
    const results = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    for (const article of articles) {
      // Unique tweet ID from status link
      let tweetId = null;
      const statusLink = article.querySelector('a[href*="/status/"]');
      if (statusLink) {
        const href = statusLink.getAttribute('href') || '';
        tweetId = href.split('/status/')[1]?.split('?')[0] || null;
      }

      // Author href (profile URL)
      let authorHref = null;
      const userNameSection = article.querySelector('[data-testid="User-Name"]');
      if (userNameSection) {
        const aTag = userNameSection.querySelector('a[href]');
        if (aTag) authorHref = aTag.getAttribute('href');
      }

      // Tweet text
      let tweetText = '';
      const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
      if (tweetTextEl) tweetText = tweetTextEl.innerText || '';

      // Has like (unlike) button
      const hasUnlikeBtn = !!(
        article.querySelector('[data-testid="unlike"]') ||
        article.querySelector('button[aria-label*="Unlike"]') ||
        article.querySelector('button[aria-label*="Liked"]')
      );

      // Full article text (covers sensitive overlays, etc.)
      const fullText = article.innerText || '';

      // Has media
      const hasMedia = !!(
        article.querySelector('[data-testid="tweetPhoto"]') ||
        article.querySelector('[data-testid="videoPlayer"]') ||
        article.querySelector('[data-testid="playButton"]') ||
        article.querySelector('[data-testid="card.wrapper"]')
      );

      // Social context (is it a retweet?)
      const socialCtx = article.querySelector('[data-testid="socialContext"]');
      const isRetweet = socialCtx ? /reposted/i.test(socialCtx.innerText) : false;

      results.push({ tweetId, authorHref, tweetText, fullText, hasUnlikeBtn, hasMedia, isRetweet });
    }
    return results;
  });
}

/**
 * Clicks the unlike button for a specific tweet article.
 */
async function clickUnlikeForTweet(page, tweetId) {
  // Re-locate the specific tweet by its status ID
  const statusSelector = `a[href*="/status/${tweetId}"]`;
  const tweetArticle = page.locator(`article[data-testid="tweet"]:has(${statusSelector})`).first();

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

/**
 * Main unlike function.
 */
export async function unlikeTweets(page, username, safetyTracker, options = { explicitOnly: false }) {
  const modeName = options.explicitOnly ? 'NSFW/Explicit Filter Mode' : 'ALL Likes Mode';
  logger.header(`Starting Unlike Automation (${modeName})`);

  const targetUrl = `https://x.com/${username}/likes`;
  logger.info(`Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await delay(3500);

  let unlikedCount = 0;
  let skippedCount = 0;
  let noNewLikesScrolls = 0;
  const maxScrollAttempts = 3;
  const processedTweets = new Set();
  const checkedAuthors = new Map(); // Cache: authorHref -> boolean (isExplicit)
  let isApiBlocked = false;
  let blockCount = 0;

  const requestHandler = (request) => {
    try {
      if (request.url().includes('/graphql/')) {
        const pd = request.postData() || '';
        if (pd.includes('UnfavoriteTweet')) {
          console.log(chalk.dim('  [Network] Sending UnfavoriteTweet...'));
        }
      }
    } catch {}
  };

  const responseHandler = async (response) => {
    try {
      const url = response.url();
      if (!url.includes('/graphql/') && !url.includes('UnfavoriteTweet')) return;
      const status = response.status();
      if (status === 403 || status === 429) { isApiBlocked = true; return; }
      const ct = response.headers()['content-type'] || '';
      if (status === 200 && ct.includes('application/json')) {
        const json = await response.json().catch(() => null);
        if (json?.errors?.length > 0) {
          const code = parseInt(json.errors[0]?.code, 10) || 0;
          const msg = json.errors[0]?.message || '';
          if (code === 144 || code === 34 || msg.toLowerCase().includes('not found')) {
            logger.warn(`Already unliked/deleted (Code ${code}).`);
          } else {
            logger.warn(`X rejected: "${msg}" (Code ${code})`);
            isApiBlocked = true;
          }
        } else if (json?.data?.unfavorite_tweet) {
          console.log(chalk.green('  [Network] Server confirmed unlike ✓'));
        }
      }
    } catch {}
  };

  page.on('request', requestHandler);
  page.on('response', responseHandler);

  try {
    while (true) {
      // Handle API block
      if (isApiBlocked) {
        blockCount++;
        if (blockCount >= 3) {
          logger.error('Persistent block from X. Stopping to protect account.');
          break;
        }
        logger.warn('Cooling down 90 seconds...');
        isApiBlocked = false;
        await delay(90000);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await delay(4000);
        continue;
      }

      // Periodic reload to verify real server state
      if (unlikedCount > 0 && unlikedCount % 20 === 0) {
        logger.info('Reloading to verify server sync...');
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await delay(3500);
        if (isApiBlocked) continue;
      }

      // ── BATCH EXTRACT all tweet data in ONE call ──────────────────────
      const tweets = await extractTweetsFromPage(page);
      const likeable = tweets.filter(t => t.hasUnlikeBtn && !t.isRetweet);

      if (likeable.length === 0) {
        const lastH = await page.evaluate('document.body.scrollHeight');
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await delay(2500);
        const newH = await page.evaluate('document.body.scrollHeight');
        if (newH === lastH) {
          noNewLikesScrolls++;
          logger.warn(`No height change: attempt ${noNewLikesScrolls}/${maxScrollAttempts}`);
          if (noNewLikesScrolls >= maxScrollAttempts) {
            logger.success('No more liked tweets found. Done.');
            break;
          }
        } else {
          noNewLikesScrolls = 0;
        }
        continue;
      }

      noNewLikesScrolls = 0;
      let clickedAnyThisPass = false;

      for (const tweet of likeable) {
        if (isApiBlocked) break;
        const { tweetId, authorHref, tweetText, fullText } = tweet;

        // Skip already-processed tweets
        if (tweetId && processedTweets.has(tweetId)) continue;

        // ── NSFW FILTER LOGIC ────────────────────────────────────────────
        if (options.explicitOnly) {
          let isExplicit = false;

          // Fast path 1: Sensitive overlay text
          if (hasSensitiveOverlayText(fullText)) {
            isExplicit = true;
          }

          // Fast path 2: Tweet text has explicit keyword
          if (!isExplicit && hasExplicitKeywords(tweetText)) {
            isExplicit = true;
          }

          // Fast path 3: Author is already cached
          if (!isExplicit && authorHref && checkedAuthors.has(authorHref)) {
            isExplicit = checkedAuthors.get(authorHref);
          }

          // Slow path: hover bio check (only if not cached)
          if (!isExplicit && authorHref && !checkedAuthors.has(authorHref)) {
            process.stdout.write(chalk.cyan(`  🔍 Checking @${authorHref.replace('/', '')}... `));
            isExplicit = await checkAuthorBioViaHover(page, authorHref);
            checkedAuthors.set(authorHref, isExplicit);
            process.stdout.write(isExplicit ? chalk.red('NSFW ✗\n') : chalk.dim('Clean ✓\n'));
          }

          if (!isExplicit) {
            if (tweetId) processedTweets.add(tweetId);
            skippedCount++;
            continue; // Keep liked, move on
          }
        }

        // ── CLICK UNLIKE ─────────────────────────────────────────────────
        const snippet = (tweetText || fullText || '').substring(0, 30).replace(/\s+/g, ' ').trim() || 'media';
        try {
          const clicked = tweetId
            ? await clickUnlikeForTweet(page, tweetId)
            : false;

          if (!clicked) {
            logger.warn(`Could not click unlike for: "${snippet}"`);
            if (tweetId) processedTweets.add(tweetId); // Avoid retrying stuck tweets
            continue;
          }

          unlikedCount++;
          clickedAnyThisPass = true;
          if (tweetId) processedTweets.add(tweetId);

          logger.success(`Unlike ${unlikedCount}: "${snippet}"`);
          logger.stats(options.explicitOnly ? 'NSFW Unlike' : 'Unlike', unlikedCount);

          await randomDelay(1400, 2500);
          await safetyTracker.registerAction(logger);

          // Break and re-extract — DOM shifts after unlike
          break;
        } catch (err) {
          logger.warn(`Failed unlike: ${err.message}`);
          if (tweetId) processedTweets.add(tweetId);
          await randomDelay(800, 1500);
        }
      }

      if (!clickedAnyThisPass && !isApiBlocked) {
        await page.evaluate('window.scrollTo(0, window.scrollY + 800)');
        await delay(2000);
      }
    }
  } finally {
    page.off('request', requestHandler);
    page.off('response', responseHandler);
  }

  const stats = options.explicitOnly
    ? `NSFW Unliked: ${unlikedCount} | Clean (kept): ${skippedCount} | Authors cached: ${checkedAuthors.size}`
    : `Total unliked: ${unlikedCount}`;
  logger.success(`Unlike complete. ${stats}`);
}
