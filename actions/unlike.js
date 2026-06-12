import { logger } from '../utils/logger.js';
import { randomDelay, SafetyTracker, delay } from '../utils/delay.js';
import chalk from 'chalk';

// Explicit keywords list
const explicitKeywords = [
  'nsfw', '18+', 'onlyfans', 'fansly', 'link in bio', 'link in thread', 'porn', 'sex', 
  'xxx', 'adult', 'erotic', 'nude', 'hentai', 'leaks', 'kink', 'fetish', 'escort', 
  'hookup', 'sensual', 'boobs', 'butt', 'ass', 'babe', 'sexy', 'playboy', 
  'camgirl', 'linkinbio', 'linktree', 'findom', 'cashapp', 'tits', 'dick', 'cock', 
  'pussy', 'vagina', 'chudai', 'chudaai', 'chudayi', 'randi', 'bobs', 'vagene',
  'fans.ly', 'beacons.ai', 'allmylinks', 'campsite.bio', 'clink'
];

/**
 * Checks if text contains explicit keywords using regex word boundaries.
 * @param {string} rawText - Original casing text
 * @returns {boolean}
 */
function hasExplicitKeywords(rawText) {
  // 1. Case-sensitive check for OnlyFans abbreviation (avoids matching lowercase English "of")
  if (/\bOF\b/.test(rawText) || /\bO\.F\b/.test(rawText)) {
    return true;
  }

  const normalized = rawText.toLowerCase();

  // 2. Dynamic regex matching for slang variations like wataa, wataaa, wataaaa, etc.
  if (/\bwataa+\b/.test(normalized)) {
    return true;
  }

  // 3. Scan keywords with word-boundary constraints for alphanumeric terms
  for (const keyword of explicitKeywords) {
    if (/^[a-z0-9]+$/i.test(keyword)) {
      // Use word boundary to avoid matching "class", "assess", "asset", "glass" for "ass"
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(normalized)) {
        return true;
      }
    } else {
      // Non-alphanumeric keywords (e.g. "18+", "fans.ly") checked via standard includes
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
  const normalized = text.toLowerCase();
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
 * Hovers over the author name to reveal the profile card and checks their bio for explicit keywords.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} tweetElement
 * @returns {Promise<boolean>} True if explicit
 */
async function checkBioViaHover(page, tweetElement) {
  try {
    const authorLink = tweetElement.locator('[data-testid="User-Name"] a').first();
    if (!(await authorLink.isVisible())) return false;

    // Hover to trigger the popup card
    await authorLink.hover().catch(() => {});
    
    // Wait for the hover card dialog to appear
    const hoverCard = page.locator('[data-testid="HoverCard"], [data-testid="userHoverCard"]').first();
    await hoverCard.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});

    let isExplicit = false;
    if (await hoverCard.isVisible()) {
      const bioText = await hoverCard.innerText().catch(() => '');
      isExplicit = hasExplicitKeywords(bioText);
    }

    // Move mouse away to clear/close the hover card
    await page.mouse.move(0, 0).catch(() => {});
    await delay(300);

    return isExplicit;
  } catch (err) {
    // Safely move mouse away on failure
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
  let isApiBlocked = false;
  let blockCount = 0;

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

            // EXCEPTION LOGIC: Code 144 (Already unliked) and Code 34 (Tweet deleted) are not API blocks!
            if (errorCode === 144 || errorCode === 34 || errorMsg.toLowerCase().includes('not found')) {
              logger.warn(`Tweet already unliked or deleted on server (Code ${errorCode}). Skipping cool-down...`);
            } else {
              logger.warn(`X Server rejected action: "${errorMsg}" (Code ${errorCode})`);
              isApiBlocked = true;
            }
          }
        }
      }
    } catch (err) {
      // Ignore
    }
  };
  
  page.on('response', responseHandler);

  try {
    while (true) {
      if (isApiBlocked) {
        blockCount++;
        if (blockCount >= 3) {
          logger.error('X is persistently blocking our unliking requests. Stopping run to prevent account restriction.');
          break;
        }
        logger.warn('Cooling down: X API returned a block. Pausing for 90 seconds to stay safe...');
        isApiBlocked = false;
        await delay(90000);
        logger.info('Reloading likes page to refresh state...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await delay(5000);
        continue;
      }

      if (unlikedCount > 0 && unlikedCount % 15 === 0) {
        logger.info('Performing periodic reload to clear optimistic cache and verify state...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await delay(5000);
        if (isApiBlocked) continue;
      }

      const unlikeButtons = await page.locator('[data-testid="unlike"], button[aria-label*="Unlike"], button[aria-label*="unlike"]').all();

      if (unlikeButtons.length === 0) {
        logger.info('No visible liked tweets found. Scrolling to load more...');
        
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
          logger.success('No more liked tweets loaded after multiple scrolls. Stopping.');
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
          let fullTweetText = '';

          if (await tweetElement.isVisible()) {
            const statusLink = tweetElement.locator('a[href*="/status/"]').first();
            if (await statusLink.isVisible()) {
              const href = await statusLink.getAttribute('href').catch(() => '');
              if (href) {
                tweetId = href.split('/status/')[1]?.split('?')[0] || href;
              }
            }
            
            fullTweetText = await tweetElement.innerText().catch(() => '');
            
            const textElement = tweetElement.locator('[data-testid="tweetText"]').first();
            if (await textElement.isVisible()) {
              const text = await textElement.innerText().catch(() => '');
              logSnippet = text.substring(0, 30).replace(/\s+/g, ' ').trim();
            } else {
              logSnippet = 'image/video/media';
            }
          }

          if (processedTweets.has(tweetId) && tweetId !== 'unknown') {
            continue;
          }

          if (!(await btn.isVisible()) || !(await btn.isEnabled())) {
            continue;
          }

          // NSFW Filter Mode Logic
          if (options.explicitOnly) {
            let isExplicit = false;

            // 1. Instantly explicit if sensitive media banner is found
            if (hasSensitiveOverlayText(fullTweetText)) {
              isExplicit = true;
            }

            // 2. Instantly explicit if tweet text contains explicit keywords
            if (!isExplicit && hasExplicitKeywords(fullTweetText)) {
              isExplicit = true;
            }

            // 3. Hover Bio Check: Trigger profile card check if the tweet has media or cards
            if (!isExplicit) {
              const hasPhoto = await tweetElement.locator('[data-testid="tweetPhoto"]').first().isVisible().catch(() => false);
              const hasVideo = await tweetElement.locator('[data-testid="videoPlayer"], [data-testid="playButton"]').first().isVisible().catch(() => false);
              const hasCard = await tweetElement.locator('[data-testid="card.wrapper"]').first().isVisible().catch(() => false);
              
              if (hasPhoto || hasVideo || hasCard) {
                console.log(chalk.cyan(`🔍 Inspecting bio for poster of media: "${logSnippet}..."`));
                isExplicit = await checkBioViaHover(page, tweetElement);
              }
            }

            // If clean, skip it
            if (!isExplicit) {
              if (tweetId !== 'unknown') {
                processedTweets.add(tweetId);
              }
              skippedCount++;
              console.log(chalk.dim(`  - Kept liked (clean): "${logSnippet}..."`));
              continue;
            }
          }

          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await randomDelay(200, 400);

          // Evasion: Hover over the button first
          await btn.hover().catch(() => {});
          await randomDelay(300, 600);

          // Click unlike
          await btn.click();
          unlikedCount++;
          clickedAnyThisPass = true;
          
          if (tweetId !== 'unknown') {
            processedTweets.add(tweetId);
          }

          const actionLabel = options.explicitOnly ? 'NSFW Unlike' : 'Unlike';
          logger.success(`Clicked Unlike on tweet ${unlikedCount}: "${logSnippet}..."`);
          logger.stats(actionLabel, unlikedCount);

          await randomDelay(1500, 3000);
          await safetyTracker.registerAction(logger);

        } catch (err) {
          logger.warn(`Failed to unlike a specific tweet: ${err.message || err}`);
          await randomDelay(1000, 2000);
        }
      }

      if (!clickedAnyThisPass && !isApiBlocked) {
        logger.info('Scrolling down to load more liked tweets...');
        await page.evaluate('window.scrollTo(0, window.scrollY + 800)');
        await delay(2500);
      }
    }
  } finally {
    page.off('response', responseHandler);
  }

  const resultStats = options.explicitOnly 
    ? `Total unliked click attempts: ${unlikedCount} | Keep-liked (clean): ${skippedCount}`
    : `Total unliked click attempts: ${unlikedCount}`;
  logger.success(`Unlike run completed. ${resultStats}`);
}
