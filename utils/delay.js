export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const randomDelay = async (min = 600, max = 1200) => {
  const ms = Math.floor(Math.random() * (max - min + 1) + min);
  await delay(ms);
};

export class SafetyTracker {
  constructor() {
    this.actionCount = 0;
  }

  /**
   * Tracks an action and automatically pauses for 10s every 50 actions.
   * @param {object} logger - Logger utility
   */
  async registerAction(logger) {
    this.actionCount++;
    if (this.actionCount % 50 === 0) {
      logger.info(`Safety: ${this.actionCount} actions performed. Pausing for 10 seconds...`);
      await delay(10000);
    }
  }

  reset() {
    this.actionCount = 0;
  }
}
