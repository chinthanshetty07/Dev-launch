import { describe, it, expect } from 'vitest';
import { needsLegacyOpenssl } from '../services/planning/RuleBasedPlanner.js';

describe('which projects need OpenSSL\'s legacy algorithms', () => {
  it('react-scripts 4 or older, and webpack 4 or older', () => {
    expect(needsLegacyOpenssl({ 'react-scripts': '4.0.3', react: '17' })).toBe('react-scripts 4.0.3');
    expect(needsLegacyOpenssl({ 'react-scripts': '^3.4.1' })).toBe('react-scripts ^3.4.1');
    expect(needsLegacyOpenssl({ webpack: '~4.46.0' })).toBe('webpack ~4.46.0');
  });
  it('not react-scripts 5, webpack 5, or a project with neither', () => {
    expect(needsLegacyOpenssl({ 'react-scripts': '5.0.1' })).toBeNull();
    expect(needsLegacyOpenssl({ webpack: '^5.90.0' })).toBeNull();
    expect(needsLegacyOpenssl({ vite: '5' })).toBeNull();
    expect(needsLegacyOpenssl({ 'react-scripts': 'latest' })).toBeNull();
  });
});
