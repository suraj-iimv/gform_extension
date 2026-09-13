/**
 * Google Form Auto-Filler — Popup Controller
 * Manages configuration, persistent auto-save, pre-flight validation,
 * and live telemetry syncing with background state machine.
 */

import { MSG, RUN_STATUS, QUESTION_TYPES, TEXT_STRATEGIES, STORAGE_KEYS } from '../lib/constants.js';
import { normalizeWeights } from '../lib/selection-engine.js';

// --- STATE ---
let activeTab = null;
let currentFormSchema = null;
let currentFormConfig = {
  targetCount: 5,
  delaySec: 3,
  weightsConfig: {},
  textConfig: {}
};
let autoSaveTimeout = null;

// --- DOM ELEMENTS ---
const statusPill = document.getElementById('statusPill');
const statusBadgeText = document.getElementById('statusBadgeText');
const formNameText = document.getElementById('formNameText');
const formIdMeta = document.getElementById('formIdMeta');
const btnRefreshForm = document.getElementById('btnRefreshForm');

const tabBulkBtn = document.getElementById('tabBulkBtn');
const tabQuickBtn = document.getElementById('tabQuickBtn');
const tabSettingsBtn = document.getElementById('tabSettingsBtn');
const panelBulk = document.getElementById('panelBulk');
const panelQuick = document.getElementById('panelQuick');
const panelSettings = document.getElementById('panelSettings');

const runCard = document.getElementById('runCard');
const runCounter = document.getElementById('runCounter');
const progressBar = document.getElementById('progressBar');
const statusMessageText = document.getElementById('statusMessageText');
const livePulse = document.getElementById('livePulse');

const btnStartBulk = document.getElementById('btnStartBulk');
const btnPauseBulk = document.getElementById('btnPauseBulk');
const btnResumeBulk = document.getElementById('btnResumeBulk');
const btnStopBulk = document.getElementById('btnStopBulk');

const inputTargetCount = document.getElementById('inputTargetCount');
const inputDelaySec = document.getElementById('inputDelaySec');

const btnQuickFill = document.getElementById('btnQuickFill');
const quickResultsBox = document.getElementById('quickResultsBox');
const quickResultsList = document.getElementById('quickResultsList');

const questionsContainer = document.getElementById('questionsContainer');
const autoSaveIndicator = document.getElementById('autoSaveIndicator');
const btnEqualizeAll = document.getElementById('btnEqualizeAll');
const btnResetWeights = document.getElementById('btnResetWeights');

const errorBanner = document.getElementById('errorBanner');
const errorText = document.getElementById('errorText');
const btnDismissError = document.getElementById('btnDismissError');

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
  setupTabNavigation();
  setupControlListeners();

  // 1. Check background state machine first
  await syncBackgroundState();

  // 2. Identify active tab & detect form
  await detectActiveTabForm();

  // 3. Listen to storage changes for live progress updates
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEYS.RUN_STATE]) {
      renderRunState(changes[STORAGE_KEYS.RUN_STATE].newValue);
    }
  });
});

// --- TAB NAVIGATION ---
function setupTabNavigation() {
  const tabs = [
    { btn: tabBulkBtn, panel: panelBulk },
    { btn: tabQuickBtn, panel: panelQuick },
    { btn: tabSettingsBtn, panel: panelSettings }
  ];

  tabs.forEach(({ btn, panel }) => {
    btn.addEventListener('click', () => {
      tabs.forEach(t => {
        t.btn.classList.remove('active');
        t.panel.classList.remove('active');
      });
      btn.classList.add('active');
      panel.classList.add('active');
    });
  });
}

