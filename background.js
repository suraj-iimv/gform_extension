/**
 * Google Form Auto-Filler — Background Service Worker
 * Explicit state machine for resilient bulk execution.
 * Completely independent of popup lifecycle.
 */

import { MSG, RUN_STATUS, TIMEOUTS, STORAGE_KEYS } from './lib/constants.js';
import { generateBatchPlan, generateCheckboxBatchPlan } from './lib/selection-engine.js';

// --- LOGGING ---
const LOG_PREFIX = '[GFAF-BG]';
const Logger = {
  debug: (...args) => console.debug(LOG_PREFIX, ...args),
  info: (...args) => console.info(LOG_PREFIX, ...args),
  warn: (...args) => console.warn(LOG_PREFIX, ...args),
  error: (...args) => console.error(LOG_PREFIX, ...args)
};

// --- RUN STATE ---
let runState = {
  active: false,
  status: RUN_STATUS.IDLE,
  tabId: null,
  formId: null,
  formUrl: null,
  targetCount: 1,
  submittedCount: 0,
  currentIteration: 0,
  delaySec: 3,
  delayRemaining: 0,
  weightsConfig: {},
  textConfig: {},
  batchPlans: {},
  statusText: "Ready to start",
  error: null,
  pauseRequested: false,
  startedAt: null,
  updatedAt: Date.now()
};

let delayTimer = null;
let watchdogTimer = null;

/**
 * Persists current run state to chrome.storage.local after every state transition.
 */
async function persistState() {
  runState.updatedAt = Date.now();
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.RUN_STATE]: runState });
    Logger.debug(`State persisted: ${runState.status} (${runState.submittedCount}/${runState.targetCount})`);
  } catch (err) {
    Logger.error('Failed to persist state:', err);
  }
}

/**
 * Recovers run state from chrome.storage.local upon Service Worker startup.
 */
async function recoverState() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.RUN_STATE);
    if (data && data[STORAGE_KEYS.RUN_STATE]) {
      const saved = data[STORAGE_KEYS.RUN_STATE];
      Logger.info('Recovered state from storage:', saved.status, `Active: ${saved.active}`);

      // If it was in progress when SW went down
      if (saved.active) {
        runState = { ...saved };
        // Check if tab still exists
        try {
          const tab = await chrome.tabs.get(runState.tabId);
          if (tab) {
            Logger.info(`Tab ${runState.tabId} still exists. Handling active state: ${runState.status}`);
            if (runState.status === RUN_STATUS.WAITING_DELAY) {
              startDelayCountdown();
            } else if (runState.status === RUN_STATUS.OPENING_FRESH_FORM || runState.status === RUN_STATUS.FILLING) {
              executeNextIteration();
            }
            return;
          }
        } catch (e) {
          Logger.warn(`Target tab ${runState.tabId} is no longer available.`);
          runState.active = false;
          runState.status = RUN_STATUS.ERROR;
          runState.error = "Target form tab was closed.";
          runState.statusText = "Error: Target tab was closed.";
          await persistState();
        }
      } else {
        runState = { ...runState, ...saved };
      }
    }
  } catch (err) {
    Logger.error('Error recovering state:', err);
  }
}

/**
 * Transition the state machine to a new status.
 */
async function transitionTo(newStatus, statusText, error = null) {
  Logger.info(`Transition: ${runState.status} -> ${newStatus} | "${statusText}"`);
  runState.status = newStatus;
  if (statusText) runState.statusText = statusText;
  if (error) runState.error = error;
  await persistState();
}

/**
 * Starts execution of a bulk run.
 */
