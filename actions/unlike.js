import { logger } from '../utils/logger.js';
import { randomDelay, SafetyTracker, delay } from '../utils/delay.js';
import chalk from 'chalk';

// Targeted explicit keywords
const explicitKeywords = [
  'nsfw', '18+', 'onlyfans', 'fansly', 'link in bio', 'link in thread', 'porn', 'sex', 
  'xxx', 'adult', 'erotic', 'nude', 'hentai', 'leaks', 'kink', 'fetish', 'escort', 
  'hookup', 'sensual', 'boobs', 'butt', 'ass', 'babe', 'sexy', 'playboy', 
  'camgirl', 'linkinbio', 'linktree', 'findom', 'cashapp', 'tits', 'dick', 'cock', 
  'pussy', 'vagina', 'chudai', 'chudaai', 'chudayi', 'randi', 'bobs', 'vagene',
  'fans.ly', 'beacons.ai', 'allmylinks', 'campsite.bio', 'clink', 'of account',
  'subscribe', 'subscription', 'exclusive content', 'ppv', 'pay per view',
  'selling', 'content creator', 'model', 'sugar', 'naughty', 'thirsty'
];

/**
 * Checks if text contains explicit keywords using regex word boundaries.
 * @param {string} rawText
 * @returns {boolean}
 */
function hasExplicitKeywords(rawText) {
  if (!rawText) return false;
  
  // Case-sensitive check for OnlyFans abbreviation
  if (/\bOF\b/.test(rawText) || /\bO\.F\b/.test(rawText)) {
    return true;
  }

  const normalized = rawText.toLowerCase();

  // Dynamic regex for slang variations
  if (/\bwataa+\b/.test(normalized)) {
    return true;
  }

  for (const keyword of explicitKeywords) {
    if (/^[a-z0-9]+$/i.test(keyword)) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(normalized)) {
        return true;
      }
    } else {
      if (normalized.includes(keyword)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks if a tweet has sensitive warning text.
 * @param {string} text
 * @returns {boolean}
 */
function hasSensitiveOverlayText(text) {
  const normalized = (text || '').toLowerCase();
  return (
    normalized.includes('sensitive content') ||
    normalized.includes('potentially sensitive') ||
    normalized.includes('adult content') ||
    normalized.includes('sensitive media') ||
    normalized.includes('show media') ||
    normalized.includes('view media') ||
    normalized.includes('may contain sensitive material')
  );
}

/**
 * Inspects a poster's bio by:
 * 1. Hovering over the username to trigger the hover card
 * 2. Falling back to navigating directly to their profile page if card doesn't appear
 * Returns true if the account seems explicit.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} tweetElement
 * @param {string} likesPageUrl - URL to return to after profile visit
 * @returns {Promise<boolean>}
 */
async function isAccountExplicit(page, tweetElement, likesPageUrl) {
  try {
    const authorLink = tweetElement.locator('[data-testid="User-Name"] a').first();
    if (!(await authorLink.isVisible())) return false;

    // Get the profile URL before hovering (so we can fall back to it)
    const profileHref = await authorLink.getAttribute('href').catch(() => null);

    // ── Step 1: Try hover card ──────────────────────────────────────────
    await authorLink.hover().catch(() => {});
    await delay(900); // Full hover delay for X's card trigger

    const hoverCard = page.locator('[data-testid="HoverCard"], [data-testid="userHoverCard"]').first();
    await hoverCard.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});

    if (await hoverCard.isVisible()) {
      await delay(400); // Let bio text render
      const bioText = await hoverCard.innerText().catch(() => '');
      await page.mouse.move(0, 0).catch(() => {}); // Dismiss hover card
      await delay(200);

      if (bioText) {
        const explicit = hasExplicitKeywords(bioText) || hasSensitiveOverlayText(bioText);
        if (explicit) logger.info(chalk.magenta(`  → NSFW bio detected: "${bioText.substring(0, 60).replace(/\n/g, ' ')}"`));
        return explicit;
      }
    }

    // Dismiss hover card if it didn't appear properly
    await page.mouse.move(0, 0).catch(() => {});
    await delay(200);

    // ── Step 2: Fallback — Navigate to their profile page ───────────────
    if (!profileHref) return false;

    const profileUrl = profileHref.startsWith('http')
      ? profileHref
      : `https://x.com${profileHref}`;

    logger.info(chalk.dim(`  ↗ Hover card failed. Visiting profile: ${profileUrl}`));
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
    await delay(2500);

    // Read bio from their profile page
    const bioLocator = page.locator('[data-testid="UserDescription"], [data-testid="UserProfileHeader_Items"]').first();
    let bioText = '';
    if (await bioLocator.isVisible()) {
      bioText = await bioLocator.innerText().catch(() => '');
    }

    // Also check their profile header for username/display name keywords
    const headerText = await page.locator('[data-testid="UserName"]').innerText().catch(() => '');

    // Return to likes page
    await page.goto(likesPageUrl, { waitUntil: 'domcontentloaded' });
    await delay(3000);

    const combined = `${bioText} ${headerText}`;
    const explicit = hasExplicitKeywords(combined) || hasSensitiveOverlayText(combined);
    if (explicit) logger.info(chalk.magenta(`  → NSFW profile detected: "${combined.substring(0, 80).replace(/\n/g, ' ')}"`));
    return explicit;

  } catch (err) {
    await page.mouse.move(0, 0).catch(() => {});
    return false;
  }
}

