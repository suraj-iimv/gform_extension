/**
 * Google Form Auto-Filler — Weighted Selection Engine
 * Mathematically correct weighted random selection algorithms
 * for single-choice and multiple-choice (checkbox) form fields.
 */

/**
 * Validates weights and computes sum of positive weights.
 * @param {Array<{id: string, weight: number}>} weightedOptions 
 * @returns {{ valid: boolean, sum: number, max: number, eligible: Array<any>, error?: string }}
 */
export function validateWeights(weightedOptions) {
  if (!weightedOptions || weightedOptions.length === 0) {
    return { valid: false, sum: 0, max: 0, eligible: [], error: "No options provided" };
  }

  let sum = 0;
  let max = 0;
  const eligible = [];

  for (const item of weightedOptions) {
    const rawWeight = Number(item.weight);
    const weight = isNaN(rawWeight) || rawWeight < 0 ? 0 : rawWeight;
    if (weight > 0) {
      eligible.push({ ...item, weight });
      sum += weight;
      if (weight > max) max = weight;
    }
  }

  if (sum <= 0 || eligible.length === 0) {
    return { valid: false, sum: 0, max: 0, eligible: [], error: "All option weights are zero or negative" };
  }

  return { valid: true, sum, max, eligible };
}

/**
 * Cumulative weighted random selection for single-choice fields (radio, dropdown, scale).
 * Probability(option i) = weight(i) / sum(all option weights)
 * 
 * @param {Array<{id: string, label?: string, weight: number}>} options
 * @param {number} [rngSeed] Optional random value in [0, 1) for testing
 * @returns {{ selectedOption: any, error?: string }}
 */
export function selectWeightedSingleOption(options, rngSeed = null) {
  const { valid, sum, eligible, error } = validateWeights(options);
  if (!valid) {
    return { selectedOption: null, error: error || "Invalid weights configuration" };
  }

  // Draw uniform random number in [0, sum)
  const rand = (rngSeed !== null ? rngSeed : Math.random()) * sum;

  let cumulative = 0;
  for (const opt of eligible) {
    cumulative += opt.weight;
    if (rand < cumulative) {
      return { selectedOption: opt };
    }
  }

  // Fallback to last eligible option in rare precision boundary cases
  return { selectedOption: eligible[eligible.length - 1] };
}

/**
 * Weighted checkbox selection.
 * - Never selects an option with weight = 0.
 * - Calculates independent probability based on weight percentage / relative weight.
 * - If question is required and no options were selected by chance,
 *   guarantees exactly one eligible option is picked via cumulative weighted single choice.
 * 
 * @param {Array<{id: string, label?: string, weight: number}>} options
 * @param {boolean} isRequired Whether the checkbox question requires at least one answer
 * @param {Function} [customRng] Optional RNG function returning number in [0, 1)
 * @returns {{ selectedOptions: Array<any>, error?: string }}
 */
export function selectWeightedCheckboxOptions(options, isRequired = false, customRng = Math.random) {
  const { valid, sum, max, eligible, error } = validateWeights(options);
  if (!valid) {
    return { selectedOptions: [], error: error || "Invalid checkbox weights configuration" };
  }

  const selectedOptions = [];
  // Base scale: if max weight <= 100, treat weights directly as percentages (e.g. 50 = 50% chance).
  // If weights exceed 100, normalize by max weight.
  const scale = max > 100 ? max : 100;

  for (const opt of eligible) {
    // Probability p_i in (0, 1]
    const p = Math.min(1.0, Math.max(0.01, opt.weight / scale));
    const roll = customRng();
    if (roll < p) {
      selectedOptions.push(opt);
    }
  }

  // If required and nothing was selected, pick one fallback using cumulative weighted selection
  if (isRequired && selectedOptions.length === 0) {
    const singleResult = selectWeightedSingleOption(eligible, customRng());
    if (singleResult.selectedOption) {
      selectedOptions.push(singleResult.selectedOption);
    }
  }

  return { selectedOptions };
}

/**
 * Helper to normalize an array of weights so they sum to 100% for UI display.
 * @param {Array<{id: string, weight: number}>} options 
 * @returns {Array<{id: string, weight: number}>}
 */
