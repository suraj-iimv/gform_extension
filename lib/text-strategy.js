/**
 * Google Form Auto-Filler — Text Answer Strategy
 * Strictly controls text/paragraph question filling without generating silent fake answers.
 */

import { TEXT_STRATEGIES } from './constants.js';

/**
 * Resolves the answer string for a text or paragraph question.
 * @param {object} question Normalized question schema
 * @param {object} config User's configuration for this question
 * @returns {{ value: string | null, skip: boolean, error?: string }}
 */
export function resolveTextAnswer(question, config) {
  const strategy = config?.strategy || (question.required ? TEXT_STRATEGIES.STOP_IF_REQUIRED : TEXT_STRATEGIES.SKIP_IF_OPTIONAL);

  switch (strategy) {
    case TEXT_STRATEGIES.FIXED: {
      const val = config?.fixedText != null ? String(config.fixedText).trim() : '';
      if (question.required && !val) {
        return { value: null, skip: false, error: `Required question "${question.title}" has no fixed text provided.` };
      }
      return { value: val, skip: !val && !question.required };
    }

    case TEXT_STRATEGIES.POOL: {
      const pool = Array.isArray(config?.answerPool) ? config.answerPool.map(s => String(s).trim()).filter(Boolean) : [];
      if (pool.length === 0) {
        if (question.required) {
          return { value: null, skip: false, error: `Required question "${question.title}" has an empty answer pool.` };
        }
        return { value: null, skip: true };
      }
      // Pick random item from user-defined pool
      const picked = pool[Math.floor(Math.random() * pool.length)];
      return { value: picked, skip: false };
    }

    case TEXT_STRATEGIES.SKIP_IF_OPTIONAL: {
      if (question.required) {
        return { value: null, skip: false, error: `Question "${question.title}" is required and cannot be skipped.` };
      }
      return { value: null, skip: true };
    }

    case TEXT_STRATEGIES.STOP_IF_REQUIRED:
    default: {
      if (question.required) {
        return { value: null, skip: false, error: `Required question "${question.title}" requires an explicit text strategy (Fixed Answer or Pool).` };
      }
      return { value: null, skip: true };
    }
  }
}
