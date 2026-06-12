import chalk from 'chalk';

export const logger = {
  info: (msg) => {
    console.log(chalk.cyan(`ℹ ${msg}`));
  },
  success: (msg) => {
    console.log(chalk.green(`✓ ${msg}`));
  },
  warn: (msg) => {
    console.log(chalk.yellow(`⚠ ${msg}`));
  },
  error: (msg, err = '') => {
    console.log(chalk.red(`✗ ${msg}`), err ? chalk.dim(err.stack || err) : '');
  },
  header: (msg) => {
    console.log(chalk.bold.magenta(`\n=== ${msg} ===\n`));
  },
  stats: (actionType, done, remaining) => {
    const remainingText = remaining !== null && remaining !== undefined ? `~${remaining}` : '?';
    console.log(chalk.bold.blue(`Stats -> ${actionType}d: ${done} | Remaining: ${remainingText}`));
  }
};