// --- FORM DETECTION & CONFIG RECOVERY ---
async function detectActiveTabForm() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
      showError('No active browser tab found.');
      return;
    }

    activeTab = tabs[0];
    formNameText.textContent = activeTab.title || 'Detecting form...';

    // Send scan request to content script
    let response;
    try {
      response = await chrome.tabs.sendMessage(activeTab.id, { type: MSG.GET_FORM_SCHEMA });
    } catch (err) {
      // Content script may not be injected yet
      questionsContainer.innerHTML = `
        <div class="empty-state">
          <p>No Google Form detected on active tab.</p>
          <p style="margin-top: 8px; font-size: 11px;">Navigate to a Google Form or Mock Form page, then click refresh.</p>
        </div>
      `;
      formNameText.textContent = 'No Form Detected';
      formIdMeta.textContent = 'ID: none';
      return;
    }

    if (!response || !response.success || !response.schema) {
      questionsContainer.innerHTML = `<div class="empty-state">Could not inspect form schema.</div>`;
      return;
    }

    currentFormSchema = response.schema;
    formNameText.textContent = activeTab.title || 'Google Form';
    formIdMeta.textContent = `ID: ${currentFormSchema.formId}`;

    // Load saved configuration for this form ID
    await loadSavedFormConfig(currentFormSchema.formId);

    // Render questions accordion
    renderQuestions(currentFormSchema.questions);
  } catch (err) {
    console.error('[GFAF] Form detection error:', err);
    showError('Error scanning active tab: ' + err.message);
  }
}

// --- CONFIG PERSISTENCE ---
async function loadSavedFormConfig(formId) {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.FORM_CONFIGS);
    const allConfigs = data[STORAGE_KEYS.FORM_CONFIGS] || {};
    const saved = allConfigs[formId];

    if (saved) {
      currentFormConfig = {
        targetCount: saved.targetCount ?? 5,
        delaySec: saved.delaySec ?? 3,
        weightsConfig: saved.weightsConfig || {},
        textConfig: saved.textConfig || {}
      };
      inputTargetCount.value = currentFormConfig.targetCount;
      inputDelaySec.value = currentFormConfig.delaySec;
    } else {
      currentFormConfig = {
        targetCount: Number(inputTargetCount.value) || 5,
        delaySec: Number(inputDelaySec.value) || 3,
        weightsConfig: {},
        textConfig: {}
      };
    }
  } catch (err) {
    console.error('[GFAF] Failed to load config:', err);
  }
}

function triggerAutoSave() {
  autoSaveIndicator.textContent = 'Saving...';
  autoSaveIndicator.style.background = 'rgba(245, 158, 11, 0.2)';
  autoSaveIndicator.style.color = '#f59e0b';

  if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTimeout(async () => {
    await saveFormConfigNow();
  }, 150);
}

async function saveFormConfigNow() {
  if (!currentFormSchema?.formId) return;

  currentFormConfig.targetCount = Number(inputTargetCount.value) || 1;
  currentFormConfig.delaySec = Number(inputDelaySec.value) >= 0 ? Number(inputDelaySec.value) : 0;

  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.FORM_CONFIGS);
    const allConfigs = data[STORAGE_KEYS.FORM_CONFIGS] || {};
    allConfigs[currentFormSchema.formId] = currentFormConfig;

    await chrome.storage.local.set({ [STORAGE_KEYS.FORM_CONFIGS]: allConfigs });

    autoSaveIndicator.textContent = 'Auto-saved';
    autoSaveIndicator.style.background = 'rgba(16, 185, 129, 0.15)';
    autoSaveIndicator.style.color = '#10b981';
  } catch (err) {
    console.error('[GFAF] Save config error:', err);
  }
}

window.addEventListener('beforeunload', () => {
  if (autoSaveTimeout) {
    clearTimeout(autoSaveTimeout);
    saveFormConfigNow();
  }
});

// --- RENDER QUESTIONS ACCORDION ---
function renderQuestions(questions) {
  if (!questions || questions.length === 0) {
    questionsContainer.innerHTML = `<div class="empty-state">No questions found on this form.</div>`;
    return;
  }

  questionsContainer.innerHTML = '';

  questions.forEach((q, qIdx) => {
    const card = document.createElement('div');
    card.className = 'q-card';
    if (qIdx === 0) card.classList.add('open'); // Expand first question by default

    // Header
    const header = document.createElement('div');
    header.className = 'q-header';
    header.innerHTML = `
      <div class="q-title-box">
        <span class="q-type-tag">${q.type}</span>
        <span class="q-name" title="${q.title}">${q.title}</span>
        ${q.required ? '<span class="q-req-star">*</span>' : ''}
      </div>
      <span class="q-toggle-icon">▼</span>
    `;
    header.addEventListener('click', () => card.classList.toggle('open'));

    // Body
    const body = document.createElement('div');
    body.className = 'q-body';

    if (!q.supported) {
      body.innerHTML = `
        <div style="color: var(--danger); font-size: 11px;">
          ⚠️ ${q.reason || 'This question type is unsupported for automated filling.'}
          ${q.required ? '<strong> (Required — Bulk run cannot proceed)</strong>' : ' (Optional — Will be skipped)'}
        </div>
      `;
    } else if ([QUESTION_TYPES.RADIO, QUESTION_TYPES.CHECKBOX, QUESTION_TYPES.DROPDOWN, QUESTION_TYPES.SCALE].includes(q.type)) {
      renderOptionWeightControls(q, body);
    } else if (q.type === QUESTION_TYPES.TEXT || q.type === QUESTION_TYPES.PARAGRAPH) {
      renderTextStrategyControls(q, body);
    }

    card.appendChild(header);
    card.appendChild(body);
    questionsContainer.appendChild(card);
  });
}

