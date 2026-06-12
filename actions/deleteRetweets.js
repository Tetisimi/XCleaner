import { logger } from '../utils/logger.js';
import { randomDelay, SafetyTracker, delay } from '../utils/delay.js';

/**
 * Checks if the page is currently rate-limited or blocked.
 * @param {import('playwright').Page} page
 */
async function handleRateLimit(page) {
  const bodyText = await page.innerText('body').catch(() => '');
  if (bodyText.includes('Something went wrong') || bodyText.includes('Rate limit exceeded') || bodyText.includes('Try again later')) {
    logger.warn('Rate limit or connection warning detected. Pausing for 60 seconds...');
    await delay(60000);
    await page.reload().catch(() => {});
    await delay(5000);
    return true;
  }
  return false;
}

/**
 * Bulk-deletes/undo-reposts all retweets.
 * @param {import('playwright').Page} page
 * @param {string} username
 * @param {SafetyTracker} safetyTracker
 */
export async function deleteRetweets(page, username, safetyTracker) {
  logger.header('Starting Undo Reposts (Retweets) Automation');
  const targetUrl = `https://x.com/${username}`;
  logger.info(`Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await delay(4000);

  let undoneCount = 0;
  let scrollAttempts = 0;
  const maxScrollAttempts = 3;

  while (true) {
    await handleRateLimit(page);

    const tweets = await page.locator('article[data-testid="tweet"]').all();

    if (tweets.length === 0) {
      logger.info('No visible tweets found. Scrolling to search for more...');
      
      const lastHeight = await page.evaluate('document.body.scrollHeight');
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await delay(2000);
      
      const newHeight = await page.evaluate('document.body.scrollHeight');
      
      if (newHeight === lastHeight) {
        scrollAttempts++;
        logger.warn(`No height change. Scroll attempt ${scrollAttempts}/${maxScrollAttempts}`);
      } else {
        scrollAttempts = 0;
      }

      if (scrollAttempts >= maxScrollAttempts) {
        logger.success('No more tweets found on profile page. Stopping.');
        break;
      }
      continue;
    }

    scrollAttempts = 0;
    let undoneAnyThisPass = false;

    for (const tweet of tweets) {
      try {
        // Must identify as retweet (it has "You reposted" or "reposted" text in the social context)
        const socialContext = tweet.locator('[data-testid="socialContext"]');
        let isRetweet = false;
        
        if (await socialContext.isVisible()) {
          const contextText = await socialContext.innerText().catch(() => '');
          if (contextText.toLowerCase().includes('reposted') || contextText.toLowerCase().includes('you reposted')) {
            isRetweet = true;
          }
        }

        if (!isRetweet) {
          continue; // Skip if it's an original tweet
        }

        const tweetTextElement = tweet.locator('[data-testid="tweetText"]').first();
        let snippet = 'empty/image/media';
        if (await tweetTextElement.isVisible()) {
          const rawText = await tweetTextElement.innerText().catch(() => '');
          snippet = rawText.replace(/\n/g, ' ').substring(0, 30).trim();
        }

        // Try Method 1: Caret menu ("...") -> "Undo repost"
        let method1Success = false;
        const caretMenu = tweet.locator('[data-testid="caret"], button[aria-label="More"], button[aria-label*="more"]').first();
        
        if (await caretMenu.isVisible()) {
          await caretMenu.scrollIntoViewIfNeeded().catch(() => {});
          await randomDelay(200, 400);
          await caretMenu.click();
          await delay(500);

          const undoRepostItem = page.getByRole('menuitem', { name: /undo repost/i });
          if (await undoRepostItem.isVisible()) {
            await undoRepostItem.click();
            method1Success = true;
            undoneCount++;
            undoneAnyThisPass = true;
            logger.success(`Undid repost (via menu) ${undoneCount}: "${snippet}..."`);
            logger.stats('Undo Repost', undoneCount);
            await randomDelay(600, 900);
            await safetyTracker.registerAction(logger);
          } else {
            // Close menu since "Undo repost" was not there
            await page.keyboard.press('Escape');
            await delay(300);
          }
        }

        // Try Method 2 (Fallback): Find and click the green active repost button directly
        if (!method1Success) {
          const unretweetButton = tweet.locator('[data-testid="unretweet"], button[aria-label*="Reposted"], button[aria-label*="repost"][aria-label*="active"]').first();
          if (await unretweetButton.isVisible()) {
            await unretweetButton.scrollIntoViewIfNeeded().catch(() => {});
            await randomDelay(200, 400);
            await unretweetButton.click();
            await delay(500);

            // Clicking it brings up a menu with "Undo repost" option or "unretweetConfirm"
            const undoRepostConfirm = page.locator('[data-testid="unretweetConfirm"]').first();
            const undoRepostConfirmFallback = page.getByRole('menuitem', { name: /undo repost/i }).first();
            
            if (await undoRepostConfirm.isVisible()) {
              await undoRepostConfirm.click();
              method1Success = true;
            } else if (await undoRepostConfirmFallback.isVisible()) {
              await undoRepostConfirmFallback.click();
              method1Success = true;
            }

            if (method1Success) {
              undoneCount++;
              undoneAnyThisPass = true;
              logger.success(`Undid repost (via retweet button) ${undoneCount}: "${snippet}..."`);
              logger.stats('Undo Repost', undoneCount);
              await randomDelay(600, 900);
              await safetyTracker.registerAction(logger);
            } else {
              // Press escape to close any popup menu
              await page.keyboard.press('Escape');
              await delay(300);
            }
          }
        }

        if (method1Success) {
          // Break early after undoing a repost to refresh timelines
          break;
        }

      } catch (err) {
        logger.warn('Failed to undo a specific repost. Continuing...', err.message || err);
        await page.keyboard.press('Escape').catch(() => {});
        await randomDelay(500, 1000);
      }
    }

    if (!undoneAnyThisPass) {
      logger.info('Scrolling to load more retweets...');
      await page.evaluate('window.scrollTo(0, window.scrollY + 800)');
      await delay(2000);
    }
  }

  logger.success(`Undo reposts run completed. Total retweets undone: ${undoneCount}`);
}
