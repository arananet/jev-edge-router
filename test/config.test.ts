import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from '../src/config';
import exampleConfig from '../config/tiers.example.json';

describe('config', () => {
  it('accepts the shipped example', () => {
    const config = parseConfig(exampleConfig);
    expect(config.tier_order).toEqual(['small', 'mid', 'top']);
    expect(config.tiers['top']?.provider).toBe('anthropic');
  });

  it('rejects a default tier that is not defined', () => {
    expect(() => parseConfig({ ...exampleConfig, default_tier: 'huge' })).toThrow(/unknown tier/);
  });

  it('rejects an openai-compatible tier with no base_url', () => {
    const broken = structuredClone(exampleConfig) as Record<string, any>;
    delete broken['tiers']['small']['base_url'];
    expect(() => parseConfig(broken)).toThrow(/base_url/);
  });

  it('rejects a tier missing from tier_order', () => {
    const broken = structuredClone(exampleConfig) as Record<string, any>;
    broken['tier_order'] = ['small', 'mid'];
    expect(() => parseConfig(broken)).toThrow(/missing from tier_order/);
  });

  it('reports invalid JSON clearly', () => {
    expect(() => loadConfig('{not json')).toThrow(/not valid JSON/);
  });
});
