export class UnknownOrderOutcomeError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'UnknownOrderOutcomeError';
    this.context = context;
    this.isUnknownOrderOutcome = true;
  }
}

export class OrderNotFilledError extends Error {
  constructor(message, outcome = null) {
    super(message);
    this.name = 'OrderNotFilledError';
    this.outcome = outcome;
  }
}

export class PartialFillError extends Error {
  constructor(message, outcome = null) {
    super(message);
    this.name = 'PartialFillError';
    this.outcome = outcome;
  }
}

export function getOrderStatus(result) {
  return result?.response?.data?.statuses?.[0] || {};
}

export function getFilledStatus(result) {
  return getOrderStatus(result).filled || null;
}

export function getOrderError(result) {
  return getOrderStatus(result).error || null;
}

export function getFilledSize(result) {
  const filled = getFilledStatus(result);
  const size = parseFloat(filled?.totalSz || '0');
  return Number.isFinite(size) ? size : 0;
}

export function getFilledPrice(result, fallbackPrice = 0) {
  const filled = getFilledStatus(result);
  const price = parseFloat(filled?.avgPx || fallbackPrice);
  return Number.isFinite(price) ? price : fallbackPrice;
}

export function isFillComplete(result, requestedSize, minFillRatio = 0.999) {
  if (!getFilledStatus(result)) {
    return false;
  }

  const filledSize = getFilledSize(result);
  return filledSize >= requestedSize * minFillRatio;
}

export function normalizeOrderOutcome(input, options = {}) {
  const {
    requestedSize = null,
    minFillRatio = 0.999,
    fallbackPrice = 0,
    context = {}
  } = options;

  if (input?.status === 'rejected') {
    const reason = input.reason;
    const unknown = reason?.isUnknownOrderOutcome === true;
    return {
      result: null,
      status: unknown ? 'unknown' : 'rejected',
      rejected: true,
      unknown,
      filled: null,
      fillSize: 0,
      fillPrice: null,
      oid: null,
      error: reason?.message || String(reason),
      context: { ...context, ...(reason?.context || {}) },
      isCompleteFill: false
    };
  }

  const result = input?.status === 'fulfilled' ? input.value : input;
  const status = getOrderStatus(result);
  const filled = status.filled || null;
  const fillSize = getFilledSize(result);
  const fillPrice = filled ? getFilledPrice(result, fallbackPrice) : null;
  const requested = Number(requestedSize);
  const hasRequestedSize = Number.isFinite(requested) && requested > 0;
  const isCompleteFill = Boolean(filled) &&
    (!hasRequestedSize || fillSize >= requested * minFillRatio);

  return {
    result,
    status: filled ? (isCompleteFill ? 'filled' : 'partial') : 'not_filled',
    rejected: false,
    unknown: result?.unknown === true || result?.isUnknownOrderOutcome === true,
    filled,
    fillSize,
    fillPrice,
    oid: filled?.oid || null,
    error: getOrderError(result),
    context,
    isCompleteFill
  };
}

export function assertCompleteFill(result, requestedSize, options = {}) {
  const minFillRatio = options.minFillRatio ?? 0.999;
  const outcome = normalizeOrderOutcome(result, {
    requestedSize,
    minFillRatio,
    fallbackPrice: options.fallbackPrice,
    context: options.context
  });

  if (outcome.unknown) {
    throw new UnknownOrderOutcomeError(
      options.unknownMessage || 'Order outcome is unknown; reconcile on-chain before retrying',
      outcome.context
    );
  }

  if (!outcome.filled) {
    throw new OrderNotFilledError(
      options.notFilledMessage || outcome.error || 'Order was not filled',
      outcome
    );
  }

  if (!outcome.isCompleteFill) {
    throw new PartialFillError(
      options.partialMessage ||
        `Order filled ${outcome.fillSize}/${requestedSize}, below ${(minFillRatio * 100).toFixed(2)}% threshold`,
      outcome
    );
  }

  return outcome;
}

export function getSizeMismatchPercent(sizeA, sizeB) {
  const denominator = Math.max(Math.abs(sizeA), Math.abs(sizeB));
  if (denominator === 0) {
    return 0;
  }

  return (Math.abs(sizeA - sizeB) / denominator) * 100;
}

function getKnownFee(result) {
  const filled = getFilledStatus(result);
  const candidates = [
    filled?.fee,
    filled?.feeUsd,
    filled?.builderFee,
    filled?.builderFeeUsd
  ];

  for (const value of candidates) {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.abs(parsed);
    }
  }

  return 0;
}

export function getOrderFees(...results) {
  return results.reduce((sum, result) => sum + getKnownFee(result), 0);
}
