// Position recovery: verify the managed on-chain exposure, adopt an existing delta-neutral pair, and reconcile a
// pendingIntent left by a crash or a failed trade. bot.js calls these at startup, before each cycle and in its status tick.
import fs from 'fs';
import { saveState, recordPosition, closePosition as closePositionState, clearPendingIntent } from './state.js';
import { closeDeltaNeutralPosition } from './trade.js';
import { autoHedgeAll, analyzeHedgeNeeds } from './hedge.js';
import { getManagedPerpSymbols, getManagedSpotSymbols, getMaxHedgeMismatchPercent } from './risk.js';
import { perpToSpot } from './symbols.js';

// The same config.json bot.js reads (never mutated), so these keep the signatures the tests and bot.js call.
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

/**
 * Check for existing delta-neutral position on-chain
 * (In case bot was restarted and state is out of sync)
 */
export async function verifyPositionOnChain(connector, botState) {
  const snapshot = await analyzeHedgeNeeds(connector, managedScope(botState?.position, botState?.pendingIntent));
  const { analysis, symbols } = snapshot;
  for (const d of snapshot.dust) console.log(`[Bot] Dust: ${d.symbol} ${d.size} ($${d.valueUSD.toFixed(4)}), not executable alone`);
  if (!symbols.length) return { status: 'none', pair: null, analysis, snapshot };
  const expected = botState?.position?.symbol ?? botState?.pendingIntent?.symbol;
  if (symbols.length > 1 || (expected && symbols[0] !== expected)) {
    console.error('[Bot] Managed exposure is ambiguous or differs from state; manual resolution required');
    return { status: 'ambiguous', pair: null, analysis, snapshot };
  }
  const pair = [...analysis.deltaNeutralPairs, ...analysis.imbalancedPairs].find(p => p.isDeltaNeutral);
  return { status: pair && !snapshot.needsHedging ? 'delta_neutral' : 'imbalanced', pair, analysis, snapshot };
}
export async function confirmNoManagedExposure(confirmations = 3, delayMs = 750, connector, botState) {
  for (let i = 0; i < confirmations; i++) {
    const onChainPosition = await verifyPositionOnChain(connector, botState);
    if (onChainPosition.status !== 'none') {
      return false;
    }
    if (i < confirmations - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return true;
}

export function adoptOnChainPair(pair, botState, reason, persist = saveState) {
  const previous = botState.position?.symbol === pair.symbol ? botState.position : null;
  const position = previous ? {
    ...previous, perpSize: pair.perpSize, spotSize: pair.spotSize,
    accountingComplete: previous.accountingComplete !== false && previous.perpSize === pair.perpSize && previous.spotSize === pair.spotSize
  } : {
    success: true, symbol: pair.symbol, perpSymbol: pair.symbol,
    spotSymbol: perpToSpot(pair.symbol),
    perpSize: pair.perpSize, spotSize: pair.spotSize,
    perpEntryPrice: pair.perpPosition.entryPrice > 0 ? pair.perpPosition.entryPrice : null,
    spotEntryPrice: null, positionValue: pair.perpPosition.positionValue,
    fundingRate: null, annualizedFunding: null, openFeesActual: 0, openFeesEstimated: 0,
    openTime: botState.pendingIntent?.type === 'opening' ? botState.pendingIntent.createdAt : null,
    adoptedAt: Date.now(),  // starts the minimum-hold clock when the real opening time is unknown
    accountingComplete: false
  };
  const next = recordPosition(botState, position);
  persist(next);
  console.log(`[Bot] Adopted ${pair.symbol} (${reason}); unknown historical costs remain unavailable`);
  return next;
}

export function managedScope(position, intent) {
  return {
    managedSpotSymbols: [...new Set([...getManagedSpotSymbols(config, position), ...(intent?.spotSymbol ? [intent.spotSymbol] : [])])],
    managedPerpSymbols: [...new Set([...getManagedPerpSymbols(config, position), ...(intent?.perpSymbol ? [intent.perpSymbol] : [])])],
    maxHedgeMismatchPercent: getMaxHedgeMismatchPercent(config)
  };
}

export async function reconcilePendingIntent(connector, botState, persist = saveState) {
  const intent = botState?.pendingIntent;
  if (!intent) return botState;
  if (intent.type === 'closing') {
    const position = botState.position?.symbol === intent.symbol ? botState.position : {
      symbol: intent.symbol, perpSymbol: intent.perpSymbol, spotSymbol: intent.spotSymbol,
      openTime: null, perpEntryPrice: null, spotEntryPrice: null, accountingComplete: false
    };
    // A prior process/cycle may have filled one leg. Never recreate it, or guess its exit price.
    const result = await closeDeltaNeutralPosition(connector, position, config,
      { reason: intent.reason || 'Recovered close', accountingComplete: false, verbose: true });
    const next = closePositionState({ ...botState, position }, result);
    persist(next);
    return next;
  }
  if (intent.type !== 'opening') throw new Error(`Unknown pending intent ${intent.type}`);
  let chain = await verifyPositionOnChain(connector, botState);
  if (chain.status === 'none') {
    if (!await confirmNoManagedExposure(3, 750, connector, botState)) return botState;
    const next = clearPendingIntent(botState);
    persist(next);
    return next;
  }
  if (chain.status === 'imbalanced') {
    await autoHedgeAll(connector, config, { fallbackToClose: false, ...managedScope(botState.position, intent) });
    chain = await verifyPositionOnChain(connector, botState);
  }
  if (chain.status === 'delta_neutral' && chain.pair.symbol === intent.symbol) {
    return adoptOnChainPair(chain.pair, botState, 'recovered opening', persist);
  }
  return botState;
}
