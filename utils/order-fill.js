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

export function getSizeMismatchPercent(sizeA, sizeB) {
  const denominator = Math.max(Math.abs(sizeA), Math.abs(sizeB));
  if (denominator === 0) {
    return 0;
  }

  return (Math.abs(sizeA - sizeB) / denominator) * 100;
}

function collectNumericFees(value) {
  if (!value || typeof value !== 'object') {
    return 0;
  }

  let total = 0;

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'number' && Number.isFinite(child) && key.toLowerCase().includes('fee')) {
      total += Math.abs(child);
    } else if (typeof child === 'string' && key.toLowerCase().includes('fee')) {
      const parsed = parseFloat(child);
      if (Number.isFinite(parsed)) {
        total += Math.abs(parsed);
      }
    } else if (child && typeof child === 'object') {
      total += collectNumericFees(child);
    }
  }

  return total;
}

export function getOrderFees(...results) {
  return results.reduce((sum, result) => sum + collectNumericFees(result), 0);
}