export function normalizeWeights(options) {
  const sum = options.reduce((acc, opt) => acc + (Number(opt.weight) || 0), 0);
  if (sum <= 0) {
    const equal = Math.floor(100 / (options.length || 1));
    return options.map(opt => ({ ...opt, weight: equal }));
  }
  return options.map(opt => ({
    ...opt,
    weight: Math.round(((Number(opt.weight) || 0) / sum) * 100)
  }));
}

/**
 * Calculates exact apportioned integer quotas for a target number of iterations
 * using the largest remainder method (Hamilton-Hare method).
 * Guarantees that sum(quotas) === targetCount and proportions match weights with minimal error.
 * 
 * @param {Array<{id: string, weight: number}>} options
 * @param {number} targetCount
 * @returns {Record<string, number>} Map of option ID -> exact integer count
 */
export function calculateApportionedQuotas(options, targetCount) {
  const { valid, sum, eligible } = validateWeights(options);
  if (!valid || targetCount <= 0) return {};

  const quotas = {};
  const remainders = [];
  let allocated = 0;

  for (const opt of eligible) {
    const exactShare = (opt.weight / sum) * targetCount;
    const integerShare = Math.floor(exactShare);
    quotas[opt.id] = integerShare;
    allocated += integerShare;
    remainders.push({ id: opt.id, rem: exactShare - integerShare });
  }

  // Allocate remaining slots to options with largest remainders
  remainders.sort((a, b) => b.rem - a.rem);
  let needed = targetCount - allocated;
  let idx = 0;
  while (needed > 0 && remainders.length > 0) {
    quotas[remainders[idx % remainders.length].id]++;
    needed--;
    idx++;
  }

  return quotas;
}

/**
 * Generates an exact, balanced array of length `targetCount` containing
 * options distributed according to user weights, randomized via Fisher-Yates shuffle.
 * 
 * @param {Array<{id: string, weight: number}>} options
 * @param {number} targetCount
 * @returns {Array<any>} Array of option objects of length targetCount
 */
export function generateBatchPlan(options, targetCount) {
  const quotas = calculateApportionedQuotas(options, targetCount);
  const pool = [];

  for (const opt of options) {
    const count = quotas[opt.id] || 0;
    for (let i = 0; i < count; i++) {
      pool.push(opt);
    }
  }

  // If sum < targetCount for any reason, pad with highest weight option
  const { eligible } = validateWeights(options);
  while (pool.length < targetCount && eligible.length > 0) {
    pool.push(eligible[0]);
  }

  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool;
}

/**
 * Generates an exact, balanced boolean schedule of length `targetCount` for each checkbox option.
 * @param {Array<{id: string, weight: number}>} options
 * @param {number} targetCount
 * @param {boolean} isRequired
 * @returns {Array<Array<string>>} Array of length targetCount, each containing array of selected option IDs
 */
export function generateCheckboxBatchPlan(options, targetCount, isRequired = false) {
  const { valid, eligible } = validateWeights(options);
  if (!valid || targetCount <= 0) {
    return Array.from({ length: targetCount }, () => []);
  }

  // Determine selection count for each eligible option
  const schedulePerOption = {};
  for (const opt of eligible) {
    const p = Math.min(1.0, Math.max(0.0, opt.weight / 100));
    const count = Math.round(targetCount * p);
    const arr = Array(targetCount).fill(false);
    for (let i = 0; i < count; i++) arr[i] = true;
    // Shuffle
    for (let i = targetCount - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    schedulePerOption[opt.id] = arr;
  }

  const result = [];
  for (let iter = 0; iter < targetCount; iter++) {
    const selected = [];
    for (const opt of eligible) {
      if (schedulePerOption[opt.id]?.[iter]) {
        selected.push(opt.id);
      }
    }
    // If required and empty, allocate the highest weight option for this iteration
    if (isRequired && selected.length === 0 && eligible.length > 0) {
      selected.push(eligible[0].id);
    }
    result.push(selected);
  }

  return result;
}


