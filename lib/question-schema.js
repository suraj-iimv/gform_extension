/**
 * Google Form Auto-Filler — Normalized Question Schema
 * Validates and normalizes parsed question objects from the DOM scanner.
 */

import { QUESTION_TYPES } from './constants.js';

/**
 * Creates a normalized question object.
 * @param {object} raw
 * @returns {object} Normalized question schema
 */
export function createNormalizedQuestion({
  id,
  title = "Untitled Question",
  type = QUESTION_TYPES.UNSUPPORTED,
  required = false,
  options = [],
  supported = true,
  reason = null
}) {
  const isSupportedType = Object.values(QUESTION_TYPES).includes(type) && type !== QUESTION_TYPES.UNSUPPORTED;

  if (!isSupportedType) {
    return {
      id: String(id || `question_${Date.now()}`),
      title: String(title).trim() || "Untitled Question",
      type: QUESTION_TYPES.UNSUPPORTED,
      required: Boolean(required),
      supported: false,
      reason: reason || `Unsupported question type: ${type}`,
      options: []
    };
  }

  // Normalize options
  const normalizedOptions = (options || []).map((opt, idx) => ({
    id: String(opt.id || `opt_${idx}`),
    label: String(opt.label || `Option ${idx + 1}`).trim(),
    value: opt.value != null ? String(opt.value) : String(opt.label || '')
  }));

  return {
    id: String(id || `question_${Date.now()}`),
    title: String(title).trim() || "Untitled Question",
    type,
    required: Boolean(required),
    supported: Boolean(supported),
    reason: supported ? null : (reason || "Unsupported question configuration"),
    options: normalizedOptions
  };
}