function renderOptionWeightControls(q, container) {
  const qConf = currentFormConfig.weightsConfig[q.id] || { weights: {} };
  qConf.isCheckbox = q.type === QUESTION_TYPES.CHECKBOX;
  qConf.isRequired = Boolean(q.required);
  qConf.type = q.type;
  currentFormConfig.weightsConfig[q.id] = qConf;

  // Question level actions
  const actionsBar = document.createElement('div');
  actionsBar.style.display = 'flex';
  actionsBar.style.justifyContent = 'flex-end';
  actionsBar.style.gap = '6px';
  actionsBar.style.marginBottom = '10px';

  const btnEqualize = document.createElement('button');
  btnEqualize.className = 'btn-small';
  btnEqualize.textContent = 'Equalize %';
  btnEqualize.addEventListener('click', () => {
    const equalVal = Math.floor(100 / (q.options.length || 1));
    q.options.forEach(opt => {
      qConf.weights[opt.id] = equalVal;
    });
    triggerAutoSave();
    updateOptionInputs(q, container);
  });

  const btnNormalize = document.createElement('button');
  btnNormalize.className = 'btn-small';
  btnNormalize.textContent = 'Normalize to 100%';
  btnNormalize.addEventListener('click', () => {
    const optList = q.options.map(opt => ({ id: opt.id, weight: qConf.weights[opt.id] ?? 0 }));
    const norm = normalizeWeights(optList);
    norm.forEach(n => { qConf.weights[n.id] = n.weight; });
    triggerAutoSave();
    updateOptionInputs(q, container);
  });

  actionsBar.appendChild(btnEqualize);
  actionsBar.appendChild(btnNormalize);
  container.appendChild(actionsBar);

  // Rows container
  const rowsBox = document.createElement('div');
  rowsBox.className = 'option-rows-box';

  q.options.forEach((opt, optIdx) => {
    const defaultWeight = q.type === QUESTION_TYPES.CHECKBOX ? 50 : Math.floor(100 / (q.options.length || 1));
    const existing = qConf.weights[opt.id] ?? (opt.slug ? qConf.weights[opt.slug] : undefined) ?? qConf.weights[opt.label] ?? qConf.weights[`opt_${optIdx}`];
    const curWeight = existing !== undefined ? existing : defaultWeight;
    qConf.weights[opt.id] = curWeight;

    const row = document.createElement('div');
    row.className = 'option-row';
    row.dataset.optId = opt.id;

    row.innerHTML = `
      <span class="opt-name" title="${opt.label}">${opt.label}</span>
      <input type="range" class="opt-slider" min="0" max="100" value="${curWeight}">
      <div class="opt-number-box">
        <input type="number" class="opt-number-input" min="0" max="100" value="${curWeight}">
        <span class="opt-percent-sign">%</span>
      </div>
    `;

    const slider = row.querySelector('.opt-slider');
    const numInput = row.querySelector('.opt-number-input');

    const updateWeight = (val) => {
      const clamped = Math.max(0, Math.min(100, Number(val) || 0));
      slider.value = clamped;
      numInput.value = clamped;
      qConf.weights[opt.id] = clamped;
      triggerAutoSave();
    };

    slider.addEventListener('input', (e) => updateWeight(e.target.value));
    numInput.addEventListener('change', (e) => updateWeight(e.target.value));

    rowsBox.appendChild(row);
  });

  container.appendChild(rowsBox);
}