/**
 * Bulk-unlikes tweets with optional explicit/NSFW filtering.
 * @param {import('playwright').Page} page
 * @param {string} username
 * @param {SafetyTracker} safetyTracker
 * @param {object} options
 * @param {boolean} options.explicitOnly
 */
export async function unlikeTweets(page, username, safetyTracker, options = { explicitOnly: false }) {
  const modeName = options.explicitOnly ? 'NSFW/Explicit Filter Mode' : 'ALL Likes Mode';
  logger.header(`Starting Unlike Automation (${modeName})`);
  
  const targetUrl = `https://x.com/${username}/likes`;
  logger.info(`Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await delay(4000);

  let unlikedCount = 0;
  let skippedCount = 0;
  let noNewLikesScrolls = 0;
  const maxScrollAttempts = 3;
  
  const processedTweets = new Set();
  const checkedAuthors = new Map(); // Cache author decisions to avoid re-inspecting the same account
  let isApiBlocked = false;
  let blockCount = 0;

  // Outgoing request tracker
  const requestHandler = (request) => {
    try {
      const url = request.url();
      if (url.includes('/graphql/')) {
        const postData = request.postData() || '';
        if (postData.includes('UnfavoriteTweet')) {
          console.log(chalk.dim('  [Network] Sending UnfavoriteTweet request to X servers...'));
        }
      }
    } catch (err) {}
  };

  // Incoming response tracker
  const responseHandler = async (response) => {
    try {
      const url = response.url();
      if (url.includes('/graphql/') || url.includes('/UnfavoriteTweet')) {
        const status = response.status();
        
        if (status === 403 || status === 429) {
          logger.error(`X API block detected: HTTP status ${status}`);
          isApiBlocked = true;
          return;
        }

        const contentType = response.headers()['content-type'] || '';
        if (status === 200 && contentType.includes('application/json')) {
          const json = await response.json().catch(() => null);
          if (json && json.errors && json.errors.length > 0) {
            const errorMsg = json.errors[0]?.message || 'Unknown error';
            const errorCode = parseInt(json.errors[0]?.code, 10) || 0;

            if (errorCode === 144 || errorCode === 34 || errorMsg.toLowerCase().includes('not found')) {
              logger.warn(`Tweet already unliked/deleted (Code ${errorCode}). Skipping.`);
            } else {
              logger.warn(`X rejected action: "${errorMsg}" (Code ${errorCode})`);
              isApiBlocked = true;
            }
          } else if (json?.data?.unfavorite_tweet) {
            console.log(chalk.green('  [Network] Server confirmed unlike successfully.'));
          }
        }
      }
    } catch (err) {}
  };
  
  page.on('request', requestHandler);
  page.on('response', responseHandler);

  try {
    while (true) {
      if (isApiBlocked) {
        blockCount++;
        if (blockCount >= 3) {
          logger.error('X is persistently blocking requests. Stopping to protect account.');
          break;
        }
        logger.warn('Cooling down for 90 seconds...');
        isApiBlocked = false;
        await delay(90000);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await delay(5000);
        continue;
      }

      if (unlikedCount > 0 && unlikedCount % 15 === 0) {
        logger.info('Periodic reload to verify server state...');
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await delay(5000);
        if (isApiBlocked) continue;
      }

      const unlikeButtons = await page.locator('[data-testid="unlike"], button[aria-label*="Unlike"], button[aria-label*="Liked"]').all();

      if (unlikeButtons.length === 0) {
        logger.info('No liked tweets visible. Scrolling...');
        
        const lastHeight = await page.evaluate('document.body.scrollHeight');
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await delay(3000);
        const newHeight = await page.evaluate('document.body.scrollHeight');
        
        if (newHeight === lastHeight) {
          noNewLikesScrolls++;
          logger.warn(`No height change. Scroll attempt ${noNewLikesScrolls}/${maxScrollAttempts}`);
        } else {
          noNewLikesScrolls = 0;
        }

        if (noNewLikesScrolls >= maxScrollAttempts) {
          logger.success('No more liked tweets. Stopping.');
          break;
        }
        continue;
      }

      noNewLikesScrolls = 0;
      let clickedAnyThisPass = false;

      for (const btn of unlikeButtons) {
        try {
          if (isApiBlocked) break;

          const tweetElement = page.locator('article[data-testid="tweet"]').filter({ has: btn }).first();
          let tweetId = 'unknown';
          let logSnippet = 'unknown';
          let authorHref = null;

          if (await tweetElement.isVisible()) {
            // Get unique tweet ID from the status link
            const statusLink = tweetElement.locator('a[href*="/status/"]').first();
            if (await statusLink.isVisible()) {
              const href = await statusLink.getAttribute('href').catch(() => '');
              if (href) tweetId = href.split('/status/')[1]?.split('?')[0] || href;
            }
            
            // Get the author's profile href for caching
            const authorLink = tweetElement.locator('[data-testid="User-Name"] a').first();
            if (await authorLink.isVisible()) {
              authorHref = await authorLink.getAttribute('href').catch(() => null);
            }

            // Try to get display text for logging
            const textElement = tweetElement.locator('[data-testid="tweetText"]').first();
            if (await textElement.isVisible()) {
              const text = await textElement.innerText().catch(() => '');
              logSnippet = text.substring(0, 30).replace(/\s+/g, ' ').trim();
            }
            
            // Also check tweet body for sensitive overlay text
            const fullText = await tweetElement.innerText().catch(() => '');
            if (logSnippet === 'unknown' && fullText) {
              logSnippet = fullText.substring(0, 30).replace(/\s+/g, ' ').trim();
            }
          }

          if (processedTweets.has(tweetId) && tweetId !== 'unknown') continue;
          if (!(await btn.isVisible()) || !(await btn.isEnabled())) continue;

          // ── NSFW FILTER MODE ───────────────────────────────────────────
          if (options.explicitOnly) {
            let isExplicit = false;

            // Quick check: sensitive overlay in the tweet itself
            const tweetBodyText = await tweetElement.innerText().catch(() => '');
            if (hasSensitiveOverlayText(tweetBodyText) || hasExplicitKeywords(tweetBodyText)) {
              isExplicit = true;
            }

            // Author bio check: use cache to avoid re-inspecting same account
            if (!isExplicit && authorHref) {
              if (checkedAuthors.has(authorHref)) {
                isExplicit = checkedAuthors.get(authorHref);
              } else {
                console.log(chalk.cyan(`🔍 Checking account: ${authorHref}`));
                isExplicit = await isAccountExplicit(page, tweetElement, targetUrl);
                checkedAuthors.set(authorHref, isExplicit); // Cache the result
              }
            }

            if (!isExplicit) {
              if (tweetId !== 'unknown') processedTweets.add(tweetId);
              skippedCount++;
              console.log(chalk.dim(`  ✓ Clean (kept liked): "${logSnippet || 'media/image'}"`));
              continue;
            }

            logger.success(`🔞 NSFW tweet found! Unliking: "${logSnippet || 'media/image'}"`);
          }

          // ── CLICK UNLIKE ──────────────────────────────────────────────
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await randomDelay(200, 400);
          await btn.hover().catch(() => {});
          await randomDelay(300, 600);
          await btn.click();

          unlikedCount++;
          clickedAnyThisPass = true;
          if (tweetId !== 'unknown') processedTweets.add(tweetId);

          logger.success(`Clicked Unlike on tweet ${unlikedCount}: "${logSnippet || 'media/image'}"`);
          logger.stats(options.explicitOnly ? 'NSFW Unlike' : 'Unlike', unlikedCount);

          await randomDelay(1500, 3000);
          await safetyTracker.registerAction(logger);

        } catch (err) {
          logger.warn(`Failed to process tweet: ${err.message || err}`);
          await randomDelay(1000, 2000);
        }
      }

      if (!clickedAnyThisPass && !isApiBlocked) {
        logger.info('Scrolling down to load more...');
        await page.evaluate('window.scrollTo(0, window.scrollY + 800)');
        await delay(2500);
      }
    }
  } finally {
    page.off('request', requestHandler);
    page.off('response', responseHandler);
  }

  const resultStats = options.explicitOnly 
    ? `NSFW Unliked: ${unlikedCount} | Clean (kept): ${skippedCount}`
    : `Total unliked: ${unlikedCount}`;
  logger.success(`Unlike run completed. ${resultStats}`);
}