async function startBulkRun({ tabId, formId, formUrl, targetCount, delaySec, weightsConfig, textConfig }) {
  if (runState.active) {
    Logger.warn('A run is already active. Ignoring start request.');
    return;
  }

  // Clear any existing timers
  if (delayTimer) clearInterval(delayTimer);
  if (watchdogTimer) clearTimeout(watchdogTimer);

  const targetNumber = Number(targetCount) || 1;

  // Pre-generate exact quota batch plans for each question to ensure 100% weight accuracy
  const batchPlans = {};
  if (weightsConfig) {
    for (const [qId, qConf] of Object.entries(weightsConfig)) {
      if (qConf && qConf.weights) {
        const optList = Object.entries(qConf.weights).map(([optId, weight]) => ({
          id: optId,
          weight: Number(weight) || 0
        }));

        if (optList.length > 0) {
          if (qConf.isCheckbox) {
            batchPlans[qId] = generateCheckboxBatchPlan(optList, targetNumber, Boolean(qConf.isRequired));
          } else {
            batchPlans[qId] = generateBatchPlan(optList, targetNumber);
          }
        }
      }
    }
  }

  runState = {
    active: true,
    status: RUN_STATUS.FILLING,
    tabId,
    formId,
    formUrl,
    targetCount: targetNumber,
    submittedCount: 0,
    currentIteration: 1,
    delaySec: Number(delaySec) >= 0 ? Number(delaySec) : 3,
    delayRemaining: 0,
    weightsConfig: weightsConfig || {},
    textConfig: textConfig || {},
    batchPlans,
    statusText: `1 / ${targetNumber} — Filling form...`,
    error: null,
    pauseRequested: false,
    startedAt: Date.now(),
    updatedAt: Date.now()
  };

  await persistState();
  Logger.info(`Bulk run started: Target ${runState.targetCount} iterations, delay ${runState.delaySec}s`);

  // Trigger first iteration
  triggerFillAndSubmit();
}

/**
 * Instructs content script on active tab to fill and submit the form.
 */
async function triggerFillAndSubmit() {
  if (!runState.active || runState.status === RUN_STATUS.PAUSED || runState.status === RUN_STATUS.STOPPED) {
    return;
  }

  await transitionTo(
    RUN_STATUS.FILLING,
    `${runState.submittedCount + 1} / ${runState.targetCount} — Filling form...`
  );

  // Set watchdog timeout for the submission attempt
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(async () => {
    if (runState.status === RUN_STATUS.FILLING || runState.status === RUN_STATUS.SUBMITTING || runState.status === RUN_STATUS.WAITING_FOR_CONFIRMATION) {
      Logger.error('Watchdog timeout: Submission process took too long.');
      await transitionTo(
        RUN_STATUS.ERROR,
        `${runState.submittedCount} / ${runState.targetCount} — Error: Form submission timed out.`,
        "Form submission timed out after 30 seconds."
      );
      runState.active = false;
      await persistState();
    }
  }, 35000);

  // Extract planned selections for current iteration index
  const plannedSelections = {};
  if (runState.batchPlans) {
    const iterIdx = runState.submittedCount;
    for (const [qId, plan] of Object.entries(runState.batchPlans)) {
      if (Array.isArray(plan) && plan[iterIdx] !== undefined) {
        const item = plan[iterIdx];
        plannedSelections[qId] = item?.id ? item.id : item;
      }
    }
  }

  try {
    const res = await chrome.tabs.sendMessage(runState.tabId, {
      type: MSG.EXECUTE_FILL_AND_SUBMIT,
      weightsConfig: runState.weightsConfig,
      textConfig: runState.textConfig,
      plannedSelections
    });

    if (res && res.error) {
      throw new Error(res.error);
    }
  } catch (err) {
    // If message channel closed because form submitted and page navigated, this is normal behavior!
    if (err.message && err.message.includes("message channel closed")) {
      Logger.debug("Message channel closed during submission navigation; awaiting confirmation.");
      return;
    }
    Logger.error('Failed to communicate with content script during fill & submit:', err);
    if (watchdogTimer) clearTimeout(watchdogTimer);
    await transitionTo(
      RUN_STATUS.ERROR,
      `${runState.submittedCount} / ${runState.targetCount} — Error: Cannot connect to form tab.`,
      err.message
    );
    runState.active = false;
    await persistState();
  }
}

/**
 * Handles confirmation detected event from content script or URL observer.
 * Strictly increments submittedCount ONLY here!
 */