function updateOptionInputs(q, container) {
  const qConf = currentFormConfig.weightsConfig[q.id] || { weights: {} };
  const rows = container.querySelectorAll('.option-row');
  rows.forEach(row => {
    const optId = row.dataset.optId;
    const w = qConf.weights[optId] ?? 0;
    const slider = row.querySelector('.opt-slider');
    const numInput = row.querySelector('.opt-number-input');
    if (slider) slider.value = w;
    if (numInput) numInput.value = w;
  });
}

function renderTextStrategyControls(q, container) {
  const qConf = currentFormConfig.textConfig[q.id] || {
    strategy: q.required ? TEXT_STRATEGIES.FIXED : TEXT_STRATEGIES.SKIP_IF_OPTIONAL,
    fixedText: '',
    answerPool: []
  };
  currentFormConfig.textConfig[q.id] = qConf;

  const group = document.createElement('div');
  group.className = 'text-strategy-group';

  group.innerHTML = `
    <label style="font-size: 11px; color: var(--text-secondary); font-weight: 600;">Answer Strategy:</label>
    <select class="strategy-select">
      <option value="${TEXT_STRATEGIES.FIXED}" ${qConf.strategy === TEXT_STRATEGIES.FIXED ? 'selected' : ''}>Fixed Answer Text</option>
      <option value="${TEXT_STRATEGIES.POOL}" ${qConf.strategy === TEXT_STRATEGIES.POOL ? 'selected' : ''}>Random from Answer Pool</option>
      ${!q.required ? `<option value="${TEXT_STRATEGIES.SKIP_IF_OPTIONAL}" ${qConf.strategy === TEXT_STRATEGIES.SKIP_IF_OPTIONAL ? 'selected' : ''}>Skip (Leave Blank)</option>` : ''}
      ${q.required ? `<option value="${TEXT_STRATEGIES.STOP_IF_REQUIRED}" ${qConf.strategy === TEXT_STRATEGIES.STOP_IF_REQUIRED ? 'selected' : ''}>Stop with Error if Required</option>` : ''}
    </select>
    <input type="text" class="strategy-input" placeholder="${qConf.strategy === TEXT_STRATEGIES.POOL ? 'Comma-separated pool (e.g. Yes, No, Maybe)' : 'Enter text answer here'}" value="${qConf.strategy === TEXT_STRATEGIES.POOL ? (qConf.answerPool || []).join(', ') : (qConf.fixedText || '')}">
  `;

  const select = group.querySelector('.strategy-select');
  const input = group.querySelector('.strategy-input');

  const refreshInputVisibility = () => {
    if (select.value === TEXT_STRATEGIES.SKIP_IF_OPTIONAL || select.value === TEXT_STRATEGIES.STOP_IF_REQUIRED) {
      input.style.display = 'none';
    } else {
      input.style.display = 'block';
      input.placeholder = select.value === TEXT_STRATEGIES.POOL ? 'Comma-separated pool (e.g. Option A, Option B)' : 'Enter text answer here';
    }
  };

  refreshInputVisibility();

  select.addEventListener('change', () => {
    qConf.strategy = select.value;
    refreshInputVisibility();
    triggerAutoSave();
  });

  input.addEventListener('input', () => {
    if (select.value === TEXT_STRATEGIES.POOL) {
      qConf.answerPool = input.value.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      qConf.fixedText = input.value;
    }
    triggerAutoSave();
  });

  container.appendChild(group);
}

