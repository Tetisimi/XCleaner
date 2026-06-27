import { chromium } from 'playwright';
import prompts from 'prompts';
import { logger } from './utils/logger.js';
import { SafetyTracker, delay } from './utils/delay.js';
import { waitForLogin } from './utils/waitForLogin.js';

// Actions
import { unlikeTweets } from './actions/unlike.js';
import { unbookmarkNsfwTweets } from './actions/unbookmark.js';
import { deleteTweets } from './actions/deleteTweets.js';
import { deleteRetweets } from './actions/deleteRetweets.js';
import { clearSearchHistory } from './actions/clearSearch.js';

async function main() {
  logger.header('X (Twitter) Activity Cleaner');

  // 1. Launch Playwright browser with a persistent context & anti-bot evasion
  logger.info('Opening browser window...');
  
  const userDataDir = './user_data';
  
  // Launch persistent context directly so login sessions are saved locally
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    // Try to use system Google Chrome for a more natural signature. 
    // Fallback to Chromium if Chrome isn't found by omitting it in catch.
    channel: 'chrome', 
    viewport: null,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled' // Hides the navigator.webdriver automation flag
    ]
  }).catch(async () => {
    // Fallback to default Playwright Chromium if system Chrome is not installed
    logger.warn('System Google Chrome not found. Falling back to default Chromium...');
    return await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: null,
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled'
      ]
    });
  });

  // Get the default page opened by the persistent context
  const page = context.pages()[0] || await context.newPage();

  // 2. Navigate to login
  logger.info('Navigating to login page...');
  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

  // 3. Pause & wait for manual login
  let username;
  try {
    username = await waitForLogin(page);
  } catch (err) {
    logger.error('Error occurred during login detection. Exiting...', err);
    await context.close();
    process.exit(1);
  }

  // 4. CLI Menu to select actions
  const menuResponse = await prompts({
    type: 'multiselect',
    name: 'selectedActions',
    message: 'Pick what to clean (Space to select, Enter to confirm):',
    choices: [
      { title: 'Unlike ALL liked tweets', value: 'unlike' },
      { title: 'Unlike ONLY explicit/NSFW liked tweets', value: 'unlike_explicit' },
      { title: 'Remove NSFW bookmarks', value: 'unbookmark_nsfw' },
      { title: 'Delete all my tweets', value: 'delete_tweets' },
      { title: 'Delete all retweets', value: 'delete_retweets' },
      { title: 'Clear search history', value: 'clear_search' },
      { title: 'Run all of the above (Unlike ALL)', value: 'all' }
    ],
    min: 1,
    hint: '- Space to select. Enter to submit'
  });

  if (!menuResponse.selectedActions || menuResponse.selectedActions.length === 0) {
    logger.info('No actions selected. Exiting.');
    await context.close();
    process.exit(0);
  }

  // Resolve actions to run
  let actionsToRun = [...menuResponse.selectedActions];
  if (actionsToRun.includes('all')) {
    actionsToRun = ['unlike', 'delete_tweets', 'delete_retweets', 'clear_search'];
  }

  // Deduplicate unlike modes if both selected (prefer unlike all)
  if (actionsToRun.includes('unlike') && actionsToRun.includes('unlike_explicit')) {
    actionsToRun = actionsToRun.filter(a => a !== 'unlike_explicit');
  }

  // 5. Confirm destructive operations
  const confirmResponse = await prompts({
    type: 'text',
    name: 'confirmText',
    message: 'This cannot be undone. Type YES to continue: ',
    validate: val => val === 'YES' ? true : 'You must type YES to continue'
  });

  if (!confirmResponse.confirmText || confirmResponse.confirmText !== 'YES') {
    logger.info('Confirmation cancelled. Exiting.');
    await context.close();
    process.exit(0);
  }

  // Initialize SafetyTracker to automatically handle pauses (e.g. 10s delay every 50 actions)
  const safetyTracker = new SafetyTracker();

  // 6. Execute actions in order
  try {
    for (const action of actionsToRun) {
      if (action === 'unlike') {
        await unlikeTweets(page, username, safetyTracker, { explicitOnly: false });
      } else if (action === 'unlike_explicit') {
        await unlikeTweets(page, username, safetyTracker, { explicitOnly: true });
      } else if (action === 'unbookmark_nsfw') {
        await unbookmarkNsfwTweets(page, safetyTracker);
      } else if (action === 'delete_tweets') {
        await deleteTweets(page, username, safetyTracker);
      } else if (action === 'delete_retweets') {
        await deleteRetweets(page, username, safetyTracker);
      } else if (action === 'clear_search') {
        await clearSearchHistory(page, safetyTracker);
      }
      // Add a small 2-second delay between action sections
      await delay(2000);
    }
    
    logger.header('All selected actions completed!');
  } catch (error) {
    logger.error('An unexpected error occurred during execution:', error);
  } finally {
    if (context) {
      logger.info('Closing browser in 5 seconds...');
      await delay(5000);
      await context.close().catch(() => {});
    }
    logger.info('Browser closed. Goodbye!');
  }
}

main().catch(err => {
  logger.error('Fatal entrypoint error:', err);
  process.exit(1);
});
