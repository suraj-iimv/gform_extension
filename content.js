/**
 * Google Form Auto-Filler — Content Script
 * Implements the DOM selector abstraction layer, question schema scanner,
 * weighted form filler, and submission/confirmation observer.
 */

(() => {
  // Prevent multiple injections
  if (window.__GFAF_CONTENT_INJECTED__) return;
  window.__GFAF_CONTENT_INJECTED__ = true;

  // --- LOGGING UTILITY ---
  const LOG_PREFIX = '[GFAF]';
  const Logger = {
    debug: (...args) => console.debug(LOG_PREFIX, ...args),
    warn: (...args) => console.warn(LOG_PREFIX, ...args),
    error: (...args) => console.error(LOG_PREFIX, ...args),
    info: (...args) => console.info(LOG_PREFIX, ...args)
  };

  Logger.info('Content script loaded on', window.location.href);

  // --- MESSAGE & STATUS CONSTANTS ---
  const MSG = {
    GET_FORM_SCHEMA: "GFAF_GET_FORM_SCHEMA",
    FILL_CURRENT_FORM: "GFAF_FILL_CURRENT_FORM",
    FORM_SCHEMA_RESPONSE: "GFAF_FORM_SCHEMA_RESPONSE",
    FILL_COMPLETED: "GFAF_FILL_COMPLETED",
    SUBMISSION_STARTED: "GFAF_SUBMISSION_STARTED",
    CONFIRMATION_DETECTED: "GFAF_CONFIRMATION_DETECTED",
    FRESH_FORM_READY: "GFAF_FRESH_FORM_READY",
    AUTOMATION_ERROR: "GFAF_AUTOMATION_ERROR",
    EXECUTE_FILL_AND_SUBMIT: "GFAF_EXECUTE_FILL_AND_SUBMIT",
    NAVIGATE_FRESH_FORM: "GFAF_NAVIGATE_FRESH_FORM"
  };

  const QUESTION_TYPES = {
    RADIO: "radio",
    CHECKBOX: "checkbox",
    DROPDOWN: "dropdown",
    SCALE: "scale",
    TEXT: "text",
    PARAGRAPH: "paragraph",
    DATE: "date",
    UNSUPPORTED: "unsupported"
  };

  const TEXT_STRATEGIES = {
    FIXED: "fixed",
    POOL: "pool",
    SKIP_IF_OPTIONAL: "skip_if_optional",
    STOP_IF_REQUIRED: "stop_if_required"
  };

  const TIMEOUTS = {
    WAIT_FOR_FORM_MS: 15000,
    WAIT_FOR_SUBMIT_MS: 10000,
    WAIT_FOR_CONFIRMATION_MS: 20000,
    WAIT_FOR_FRESH_FORM_MS: 20000
  };

  // --- FORM IDENTIFIER UTILITY ---
  function getFormIdentifier(url = window.location.href, doc = document) {
    try {
      const parsed = new URL(url);
      const eMatch = parsed.pathname.match(/\/forms\/(?:u\/\d+\/)?d\/e\/([a-zA-Z0-9_-]+)/);
      if (eMatch && eMatch[1]) return `gform_${eMatch[1]}`;

      const dMatch = parsed.pathname.match(/\/forms\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
      if (dMatch && dMatch[1]) return `gform_${dMatch[1]}`;

      if (doc) {
        const formEl = doc.querySelector('form[action*="/forms/d/e/"]');
        if (formEl) {
          const actionMatch = (formEl.getAttribute('action') || '').match(/\/forms\/d\/e\/([a-zA-Z0-9_-]+)/);
          if (actionMatch && actionMatch[1]) return `gform_${actionMatch[1]}`;
        }
        const heading = doc.querySelector('h1#formTitle, h1');
        if (heading && heading.textContent.trim()) {
          const cleanTitle = heading.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
          return `mock_${cleanTitle}`;
        }
      }
      const cleanPath = (parsed.origin + parsed.pathname).replace(/\/formResponse$/, '/viewform');
      return `url_${cleanPath.replace(/[^a-zA-Z0-9]+/g, '_')}`;
    } catch (err) {
      return 'default_form_id';
    }
  }

  // --- SELECTION ENGINE (WEIGHTED ALGORITHMS) ---
  function validateWeights(weightedOptions) {
    if (!weightedOptions || weightedOptions.length === 0) {
      return { valid: false, sum: 0, max: 0, eligible: [], error: "No options provided" };
    }
    let sum = 0;
    let max = 0;
    const eligible = [];
    for (const item of weightedOptions) {
      const raw = Number(item.weight);
      const w = isNaN(raw) || raw < 0 ? 0 : raw;
      if (w > 0) {
        eligible.push({ ...item, weight: w });
        sum += w;
        if (w > max) max = w;
      }
    }
    if (sum <= 0 || eligible.length === 0) {
      return { valid: false, sum: 0, max: 0, eligible: [], error: "All option weights are zero or negative" };
    }
    return { valid: true, sum, max, eligible };
  }

  function selectWeightedSingleOption(options) {
    const { valid, sum, eligible, error } = validateWeights(options);
    if (!valid) return { selectedOption: null, error };
    const rand = Math.random() * sum;
    let cumulative = 0;
    for (const opt of eligible) {
      cumulative += opt.weight;
      if (rand < cumulative) {
        return { selectedOption: opt };
      }
    }
    return { selectedOption: eligible[eligible.length - 1] };
  }

  function selectWeightedCheckboxOptions(options, isRequired = false) {
    const { valid, sum, max, eligible, error } = validateWeights(options);
    if (!valid) return { selectedOptions: [], error };
    const selectedOptions = [];
    const scale = max > 100 ? max : 100;
    for (const opt of eligible) {
      const p = Math.min(1.0, Math.max(0.01, opt.weight / scale));
      if (Math.random() < p) {
        selectedOptions.push(opt);
      }
    }
    if (isRequired && selectedOptions.length === 0) {
      const single = selectWeightedSingleOption(eligible);
      if (single.selectedOption) {
        selectedOptions.push(single.selectedOption);
      }
    }
    return { selectedOptions };
  }

  function resolveTextAnswer(question, config) {
    const strategy = config?.strategy || (question.required ? TEXT_STRATEGIES.STOP_IF_REQUIRED : TEXT_STRATEGIES.SKIP_IF_OPTIONAL);
    switch (strategy) {
      case TEXT_STRATEGIES.FIXED: {
        const val = config?.fixedText != null ? String(config.fixedText).trim() : '';
        if (question.required && !val) {
          return { value: null, skip: false, error: `Required question "${question.title}" has no fixed text.` };
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
        return { value: pool[Math.floor(Math.random() * pool.length)], skip: false };
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
          return { value: null, skip: false, error: `Required question "${question.title}" needs a text strategy configured.` };
        }
        return { value: null, skip: true };
      }
    }
  }

  // --- SELECTOR ABSTRACTION LAYER ---

  /**
   * Finds all question containers using semantic roles first, falling back to known classes.
   * @returns {HTMLElement[]}
   */
  function findQuestionContainers() {
    // 1. Semantic list items
    const roleItems = Array.from(document.querySelectorAll('[role="listitem"]'));
    if (roleItems.length > 0) return roleItems;

    // 2. Data attributes
    const dataItems = Array.from(document.querySelectorAll('div[data-item-id]'));
    if (dataItems.length > 0) return dataItems;

    // 3. Known Google Forms class names
    const classItems = Array.from(document.querySelectorAll('.Qr7Oae, .geS5n'));
    if (classItems.length > 0) return classItems;

    // 4. Cards containing headings
    const cardItems = Array.from(document.querySelectorAll('.question-card'));
    return cardItems;
  }

  /**
   * Identifies question type strictly using ARIA roles and semantic controls.
   * @param {HTMLElement} container
   * @returns {string} One of QUESTION_TYPES
   */
  function findQuestionType(container) {
    if (!container) return QUESTION_TYPES.UNSUPPORTED;

    // Linear scale check (radiogroup containing numbered radio controls or scale-container)
    const scaleContainer = container.querySelector('.scale-container, [data-scale="true"]');
    if (scaleContainer) return QUESTION_TYPES.SCALE;

    const radioGroup = container.querySelector('[role="radiogroup"]');
    if (radioGroup) {
      // Check if radio options are numbered scale points (1..5 or 1..10)
      const radios = Array.from(radioGroup.querySelectorAll('[role="radio"]'));
      const isScale = radios.length >= 2 && radios.every(r => {
        const txt = (r.textContent || '').trim();
        return /^\d+$/.test(txt);
      });
      if (isScale) return QUESTION_TYPES.SCALE;
      return QUESTION_TYPES.RADIO;
    }

    // Checkbox question
    const checkboxes = container.querySelectorAll('[role="checkbox"]');
    if (checkboxes.length > 0) return QUESTION_TYPES.CHECKBOX;

    // Dropdown / listbox
    const listbox = container.querySelector('[role="listbox"], select');
    if (listbox) return QUESTION_TYPES.DROPDOWN;

    // Textarea / paragraph
    const textarea = container.querySelector('textarea, [role="textbox"][aria-multiline="true"]');
    if (textarea) return QUESTION_TYPES.PARAGRAPH;

    // Short answer text
    const textInput = container.querySelector('input[type="text"], input:not([type]), [role="textbox"]');
    if (textInput) {
      if (textInput.getAttribute('type') === 'date') return QUESTION_TYPES.DATE;
      return QUESTION_TYPES.TEXT;
    }

    // Check for unsupported elements (file upload, grid, etc.)
    if (container.querySelector('input[type="file"], [role="grid"], .freebirdFormviewerComponentsQuestionGridRoot')) {
      return QUESTION_TYPES.UNSUPPORTED;
    }

    return QUESTION_TYPES.UNSUPPORTED;
  }

  /**
   * Extracts question title and required status.
   * @param {HTMLElement} container
   * @returns {{ title: string, required: boolean }}
   */
  function getQuestionMetadata(container) {
    const heading = container.querySelector('[role="heading"], [aria-level], .M4dnbe, .HoFDJf, .question-title, label');
    let title = "Untitled Question";
    if (heading) {
      // Clone heading to extract clean text without the '*' required marker
      const clone = heading.cloneNode(true);
      clone.querySelectorAll('.required-star, [aria-label*="Required"], [aria-hidden="true"]').forEach(el => {
        if (el.textContent.trim() === '*') el.remove();
      });
      title = clone.textContent.trim().replace(/\s*\*\s*$/, '') || "Untitled Question";
    }

    // Determine if required
    let required = false;
    if (container.querySelector('[aria-required="true"], .required-star, [aria-label*="Required"]')) {
      required = true;
    } else if (heading && heading.textContent.includes('*')) {
      required = true;
    }

    return { title, required };
  }

  /**
   * Extracts options for choice-based questions.
   * @param {HTMLElement} container
   * @param {string} type
   * @returns {Array<{ id: string, label: string, value: string, element: HTMLElement }>}
   */
  /**
   * Helper to extract real option label from Google Forms DOM.
   * Looks at aria-label, data-value, and sibling .aDTYNe / .vd3tt labels.
   */
  function getOptionLabel(el, idx) {
    // 1. aria-label or data-value on control
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();

    const val = el.getAttribute('data-value');
    if (val && val.trim()) return val.trim();

    // 2. Parent container (.docssharedWizToggleLabeledContainer, label, or parent)
    const container = el.closest('.docssharedWizToggleLabeledContainer, label, .nWQ3Fs, [role="presentation"]') || el.parentElement;
    if (container) {
      const textEl = container.querySelector('.aDTYNe, .vd3tt, .option-label, .ulDsOb, .Ce6Nac');
      if (textEl && textEl.textContent.trim()) {
        return textEl.textContent.trim();
      }

      // Clone container and remove control elements to read remaining text
      const clone = container.cloneNode(true);
      clone.querySelectorAll('[role="radio"], [role="checkbox"], svg, img').forEach(n => n.remove());
      const txt = clone.textContent.trim();
      if (txt) return txt;
    }

    // 3. Inside element if custom
    const inner = el.querySelector('.option-label, span');
    if (inner && inner.textContent.trim()) {
      return inner.textContent.trim();
    }

    return `Option ${idx + 1}`;
  }

  /**
   * Generates a stable slug from string.
   */
  function cleanSlug(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 35);
  }

  /**
   * Generates a stable question identifier across DOM reloads.
   */
  function getQuestionIdentifier(container, title, idx) {
    const dataId = container.getAttribute('data-question-id') || container.getAttribute('data-item-id');
    if (dataId) return `qid_${dataId}`;
    if (title && title !== 'Untitled Question') {
      const slug = cleanSlug(title);
      if (slug) return `q_${slug}`;
    }
    return `q_${idx}`;
  }

  /**
   * Resolves the weight for an option, checking all possible keys.
   */
  function resolveOptionWeight(qConfig, opt, totalOptions, idx) {
    if (!qConfig || !qConfig.weights) {
      return Math.floor(100 / (totalOptions || 1));
    }
    const w = qConfig.weights;

    if (opt.id && w[opt.id] !== undefined) return Number(w[opt.id]);
    if (opt.slug && w[opt.slug] !== undefined) return Number(w[opt.slug]);
    if (opt.label && w[opt.label] !== undefined) return Number(w[opt.label]);
    if (opt.value && w[opt.value] !== undefined) return Number(w[opt.value]);
    if (w[`opt_${idx}`] !== undefined) return Number(w[`opt_${idx}`]);
    if (w[`chk_${idx}`] !== undefined) return Number(w[`chk_${idx}`]);
    if (w[`drop_${idx}`] !== undefined) return Number(w[`drop_${idx}`]);

    // If other options in this question have weights, unlisted option defaults to 0%
    const hasAnyWeight = Object.values(w).some(val => Number(val) > 0);
    if (hasAnyWeight) return 0;

    return Math.floor(100 / (totalOptions || 1));
  }

  /**
   * Extracts options for choice-based questions.
   * @param {HTMLElement} container
   * @param {string} type
   * @returns {Array<{ id: string, slug: string, label: string, value: string, element: HTMLElement, index: number }>}
   */
  function getQuestionOptions(container, type) {
    const options = [];

    if (type === QUESTION_TYPES.RADIO || type === QUESTION_TYPES.SCALE) {
      const radioEls = Array.from(container.querySelectorAll('[role="radio"]'));
      radioEls.forEach((el, idx) => {
        const val = el.getAttribute('data-value') || el.getAttribute('value') || `opt_${idx}`;
        const label = getOptionLabel(el, idx);
        const slug = cleanSlug(label);
        const id = slug ? `opt_${slug}` : `opt_${idx}`;
        options.push({ id, slug, label, value: val, element: el, index: idx });
      });
    } else if (type === QUESTION_TYPES.CHECKBOX) {
      const chkEls = Array.from(container.querySelectorAll('[role="checkbox"]'));
      chkEls.forEach((el, idx) => {
        const val = el.getAttribute('data-value') || el.getAttribute('value') || `chk_${idx}`;
        const label = getOptionLabel(el, idx);
        const slug = cleanSlug(label);
        const id = slug ? `opt_${slug}` : `opt_${idx}`;
        options.push({ id, slug, label, value: val, element: el, index: idx });
      });
    } else if (type === QUESTION_TYPES.DROPDOWN) {
      const select = container.querySelector('select');
      if (select) {
        const optEls = Array.from(select.querySelectorAll('option'));
        optEls.forEach((el, idx) => {
          if (el.disabled || !el.value) return; // Skip placeholder
          const label = el.textContent.trim() || `Option ${idx + 1}`;
          const slug = cleanSlug(label);
          options.push({
            id: slug ? `opt_${slug}` : `drop_${idx}`,
            slug,
            label,
            value: el.value,
            element: el,
            index: idx
          });
        });
      } else {
        const listbox = container.querySelector('[role="listbox"]');
        if (listbox) {
          const items = Array.from(listbox.querySelectorAll('[role="option"]'));
          items.forEach((el, idx) => {
            const label = el.textContent.trim() || `Option ${idx + 1}`;
            const slug = cleanSlug(label);
            options.push({
              id: slug ? `opt_${slug}` : `drop_${idx}`,
              slug,
              label,
              value: el.getAttribute('data-value') || label,
              element: el,
              index: idx
            });
          });
        }
      }
    }

    return options;
  }

  /**
   * Finds the form submission button using accessible semantic roles and submit keywords.
   * @returns {HTMLElement | null}
   */
  function findSubmitButton() {
    // 1. Submit input or button
    const directBtn = document.querySelector('button[type="submit"], input[type="submit"]');
    if (directBtn && directBtn.offsetParent !== null) return directBtn;

    // 2. Buttons with role="button" matching submit patterns
    const roleButtons = Array.from(document.querySelectorAll('[role="button"], button, .btn-submit'));
    const submitRegex = /^(submit|kirim|envoyer|enviar|soumettre|senden|invia|valider)$/i;

    for (const btn of roleButtons) {
      if (btn.offsetParent === null) continue;

      const ariaLabel = (btn.getAttribute('aria-label') || '').trim();
      const text = (btn.textContent || '').trim();
      const jsname = btn.getAttribute('jsname');

      if (submitRegex.test(ariaLabel) || submitRegex.test(text) || jsname === 'M2UYVd') {
        return btn;
      }
    }

    return null;
  }

  /**
   * Detects if the confirmation message is displayed on the page.
   * @returns {boolean}
   */
  function findConfirmationMessage() {
    if (window.location.pathname.endsWith('/formResponse')) {
      return true;
    }

    const confirmEl = document.querySelector('.freebirdFormviewerViewResponseConfirmationMessage, #confirmationView, .vHW8eq');
    if (confirmEl && window.getComputedStyle(confirmEl).display !== 'none') {
      return true;
    }

    const headings = Array.from(document.querySelectorAll('[role="heading"], h1, h2, div'));
    const confirmPatterns = [
      /your response has been recorded/i,
      /recorded your response/i,
      /tanggapan anda telah dicatat/i,
      /votre r.ponse a bien .t. enregistr.e/i,
      /su respuesta ha sido registrada/i
    ];

    for (const h of headings) {
      if (h.offsetParent === null) continue;
      const txt = (h.textContent || '').trim();
      if (confirmPatterns.some(p => p.test(txt))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Finds the "Submit another response" button or link.
   * @returns {HTMLElement | null}
   */
  function findSubmitAnotherResponse() {
    const links = Array.from(document.querySelectorAll('a, [role="link"], button'));
    const linkPatterns = [
      /submit another response/i,
      /kirim tanggapan lain/i,
      /envoyer une autre r.ponse/i,
      /enviar otra respuesta/i
    ];

    for (const link of links) {
      if (link.offsetParent === null) continue;
      const text = (link.textContent || '').trim();
      if (linkPatterns.some(p => p.test(text))) {
        return link;
      }
      if (link.classList.contains('link-fresh') || link.closest('.c2gzKc')) {
        return link;
      }
    }

    const viewformLink = document.querySelector('a[href*="/viewform"]');
    if (viewformLink) return viewformLink;

    return null;
  }

  // --- QUESTION SCANNER ---
  function scanFormQuestions() {
    const containers = findQuestionContainers();
    Logger.debug(`Found ${containers.length} question containers`);

    const questions = [];

    containers.forEach((container, idx) => {
      const { title, required } = getQuestionMetadata(container);
      const type = findQuestionType(container);
      const id = getQuestionIdentifier(container, title, idx);
      const slug = cleanSlug(title);

      const supported = type !== QUESTION_TYPES.UNSUPPORTED;
      const reason = supported ? null : `Unsupported question type: ${type}`;

      const options = supported && [QUESTION_TYPES.RADIO, QUESTION_TYPES.CHECKBOX, QUESTION_TYPES.DROPDOWN, QUESTION_TYPES.SCALE].includes(type)
        ? getQuestionOptions(container, type)
        : [];

      questions.push({
        id,
        slug,
        index: idx,
        title,
        type,
        required,
        supported,
        reason,
        options: options.map(o => ({ id: o.id, slug: o.slug, label: o.label, value: o.value }))
      });
    });

    const formId = getFormIdentifier(window.location.href, document);
    return {
      formId,
      formUrl: window.location.href,
      questions,
      isConfirmation: findConfirmationMessage()
    };
  }

  // --- DISPATCH SIMULATED EVENTS ---
  function clickOption(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: 'auto', block: 'center' });

    // Enclosing Google Forms label / container
    const parentContainer = element.closest('.docssharedWizToggleLabeledContainer, label, .nWQ3Fs, [role="presentation"]') || element;

    // 1. Focus
    if (typeof element.focus === 'function') element.focus();

    // 2. Full mouse/pointer sequence
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    events.forEach(type => {
      const evt = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
      parentContainer.dispatchEvent(evt);
      if (parentContainer !== element) element.dispatchEvent(evt);
    });

    // 3. Click methods
    if (typeof parentContainer.click === 'function') parentContainer.click();
    if (element !== parentContainer && typeof element.click === 'function') element.click();

    // 4. Accessible Space keydown if aria-checked didn't toggle
    setTimeout(() => {
      if (element.getAttribute('aria-checked') === 'false') {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
      }
    }, 50);
  }

  function simulateClick(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: 'auto', block: 'center' });
    const pointerDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });

    element.dispatchEvent(pointerDown);
    element.dispatchEvent(mouseDown);
    element.dispatchEvent(mouseUp);
    element.dispatchEvent(click);
    if (typeof element.click === 'function') element.click();
  }

  function simulateTextInput(element, text) {
    if (!element) return;
    element.focus();
    element.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // --- FORM FILLING LOGIC ---
  function fillForm(weightsConfig = {}, textConfig = {}, plannedSelections = {}) {
    const containers = findQuestionContainers();
    const fillResults = [];

    for (let idx = 0; idx < containers.length; idx++) {
      const container = containers[idx];
      const { title, required } = getQuestionMetadata(container);
      const type = findQuestionType(container);
      const id = getQuestionIdentifier(container, title, idx);
      const slug = cleanSlug(title);

      if (type === QUESTION_TYPES.UNSUPPORTED) {
        if (required) {
          throw new Error(`Required question "${title}" is unsupported and cannot be filled.`);
        }
        fillResults.push({ id, title, type, skipped: true, reason: 'Unsupported optional question' });
        continue;
      }

      // Match question config via id, slug, title, or index
      const qConfig = weightsConfig[id] || weightsConfig[slug] || weightsConfig[title] || weightsConfig[`q_${idx}`] || {};
      const planned = plannedSelections[id] || plannedSelections[slug] || plannedSelections[title] || plannedSelections[`q_${idx}`];

      // Radio & Linear Scale
      if (type === QUESTION_TYPES.RADIO || type === QUESTION_TYPES.SCALE) {
        const domOptions = getQuestionOptions(container, type);
        let selectedOption = null;

        // 1. Check if planned quota selection was provided for this iteration
        if (planned) {
          selectedOption = domOptions.find(o => o.id === planned || o.slug === planned || o.label === planned || o.value === planned);
        }

        // 2. Fallback to cumulative weighted random
        if (!selectedOption) {
          const optionsWithWeights = domOptions.map((opt, oIdx) => ({
            ...opt,
            weight: resolveOptionWeight(qConfig, opt, domOptions.length, oIdx)
          }));
          const { selectedOption: resOpt, error } = selectWeightedSingleOption(optionsWithWeights);
          if (error) throw new Error(`Question "${title}": ${error}`);
          selectedOption = resOpt;
        }

        if (selectedOption && selectedOption.element) {
          clickOption(selectedOption.element);
          fillResults.push({ id, title, type, selected: selectedOption.label });
        }
      }

      // Checkbox
      else if (type === QUESTION_TYPES.CHECKBOX) {
        const domOptions = getQuestionOptions(container, type);
        let selectedIds = null;

        if (planned && Array.isArray(planned)) {
          selectedIds = new Set(planned);
        } else {
          const optionsWithWeights = domOptions.map((opt, oIdx) => ({
            ...opt,
            weight: resolveOptionWeight(qConfig, opt, domOptions.length, oIdx)
          }));
          const { selectedOptions, error } = selectWeightedCheckboxOptions(optionsWithWeights, required);
          if (error) throw new Error(`Question "${title}": ${error}`);
          selectedIds = new Set(selectedOptions.map(o => o.id));
        }

        domOptions.forEach(opt => {
          const shouldBeSelected = selectedIds.has(opt.id) || selectedIds.has(opt.slug) || selectedIds.has(opt.label) || selectedIds.has(opt.value);
          const isCurrentlySelected = opt.element.getAttribute('aria-checked') === 'true';
          if (shouldBeSelected !== isCurrentlySelected) {
            clickOption(opt.element);
          }
        });

        const selectedLabels = domOptions.filter(opt => 
          selectedIds.has(opt.id) || selectedIds.has(opt.slug) || selectedIds.has(opt.label)
        ).map(o => o.label);

        fillResults.push({
          id,
          title,
          type,
          selected: selectedLabels
        });
      }

      // Dropdown
      else if (type === QUESTION_TYPES.DROPDOWN) {
        const domOptions = getQuestionOptions(container, type);
        let selectedOption = null;

        if (planned) {
          selectedOption = domOptions.find(o => o.id === planned || o.slug === planned || o.label === planned || o.value === planned);
        }

        if (!selectedOption) {
          const optionsWithWeights = domOptions.map((opt, oIdx) => ({
            ...opt,
            weight: resolveOptionWeight(qConfig, opt, domOptions.length, oIdx)
          }));
          const { selectedOption: resOpt, error } = selectWeightedSingleOption(optionsWithWeights);
          if (error) throw new Error(`Question "${title}": ${error}`);
          selectedOption = resOpt;
        }

        if (selectedOption) {
          const select = container.querySelector('select');
          if (select) {
            select.value = selectedOption.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            clickOption(selectedOption.element);
          }
          fillResults.push({ id, title, type, selected: selectedOption.label });
        }
      }

      // Text / Paragraph
      else if (type === QUESTION_TYPES.TEXT || type === QUESTION_TYPES.PARAGRAPH) {
        const inputEl = container.querySelector('textarea, input[type="text"], input:not([type])');
        const qTextConf = textConfig[id] || textConfig[slug] || textConfig[title] || textConfig[`q_${idx}`] || {};
        const { value, skip, error } = resolveTextAnswer({ title, required }, qTextConf);

        if (error) throw new Error(error);

        if (!skip && value != null && inputEl) {
          simulateTextInput(inputEl, value);
          fillResults.push({ id, title, type, text: value });
        } else {
          fillResults.push({ id, title, type, skipped: true });
        }
      }
    }

    Logger.info('Form filled successfully:', fillResults);
    return fillResults;
  }

  // --- SUBMISSION OBSERVER ---
  function observeConfirmation(timeoutMs = TIMEOUTS.WAIT_FOR_CONFIRMATION_MS) {
    return new Promise((resolve, reject) => {
      // Immediate check
      if (findConfirmationMessage()) {
        resolve();
        return;
      }

      let timer = null;
      const observer = new MutationObserver(() => {
        if (findConfirmationMessage()) {
          clearTimeout(timer);
          observer.disconnect();
          resolve();
        }
      });

      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      timer = setTimeout(() => {
        observer.disconnect();
        // Final fallback check
        if (findConfirmationMessage()) {
          resolve();
        } else {
          reject(new Error(`Timeout (${timeoutMs / 1000}s) waiting for confirmation page.`));
        }
      }, timeoutMs);
    });
  }

  // --- MESSAGE HANDLER ---
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    Logger.debug('Received message:', request.type);

    if (request.type === MSG.GET_FORM_SCHEMA) {
      try {
        const schema = scanFormQuestions();
        sendResponse({ success: true, schema });
      } catch (err) {
        Logger.error('Failed to scan form schema:', err);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }

    // Quick Test Mode (Fill form, no submit)
    if (request.type === MSG.FILL_CURRENT_FORM) {
      try {
        const fillResults = fillForm(request.weightsConfig, request.textConfig, request.plannedSelections);
        sendResponse({ success: true, fillResults });
      } catch (err) {
        Logger.error('Quick fill failed:', err);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }

    // Bulk Mode step: Fill & Submit (Decoupled from navigation!)
    if (request.type === MSG.EXECUTE_FILL_AND_SUBMIT) {
      try {
        // 1. Fill form with plannedSelections for this iteration!
        Logger.info('Filling form for iteration...', request.plannedSelections);
        fillForm(request.weightsConfig, request.textConfig, request.plannedSelections);

        // 2. Locate submit button
        const submitBtn = findSubmitButton();
        if (!submitBtn) {
          throw new Error('Submit button not found on form.');
        }

        // 3. Immediately reply success so message channel is safely closed before page navigation!
        sendResponse({ success: true, status: 'FILLED' });

        // 4. Click Submit after brief pause for DOM events
        setTimeout(() => {
          try {
            Logger.info('Dispatching submission started message...');
            chrome.runtime.sendMessage({ type: MSG.SUBMISSION_STARTED }).catch(() => {});

            Logger.info('Clicking submit button...');
            simulateClick(submitBtn);

            // Also watch in-page in case of SPA update (no full-page navigation)
            observeConfirmation().then(() => {
              Logger.info('In-page confirmation detected!');
              chrome.runtime.sendMessage({ type: MSG.CONFIRMATION_DETECTED }).catch(() => {});
            }).catch(err => {
              Logger.debug('In-page confirmation observer finished or page navigated:', err.message);
            });
          } catch (submitErr) {
            Logger.error('Submit click failed:', submitErr);
            chrome.runtime.sendMessage({ type: MSG.AUTOMATION_ERROR, error: submitErr.message }).catch(() => {});
          }
        }, 300);

      } catch (err) {
        Logger.error('Fill form failed:', err);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }

    // Reset to fresh form after submission
    if (request.type === MSG.NAVIGATE_FRESH_FORM) {
      try {
        const freshLink = findSubmitAnotherResponse();
        if (freshLink) {
          Logger.info('Found "Submit another response" link. Clicking it...');
          sendResponse({ success: true, method: 'LINK_CLICK' });
          setTimeout(() => simulateClick(freshLink), 100);
        } else if (request.formUrl) {
          Logger.info('Fresh link not found. Navigating to original URL:', request.formUrl);
          sendResponse({ success: true, method: 'LOCATION_HREF' });
          setTimeout(() => { window.location.href = request.formUrl; }, 100);
        } else {
          sendResponse({ success: false, error: 'No fresh link or URL' });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  });

  // Check page state on script initialization (handles full-page navigation)
  if (findConfirmationMessage()) {
    Logger.info('Confirmation page detected on page load!');
    chrome.runtime.sendMessage({ type: MSG.CONFIRMATION_DETECTED }).catch(() => {});
  } else if (findQuestionContainers().length > 0) {
    Logger.info('Form page ready on initial load.');
    chrome.runtime.sendMessage({ type: MSG.FRESH_FORM_READY }).catch(() => {});
  }
})();