// --- PRE-FLIGHT VALIDATION (REQUIREMENT 20) ---
function validateConfiguration() {
  const target = Number(inputTargetCount.value);
  if (isNaN(target) || target < 1 || target > 1000) {
    return { valid: false, reason: "Target submissions must be between 1 and 1,000." };
  }

  const delay = Number(inputDelaySec.value);
  if (isNaN(delay) || delay < 0) {
    return { valid: false, reason: "Delay between runs must be non-negative." };
  }

  if (!currentFormSchema || !currentFormSchema.questions) {
    return { valid: false, reason: "No Google Form detected on active tab. Open a form first." };
  }

  for (const q of currentFormSchema.questions) {
    // 1. Required unsupported question check
    if (q.required && !q.supported) {
      return {
        valid: false,
        reason: `Question "${q.title}" is required but unsupported (${q.reason || 'unsupported type'}). Cannot run bulk auto-fill.`
      };
    }

    // 2. Weighted questions check (at least one option must have weight > 0)
    if ([QUESTION_TYPES.RADIO, QUESTION_TYPES.CHECKBOX, QUESTION_TYPES.DROPDOWN, QUESTION_TYPES.SCALE].includes(q.type)) {
      const qConf = currentFormConfig.weightsConfig[q.id] || { weights: {} };
      let sum = 0;
      q.options.forEach(opt => {
        sum += (Number(qConf.weights[opt.id]) || 0);
      });
      if (sum <= 0) {
        return {
          valid: false,
          reason: `Question "${q.title}": All option weights are 0%. At least one option must have a weight greater than 0.`
        };
      }
    }

    // 3. Text questions check
    if (q.type === QUESTION_TYPES.TEXT || q.type === QUESTION_TYPES.PARAGRAPH) {
      const qText = currentFormConfig.textConfig[q.id] || {};
      if (q.required) {
        if (qText.strategy === TEXT_STRATEGIES.FIXED && !qText.fixedText?.trim()) {
          return {
            valid: false,
            reason: `Required text question "${q.title}" requires a fixed answer to be entered.`
          };
        }
        if (qText.strategy === TEXT_STRATEGIES.POOL && (!qText.answerPool || qText.answerPool.length === 0)) {
          return {
            valid: false,
            reason: `Required text question "${q.title}" requires at least one answer in the pool.`
          };
        }
        if (qText.strategy === TEXT_STRATEGIES.STOP_IF_REQUIRED || qText.strategy === TEXT_STRATEGIES.SKIP_IF_OPTIONAL) {
          return {
            valid: false,
            reason: `Question "${q.title}" is required and cannot be skipped. Select Fixed Answer or Pool.`
          };
        }
      }
    }
  }

  return { valid: true };
}

// --- BACKGROUND TELEMETRY & RUN SYNC ---
async function syncBackgroundState() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.GET_RUN_STATE });
    if (res && res.runState) {
      renderRunState(res.runState);
    }
  } catch (err) {
    console.warn('[GFAF] Background state query error:', err);
  }
}

function renderRunState(state) {
  if (!state) return;

  statusBadgeText.textContent = state.status;
  statusPill.className = `status-indicator ${state.status.toLowerCase()}`;

  runCounter.textContent = `${state.submittedCount} / ${state.targetCount}`;
  const pct = state.targetCount > 0 ? Math.min(100, Math.round((state.submittedCount / state.targetCount) * 100)) : 0;
  progressBar.style.width = `${pct}%`;

  if (state.statusText) {
    statusMessageText.textContent = state.statusText;
  }

  // Update button visibility according to state machine status
  switch (state.status) {
    case RUN_STATUS.FILLING:
    case RUN_STATUS.SUBMITTING:
    case RUN_STATUS.WAITING_FOR_CONFIRMATION:
    case RUN_STATUS.WAITING_DELAY:
    case RUN_STATUS.OPENING_FRESH_FORM:
      btnStartBulk.style.display = 'none';
      btnPauseBulk.style.display = 'inline-flex';
      btnResumeBulk.style.display = 'none';
      btnStopBulk.style.display = 'inline-flex';
      livePulse.style.display = 'inline-block';
      inputTargetCount.disabled = true;
      inputDelaySec.disabled = true;
      break;

    case RUN_STATUS.PAUSED:
      btnStartBulk.style.display = 'none';
      btnPauseBulk.style.display = 'none';
      btnResumeBulk.style.display = 'inline-flex';
      btnStopBulk.style.display = 'inline-flex';
      livePulse.style.display = 'none';
      inputTargetCount.disabled = true;
      inputDelaySec.disabled = true;
      break;

    case RUN_STATUS.COMPLETED:
    case RUN_STATUS.STOPPED:
    case RUN_STATUS.ERROR:
    case RUN_STATUS.IDLE:
    default:
      btnStartBulk.style.display = 'inline-flex';
      btnPauseBulk.style.display = 'none';
      btnResumeBulk.style.display = 'none';
      btnStopBulk.style.display = 'none';
      livePulse.style.display = 'none';
      inputTargetCount.disabled = false;
      inputDelaySec.disabled = false;
      break;
  }

  if (state.error) {
    showError(state.error);
  }
}

