/**
 * Unit tests for Quota Apportionment and Batch Distribution Engine
 */

import {
  calculateApportionedQuotas,
  generateBatchPlan
} from '../lib/selection-engine.js';

console.log('--- TESTING BATCH QUOTA APPORTIONMENT ---');

// Test 1: Apportionment with N = 10, weights 70% and 30%
const options = [
  { id: 'opt_A', label: 'A', weight: 70 },
  { id: 'opt_B', label: 'B', weight: 30 }
];

const quotas10 = calculateApportionedQuotas(options, 10);
console.log('Quotas for N=10 (70/30):', quotas10);
if (quotas10['opt_A'] !== 7 || quotas10['opt_B'] !== 3) {
  throw new Error(`FAILED: Expected 7 and 3, got ${quotas10['opt_A']} and ${quotas10['opt_B']}`);
}
console.log('✓ Test 1 Passed: Exact 7 and 3 allocations.');

// Test 2: Apportionment with N = 5, weights 50%, 25%, 25%
const options3 = [
  { id: 'opt_A', label: 'A', weight: 50 },
  { id: 'opt_B', label: 'B', weight: 25 },
  { id: 'opt_C', label: 'C', weight: 25 }
];
const quotas5 = calculateApportionedQuotas(options3, 5);
console.log('Quotas for N=5 (50/25/25):', quotas5);
const sum5 = Object.values(quotas5).reduce((a, b) => a + b, 0);
if (sum5 !== 5 || quotas5['opt_A'] !== 3 || quotas5['opt_B'] !== 1 || quotas5['opt_C'] !== 1) {
  throw new Error(`FAILED: Expected sum 5 (3, 1, 1), got ${JSON.stringify(quotas5)}`);
}
console.log('✓ Test 2 Passed: Largest remainder method works perfectly.');

// Test 3: Generate 100 iterations batch plan
const plan100 = generateBatchPlan(options, 100);
const counts100 = { opt_A: 0, opt_B: 0 };
plan100.forEach(item => { counts100[item.id]++; });
console.log('Plan results for N=100:', counts100);
if (counts100['opt_A'] !== 70 || counts100['opt_B'] !== 30) {
  throw new Error(`FAILED: Expected exactly 70 and 30, got ${JSON.stringify(counts100)}`);
}
console.log('✓ Test 3 Passed: Batch plan has 100% exact quota fidelity.');

console.log('\n========================================');
console.log('ALL QUOTA APPORTIONMENT TESTS PASSED!');
console.log('========================================');