async function handleConfirmationDetected() {
  if (watchdogTimer) clearTimeout(watchdogTimer);

  if (!runState.active) {
    Logger.warn('Received confirmation but run is not active.');
    return;
  }

  // Guard against duplicate confirmation calls within the same iteration
  if (runState.status !== RUN_STATUS.FILLING && 
      runState.status !== RUN_STATUS.SUBMITTING && 
      runState.status !== RUN_STATUS.WAITING_FOR_CONFIRMATION) {
    Logger.debug('Ignoring redundant confirmation detected in status:', runState.status);
    return;
  }

  // Strictly increment count after confirmation
  runState.submittedCount++;
  Logger.info(`Submission successfully confirmed! Count: ${runState.submittedCount} / ${runState.targetCount}`);

  // Check if target reached
  if (runState.submittedCount >= runState.targetCount) {
    runState.active = false;
    await transitionTo(
      RUN_STATUS.COMPLETED,
      `Completed ${runState.submittedCount} / ${runState.targetCount} submissions successfully!`
    );
    return;
  }

  // Check if user requested pause during this submission
  if (runState.pauseRequested) {
    runState.pauseRequested = false;
    await transitionTo(
      RUN_STATUS.PAUSED,
      `Paused at ${runState.submittedCount} / ${runState.targetCount}. Click Resume to continue.`
    );
    return;
  }

  // Transition to WAITING_DELAY
  await transitionTo(
    RUN_STATUS.WAITING_DELAY,
    `${runState.submittedCount} / ${runState.targetCount} submitted — Waiting ${runState.delaySec}s...`
  );

  startDelayCountdown();
}

/**
 * Handles delay countdown before next submission.
 */
function startDelayCountdown() {
  if (delayTimer) clearInterval(delayTimer);

  runState.delayRemaining = runState.delaySec;
  persistState();

  if (runState.delaySec <= 0) {
    prepareFreshForm();
    return;
  }

  delayTimer = setInterval(async () => {
    runState.delayRemaining--;

    if (runState.status === RUN_STATUS.PAUSED || !runState.active) {
      clearInterval(delayTimer);
      return;
    }

    if (runState.delayRemaining <= 0) {
      clearInterval(delayTimer);
      prepareFreshForm();
    } else {
      runState.statusText = `${runState.submittedCount} / ${runState.targetCount} submitted — Waiting ${runState.delayRemaining}s...`;
      await persistState();
    }
  }, 1000);
}

/**
 * Navigates to a fresh copy of the form.
 */
async function prepareFreshForm() {
  if (!runState.active || runState.status === RUN_STATUS.PAUSED) return;

  runState.currentIteration = runState.submittedCount + 1;
  await transitionTo(
    RUN_STATUS.OPENING_FRESH_FORM,
    `${runState.currentIteration} / ${runState.targetCount} — Loading fresh form...`
  );

  const cleanFormUrl = (runState.formUrl || '').replace(/\/formResponse(\?.*)?$/, '/viewform$1');

  try {
    const res = await chrome.tabs.sendMessage(runState.tabId, {
      type: MSG.NAVIGATE_FRESH_FORM,
      formUrl: cleanFormUrl
    });
    if (!res || !res.success) {
      Logger.info('Content script navigation returned false, updating tab directly:', cleanFormUrl);
      chrome.tabs.update(runState.tabId, { url: cleanFormUrl });
    }
  } catch (err) {
    Logger.info('Content script not responsive on confirmation page, navigating tab directly:', cleanFormUrl);
    chrome.tabs.update(runState.tabId, { url: cleanFormUrl });
  }
}

/**
 * Invoked when fresh form is confirmed ready by content script or tab reload.
 */
async function handleFreshFormReady() {
  if (!runState.active || runState.status === RUN_STATUS.PAUSED) return;

  // Guard: Only handle if we are currently expecting fresh form!
  if (runState.status !== RUN_STATUS.OPENING_FRESH_FORM && runState.status !== RUN_STATUS.WAITING_DELAY) {
    Logger.debug('Ignoring FRESH_FORM_READY in status:', runState.status);
    return;
  }

  Logger.info('Fresh form confirmed ready. Starting next fill...');
  // Short pause to ensure all JS libraries on Google Form initialize
  setTimeout(() => {
    triggerFillAndSubmit();
  }, 500);
}