// --- USER CONTROL LISTENERS ---
function setupControlListeners() {
  btnRefreshForm.addEventListener('click', () => {
    detectActiveTabForm();
  });

  inputTargetCount.addEventListener('change', triggerAutoSave);
  inputDelaySec.addEventListener('change', triggerAutoSave);

  btnDismissError.addEventListener('click', () => {
    errorBanner.style.display = 'none';
  });

  // Start Bulk Run
  btnStartBulk.addEventListener('click', async () => {
    hideError();
    await saveFormConfigNow();

    const validation = validateConfiguration();
    if (!validation.valid) {
      showError(validation.reason);
      return;
    }

    const payload = {
      tabId: activeTab.id,
      formId: currentFormSchema.formId,
      formUrl: currentFormSchema.formUrl,
      targetCount: Number(inputTargetCount.value) || 1,
      delaySec: Number(inputDelaySec.value) >= 0 ? Number(inputDelaySec.value) : 3,
      weightsConfig: currentFormConfig.weightsConfig,
      textConfig: currentFormConfig.textConfig
    };

    chrome.runtime.sendMessage({ type: MSG.START_BULK_RUN, payload }, (res) => {
      if (res && res.runState) renderRunState(res.runState);
    });
  });

  // Pause
  btnPauseBulk.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: MSG.PAUSE_BULK_RUN }, (res) => {
      if (res && res.runState) renderRunState(res.runState);
    });
  });

  // Resume
  btnResumeBulk.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: MSG.RESUME_BULK_RUN }, (res) => {
      if (res && res.runState) renderRunState(res.runState);
    });
  });

  // Stop
  btnStopBulk.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: MSG.STOP_BULK_RUN }, (res) => {
      if (res && res.runState) renderRunState(res.runState);
    });
  });

  // Quick Test Fill (1-Click Fill without submit)
  btnQuickFill.addEventListener('click', async () => {
    hideError();
    await saveFormConfigNow();

    if (!activeTab || !currentFormSchema) {
      showError('Please open a Google Form or Mock Form on the active tab.');
      return;
    }

    try {
      btnQuickFill.textContent = 'Filling...';
      const res = await chrome.tabs.sendMessage(activeTab.id, {
        type: MSG.FILL_CURRENT_FORM,
        weightsConfig: currentFormConfig.weightsConfig,
        textConfig: currentFormConfig.textConfig
      });

      btnQuickFill.innerHTML = '<span class="btn-icon-symbol">✏️</span> Test Fill Current Form';

      if (res && res.success && res.fillResults) {
        quickResultsBox.style.display = 'block';
        quickResultsList.innerHTML = '';
        res.fillResults.forEach(item => {
          const div = document.createElement('div');
          div.className = 'result-item';
          const selVal = item.selected ? (Array.isArray(item.selected) ? item.selected.join(', ') : item.selected) : (item.text || 'Skipped');
          div.innerHTML = `
            <span class="q-title">${item.title}</span>
            <span class="q-val">${selVal}</span>
          `;
          quickResultsList.appendChild(div);
        });
      } else {
        showError(res?.error || 'Quick fill failed.');
      }
    } catch (err) {
      btnQuickFill.innerHTML = '<span class="btn-icon-symbol">✏️</span> Test Fill Current Form';
      showError('Failed to fill form: ' + err.message);
    }
  });

  // Equalize All
  btnEqualizeAll.addEventListener('click', () => {
    if (!currentFormSchema) return;
    currentFormSchema.questions.forEach(q => {
      if ([QUESTION_TYPES.RADIO, QUESTION_TYPES.CHECKBOX, QUESTION_TYPES.DROPDOWN, QUESTION_TYPES.SCALE].includes(q.type)) {
        const qConf = currentFormConfig.weightsConfig[q.id] || { weights: {} };
        const equalVal = Math.floor(100 / (q.options.length || 1));
        q.options.forEach(opt => { qConf.weights[opt.id] = equalVal; });
        currentFormConfig.weightsConfig[q.id] = qConf;
      }
    });
    triggerAutoSave();
    renderQuestions(currentFormSchema.questions);
  });

  // Reset Weights
  btnResetWeights.addEventListener('click', () => {
    if (!currentFormSchema) return;
    currentFormConfig.weightsConfig = {};
    currentFormConfig.textConfig = {};
    triggerAutoSave();
    renderQuestions(currentFormSchema.questions);
  });
}

function showError(msg) {
  errorText.textContent = msg;
  errorBanner.style.display = 'flex';
}

function hideError() {
  errorBanner.style.display = 'none';
}
