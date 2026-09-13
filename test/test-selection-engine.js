/**
 * Verification test for Weighted Selection Engine (Phase 1)
 */

import {
  validateWeights,
  selectWeightedSingleOption,
  selectWeightedCheckboxOptions,
  normalizeWeights
} from '../lib/selection-engine.js';

console.log('--- RUNNING SELECTION ENGINE VERIFICATION ---');

// Test 1: Single choice probability distribution (10,000 trials)
console.log('\n[Test 1] Single-choice weighted distribution:');
const options = [
  { id: 'opt_A', label: 'A', weight: 20 },
  { id: 'opt_B', label: 'B', weight: 50 },
  { id: 'opt_C', label: 'C', weight: 30 },
  { id: 'opt_Zero', label: 'Zero', weight: 0 }
];

const counts = { opt_A: 0, opt_B: 0, opt_C: 0, opt_Zero: 0 };
const TRIALS = 20000;

for (let i = 0; i < TRIALS; i++) {
  const res = selectWeightedSingleOption(options);
  if (res.error) throw new Error(res.error);
  counts[res.selectedOption.id]++;
}

console.log(`Results over ${TRIALS} trials:`);
console.log(`- Option A (expected ~20%): ${(counts.opt_A / TRIALS * 100).toFixed(2)}%`);
console.log(`- Option B (expected ~50%): ${(counts.opt_B / TRIALS * 100).toFixed(2)}%`);
console.log(`- Option C (expected ~30%): ${(counts.opt_C / TRIALS * 100).toFixed(2)}%`);
console.log(`- Option Zero (expected 0%): ${(counts.opt_Zero / TRIALS * 100).toFixed(2)}%`);

if (counts.opt_Zero !== 0) {
  throw new Error('FAILED: Option with 0 weight was selected!');
}
if (Math.abs(counts.opt_B / TRIALS - 0.5) > 0.03) {
  throw new Error('FAILED: Option B distribution outside acceptable tolerance!');
}
console.log('✓ Test 1 Passed: Single-choice distribution is mathematically accurate and zero-weights strictly excluded.');

// Test 2: All weights zero should return error
console.log('\n[Test 2] All weights zero:');
const zeroOptions = [
  { id: 'opt_1', weight: 0 },
  { id: 'opt_2', weight: 0 }
];
const zeroRes = selectWeightedSingleOption(zeroOptions);
if (!zeroRes.error) {
  throw new Error('FAILED: Expected error when all weights are zero');
}
console.log(`✓ Test 2 Passed: Correctly returned error: "${zeroRes.error}"`);

// Test 3: Checkbox weighting & required fallback
console.log('\n[Test 3] Checkbox weighting & required question fallback:');
const chkOptions = [
  { id: 'chk_1', label: 'Choice 1', weight: 80 },
  { id: 'chk_2', label: 'Choice 2', weight: 20 },
  { id: 'chk_Zero', label: 'Zero Choice', weight: 0 }
];

let zeroSelected = false;
let emptySelections = 0;

for (let i = 0; i < 5000; i++) {
  const res = selectWeightedCheckboxOptions(chkOptions, true); // isRequired = true
  if (res.error) throw new Error(res.error);
  if (res.selectedOptions.length === 0) emptySelections++;
  if (res.selectedOptions.some(o => o.id === 'chk_Zero')) zeroSelected = true;
}

if (zeroSelected) {
  throw new Error('FAILED: Zero-weight checkbox option was selected!');
}
if (emptySelections > 0) {
  throw new Error('FAILED: Required checkbox returned empty selection!');
}
console.log('✓ Test 3 Passed: Checkbox never selects zero-weight and guarantees non-empty selection when required.');

// Test 4: Normalization helper
console.log('\n[Test 4] Weight normalization:');
const unnormalized = [
  { id: '1', weight: 10 },
  { id: '2', weight: 30 }
];
const normalized = normalizeWeights(unnormalized);
const normSum = normalized.reduce((s, o) => s + o.weight, 0);
console.log(`Normalized 10 & 30 -> ${normalized[0].weight}% and ${normalized[1].weight}% (Sum: ${normSum}%)`);
if (normSum !== 100) {
  throw new Error(`FAILED: Normalization sum expected 100, got ${normSum}`);
}
console.log('✓ Test 4 Passed: Normalization correctly sums to 100%.');

console.log('\n========================================');
console.log('ALL PHASE 1 SELECTION ENGINE TESTS PASSED!');
console.log('========================================');
