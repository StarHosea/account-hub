import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('static-cache', () => {
  it('disabled when config.enabled is false', async () => {
    const { attachStaticCache } = await import('../static-cache.js');
    const fake = { route: async () => { throw new Error('should not route'); } };
    const out = await attachStaticCache(fake, { config: { enabled: false } });
    assert.equal(out.stats.hits, 0);
    await out.logSummary();
  });

  it('enabled attaches route handler', async () => {
    const { attachStaticCache } = await import('../static-cache.js');
    let routed = false;
    const fake = {
      route: async (_pat, handler) => {
        routed = true;
        assert.equal(typeof handler, 'function');
      },
    };
    const out = await attachStaticCache(fake, {
      log: () => {},
      config: { enabled: true, maxAgeDays: 3, dir: '' },
    });
    assert.ok(routed);
    await out.logSummary();
  });
});
