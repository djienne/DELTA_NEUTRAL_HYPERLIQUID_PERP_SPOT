export function requireLiveTradingTest(scriptName = 'this script') {
  if (process.env.RUN_LIVE_TRADING_TESTS === '1') {
    return;
  }

  console.error(`[Live Guard] ${scriptName} can place live Hyperliquid orders or mutate account settings.`);
  console.error('[Live Guard] Set RUN_LIVE_TRADING_TESTS=1 only when you intentionally want to run it.');
  process.exit(2);
}