/**
 * Pauses an active run.
 */
async function pauseBulkRun() {
  if (!runState.active) return;

  if (runState.status === RUN_STATUS.WAITING_DELAY) {
    if (delayTimer) clearInterval(delayTimer);
    await transitionTo(
      RUN_STATUS.PAUSED,
      `Paused at ${runState.submittedCount} / ${runState.targetCount}. Click Resume to continue.`
    );
  } else {
    // Current iteration is filling/submitting; finish it then pause
    runState.pauseRequested = true;
    runState.statusText = `${runState.submittedCount} / ${runState.targetCount} — Pausing after current submission...`;
    await persistState();
  }
}

/**
 * Resumes a paused run.
 */
async function resumeBulkRun() {
  if (!runState.active || runState.status !== RUN_STATUS.PAUSED) return;

  Logger.info('Resuming bulk run...');
  runState.pauseRequested = false;
  prepareFreshForm();
}

/**
 * Stops an active run immediately and safely preserves configuration.
 */
async function stopBulkRun() {
  Logger.info('Stopping bulk run on user request...');
  if (delayTimer) clearInterval(delayTimer);
  if (watchdogTimer) clearTimeout(watchdogTimer);

  runState.active = false;
  runState.pauseRequested = false;
  await transitionTo(
    RUN_STATUS.STOPPED,
    `Run stopped by user. (${runState.submittedCount} / ${runState.targetCount} completed)`
  );
}

// --- MESSAGE LISTENER ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  Logger.debug('Received background message:', message.type);

  switch (message.type) {
    case MSG.GET_RUN_STATE:
      sendResponse({ runState });
      return false;

    case MSG.START_BULK_RUN:
      startBulkRun(message.payload);
      sendResponse({ success: true, runState });
      return false;

    case MSG.STOP_BULK_RUN:
      stopBulkRun();
      sendResponse({ success: true, runState });
      return false;

    case MSG.PAUSE_BULK_RUN:
      pauseBulkRun();
      sendResponse({ success: true, runState });
      return false;

    case MSG.RESUME_BULK_RUN:
      resumeBulkRun();
      sendResponse({ success: true, runState });
      return false;

    case MSG.SUBMISSION_STARTED:
      transitionTo(
        RUN_STATUS.SUBMITTING,
        `${runState.submittedCount + 1} / ${runState.targetCount} — Submitting response...`
      );
      return false;

    case MSG.CONFIRMATION_DETECTED:
      handleConfirmationDetected();
      return false;

    case MSG.FRESH_FORM_READY:
      handleFreshFormReady();
      return false;

    case MSG.AUTOMATION_ERROR:
      if (watchdogTimer) clearTimeout(watchdogTimer);
      if (delayTimer) clearInterval(delayTimer);
      runState.active = false;
      transitionTo(
        RUN_STATUS.ERROR,
        `${runState.submittedCount} / ${runState.targetCount} — Error: ${message.error || 'Automation failure'}`,
        message.error
      );
      return false;

    default:
      return false;
  }
});

// Tab navigation listener fallback
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (runState.active && tabId === runState.tabId && changeInfo.status === 'complete') {
    Logger.info(`Tab ${tabId} navigation completed: ${tab.url}`);

    // If we were submitting and tab navigated to confirmation page (/formResponse)
    if (runState.status === RUN_STATUS.SUBMITTING || runState.status === RUN_STATUS.FILLING) {
      if (tab.url && tab.url.includes('/formResponse')) {
        Logger.info('Detected /formResponse URL in onUpdated listener!');
        handleConfirmationDetected();
        return;
      }
    }

    // If we were opening fresh form and tab loaded /viewform
    if (runState.status === RUN_STATUS.OPENING_FRESH_FORM) {
      if (tab.url && (tab.url.includes('/viewform') || !tab.url.includes('/formResponse'))) {
        Logger.info('Fresh form loaded via tab navigation.');
        setTimeout(() => {
          handleFreshFormReady();
        }, 500);
      }
    }
  }
});

// Recover state on service worker wakeup
recoverState();
