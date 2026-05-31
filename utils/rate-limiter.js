/**
 * Sliding Window Rate Limiter
 */
export class SlidingWindowRateLimiter {
  constructor(options = {}) {
    this.maxRequests = options.maxRequests || 100;
    this.windowMs = options.windowMs || 1000;
    this.requests = [];
  }

  getCurrentWeight() {
    this.cleanup();
    return this.requests.reduce((sum, request) => {
      return sum + (typeof request === 'number' ? 1 : request.weight);
    }, 0);
  }

  canRequest(weight = 1) {
    return this.getCurrentWeight() + weight <= this.maxRequests;
  }

  tryRequest(weight = 1) {
    this.cleanup();

    if (!this.canRequest(weight)) {
      return false;
    }

    this.requests.push({
      timestamp: Date.now(),
      weight
    });
    return true;
  }

  async waitForSlot(weight = 1) {
    while (!this.canRequest(weight)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.tryRequest(weight);
  }

  cleanup() {
    const now = Date.now();
    this.requests = this.requests.filter(request => {
      const timestamp = typeof request === 'number' ? request : request.timestamp;
      return now - timestamp < this.windowMs;
    });
  }
}
