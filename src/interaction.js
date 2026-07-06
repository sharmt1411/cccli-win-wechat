// interaction.js
// 模块级常量：避免在逐行循环中重复编译正则
const _CHECKBOX_FRAG = String.raw`(?:[☐☑☒□■✓✔]|\[[ xX✓✔]\])`;
const OPTION_PATTERN = new RegExp(
  String.raw`(?:^|\s)([>❯]?\s*)?(${_CHECKBOX_FRAG}?\s*)?(\d{1,2})(?:[.)、:：])(?=\s|$|[\[☐☑☒□■✓✔])\s*(${_CHECKBOX_FRAG}?\s*)?`,
  'gu',
);

export function normalizeInteraction(data = {}) {
  const raw = data.interaction || inferLegacyInteraction(data.lastReply) || inferScreenInteraction(data);
  if (!raw) return null;

  const type = normalizeType(raw.type || raw.kind || raw.name);
  if (!type) return null;

  const interactionText = collectInteractionText(data, raw);
  const screenOptions = extractNumberedOptions(interactionText);
  const promptStyle = screenOptions.length
    ? 'numbered'
    : (hasYesNoPrompt(interactionText) ? 'yes_no' : 'unknown');

  if (type === 'ask_user_question') {
    const questions = normalizeQuestions(raw.questions);
    const screenQuestion = extractQuestionFromText(interactionText);
    const activeQuestion = pickQuestion(questions, screenQuestion, interactionText);
    const baseOptions = activeQuestion?.options?.length
      ? activeQuestion.options
      : normalizeOptions(raw.options || raw.choices || raw.suggestions);
    const enrichedScreenOptions = mergeOptionDetails(screenOptions, baseOptions);
    const multiSelect = Boolean(activeQuestion?.multiSelect ?? raw.multiSelect ?? raw.multiselect);
    const selectionMode = (multiSelect || enrichedScreenOptions.some(o => o.checkbox)) ? 'multi' : 'single';

    return {
      type,
      question: String(screenOptions.length ? (screenQuestion || activeQuestion?.question || raw.question || raw.prompt) : (activeQuestion?.question || raw.question || raw.prompt || screenQuestion)).trim(),
      header: activeQuestion?.header || raw.header || '',
      questions,
      activeQuestionIndex: activeQuestion ? questions.indexOf(activeQuestion) : 0,
      options: baseOptions,
      screenOptions: enrichedScreenOptions,
      promptStyle,
      selectionMode,
      multiSelect,
    };
  }

  const selectionMode = screenOptions.some(o => o.checkbox) ? 'multi' : 'single';
  return {
    type: 'tool_permission',
    toolName: String(raw.toolName || raw.tool || raw.name || '').trim(),
    detail: String(raw.detail || raw.command || raw.path || '').trim(),
    options: normalizeOptions(raw.options || raw.choices),
    screenOptions,
    promptStyle,
    selectionMode,
  };
}

export function extractNumberedOptions(text = '') {
  const options = [];
  const seen = new Set();
  let current = null;
  let row = 0;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = cleanupScreenLine(rawLine);
    if (!line || isDividerLine(line) || isHelpLine(line)) {
      current = null;
      continue;
    }

    const lineOptions = extractLineOptions(line, row);
    if (!lineOptions.length) {
      if (current && isOptionDescription(rawLine, line)) {
        current.description = current.description
          ? `${current.description} ${line}`
          : line;
      }
      continue;
    }

    current = null;
    for (const option of lineOptions) {
      if (seen.has(option.number)) continue;
      if (!option.label || option.label.length > 160) continue;

      seen.add(option.number);
      current = option;
      options.push(option);
    }
    row++;
  }

  return options;
}

export function hasYesNoPrompt(text = '') {
  return /(\by\/n\b|\(y\/n\)|\[y\/n\]|\byes\/no\b|\byes\b[\s\S]{0,80}\bno\b)/i.test(String(text));
}

export function resolveQuickReply(text, interaction) {
  if (!interaction) return null;
  const choice = String(text).trim();
  const bracketGroups = parseQuestionGroups(choice);
  const groups = interaction.type === 'ask_user_question'
    ? (bracketGroups.length ? bracketGroups : parseBareQuestionChoice(choice, interaction))
    : bracketGroups;
  if (interaction.type === 'ask_user_question' && groups.length) {
    const batch = groups.length === 1
      ? buildSingleQuestionGroupReply(groups[0], interaction)
      : buildQuestionGroupReply(groups, interaction);
    if (batch) return batch;
  }

  if (interaction.type === 'tool_permission') {
    const permissionChoice = parsePermissionChoice(choice, interaction);
    if (permissionChoice) return permissionChoice;
  }

  const choices = parseChoiceList(choice);
  if (!choices.length) return null;

  if (interaction.type === 'ask_user_question') {
    return null;
  }

  if (interaction.type === 'tool_permission') {
    if (choices.length !== 1) return null;
    const selected = choices[0];
    if (interaction.promptStyle === 'numbered') {
      const option = interaction.screenOptions?.find(o => o.number === selected)
        || interaction.options?.find(o => o.number === selected);
      if (!option && interaction.screenOptions?.length) return null;
      return {
        mode: 'text',
        value: selected,
        label: option ? `${selected}. ${option.label}` : `选项 ${selected}`,
      };
    }

    if (interaction.promptStyle === 'unknown' && ['1', '2', '3'].includes(selected)) {
      const label = selected === '1'
        ? '1. Yes'
        : (selected === '2' ? '2. Yes, allow during this session/project' : '3. No');
      return {
        mode: 'text',
        value: selected,
        label,
      };
    }

    if (selected === '1') {
      return { mode: 'text', value: 'y', label: '1. 同意' };
    }
    if (selected === '2') {
      return { mode: 'text', value: 'n', label: '2. 拒绝' };
    }
  }

  return null;
}

export function truncateText(text = '', maxLen = 800) {
  const s = String(text).trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}\n...(已截断)`;
}

export function sanitizeScreenText(text = '', { maxLen = 1200, maxLineLen = 180 } = {}) {
  const lines = String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/馃憟/g, '')
    .replace(/👈/g, '')
    .split(/\r?\n/)
    .map(line => {
      const trimmedEnd = line.trimEnd();
      if (/^[\s─━═╌╍┄┅\-]{8,}$/.test(trimmedEnd)) return '────────';
      if (trimmedEnd.length <= maxLineLen) return trimmedEnd;
      return `${trimmedEnd.slice(0, maxLineLen - 3)}...`;
    })
    .filter((line, index, arr) => !(line === '────────' && arr[index - 1] === '────────'));

  return truncateText(lines.join('\n').trim(), maxLen);
}

function normalizeType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'askuserquestion' || t === 'ask_user_question') return 'ask_user_question';
  if (t === 'permission' || t === 'tool_permission' || t === 'tooluse' || t === 'tool_use') {
    return 'tool_permission';
  }
  return null;
}

function normalizeOptions(rawOptions) {
  if (!rawOptions) return [];
  const list = Array.isArray(rawOptions) ? rawOptions : [rawOptions];

  return list
    .map((item, index) => {
      if (item == null) return null;
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        const label = String(item).trim();
        return label ? { number: String(index + 1), label, value: label } : null;
      }

      const label = String(item.label || item.text || item.name || item.title || item.value || '').trim();
      const value = String(item.value || item.text || item.label || label).trim();
      const description = String(item.description || item.desc || item.subtitle || '').trim();
      if (!label && !value) return null;

      return {
        number: String(item.number || index + 1),
        label: label || value,
        value: value || label,
        ...(description ? { description } : {}),
      };
    })
    .filter(Boolean);
}

function normalizeQuestions(rawQuestions) {
  if (!rawQuestions) return [];
  const list = Array.isArray(rawQuestions) ? rawQuestions : [rawQuestions];

  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const question = String(item.question || item.prompt || item.text || '').trim();
      const header = String(item.header || item.title || '').trim();
      const options = normalizeOptions(item.options || item.choices || item.suggestions);
      const multiSelect = Boolean(item.multiSelect ?? item.multiselect ?? item.multi_select);
      if (!question && !header && !options.length) return null;
      return { question, header, options, multiSelect };
    })
    .filter(Boolean);
}

function pickQuestion(questions, screenQuestion, interactionText) {
  if (!questions.length) return null;

  const normalizedScreenQuestion = normalizeComparableText(screenQuestion);
  if (normalizedScreenQuestion) {
    const byQuestion = questions.find(q => normalizeComparableText(q.question) === normalizedScreenQuestion)
      || questions.find(q => normalizeComparableText(q.question).includes(normalizedScreenQuestion)
        || normalizedScreenQuestion.includes(normalizeComparableText(q.question)));
    if (byQuestion) return byQuestion;
  }

  const text = normalizeComparableText(interactionText);
  const byHeader = questions.find(q => q.header && text.includes(normalizeComparableText(q.header)));
  if (byHeader) return byHeader;

  return questions[0];
}

function mergeOptionDetails(screenOptions, structuredOptions) {
  if (!screenOptions.length) return [];
  if (!structuredOptions.length) return screenOptions;

  return screenOptions.map((option, index) => {
    const match = structuredOptions.find(o => normalizeComparableText(o.label) === normalizeComparableText(option.label))
      || structuredOptions[index];
    if (!match) return option;

    return {
      ...option,
      description: option.description || match.description,
      structuredValue: match.value,
    };
  });
}

function normalizeComparableText(text = '') {
  return String(text)
    .replace(/[：:]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function inferLegacyInteraction(lastReply = '') {
  const text = String(lastReply);
  const questionMatch = text.match(/❓\s*问题:\s*([\s\S]*)$/);
  if (questionMatch) {
    return {
      type: 'ask_user_question',
      question: questionMatch[1].trim(),
    };
  }

  const permissionMatch = text.match(/🛡️\s*请求授权工具:\s*([^\n]+)/);
  if (permissionMatch) {
    return {
      type: 'tool_permission',
      detail: permissionMatch[1].trim(),
    };
  }

  return null;
}

function inferScreenInteraction(data = {}) {
  if (data.event !== 'Notification') return null;

  const interactionText = collectInteractionText(data);
  if (!extractNumberedOptions(interactionText).length && !hasYesNoPrompt(interactionText)) return null;

  return {
    type: 'tool_permission',
    detail: data.action || '需要确认',
  };
}

function collectInteractionText(data = {}, raw = {}) {
  return [
    data.screenText,
    raw.screenText,
    data.action,
    data.lastReply,
    raw.detail,
    raw.question,
  ]
    .filter(Boolean)
    .map(String)
    .join('\n');
}

function extractQuestionFromText(text = '') {
  let question = '';

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = cleanupScreenLine(rawLine);
    if (!line || isDividerLine(line) || isHelpLine(line)) continue;
    if (extractLineOptions(line, 0).length) break;
    if (/^[☐☑☒]\s*/.test(line)) continue;
    question = line;
  }

  return question;
}

function cleanupScreenLine(line) {
  return String(line)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[│┃║]/g, ' ')
    .replace(/[╭╮╰╯┌┐└┘├┤┬┴┼─━═]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLineOptions(line, row) {
  // 重置 lastIndex，复用模块级常量避免每次 new RegExp
  OPTION_PATTERN.lastIndex = 0;
  const matches = [...line.matchAll(OPTION_PATTERN)];
  const options = [];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (i === 0 && match.index > 0) return []; // 防止匹配到代码段中间的内容（例如 if(a==1) ）
    const start = match.index + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : line.length;
    let label = line
      .slice(start, end)
      .replace(/\s+👈$/, '')
      .trim();

    if (!label) continue;

    const checkboxMark = ((match[2] || '') + (match[4] || '')).trim();
    if (checkboxMark) {
      label = label.replace(/^(?:[☐☑☒□■✓✔]|\[[ xX✓✔]\])\s*/u, '').trim();
    }
    if (!label) continue;
    
    // 额外安全检查：如果 label 几乎全是代码符号（比如 `{` 或者 `} `），说明极有可能是代码行首的 1) { 误判
    if (/^[{}()[\]=+\-*/<>&|;,'"`]+$/.test(label.replace(/\s/g, ''))) continue;

    options.push({
      number: match[3],
      label,
      value: match[3],
      row,
      col: options.length,
      cursor: Boolean((match[1] || '').includes('>') || (match[1] || '').includes('❯')),
      checkbox: Boolean(checkboxMark),
      checked: /[☑☒■✓✔]/u.test(checkboxMark),
    });
  }

  return options;
}

function parseChoiceList(choice) {
  if (!/^\d{1,2}(?:\s*[,，、\s]\s*\d{1,2})*$/.test(choice)) return [];
  return choice
    .split(/[,，、\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function parsePermissionChoice(choice, interaction) {
  const normalized = normalizeComparableText(choice);
  if (!normalized) return null;

  const yesWords = new Set(['y', 'yes', '同意', '确认', '允许运行', '允许', '执行']);
  const noWords = new Set(['n', 'no', '拒绝', '取消', '不允许', '否']);
  const isYes = yesWords.has(normalized);
  const isNo = noWords.has(normalized);
  if (!isYes && !isNo) return null;

  if (interaction.promptStyle === 'numbered' || interaction.promptStyle === 'unknown') {
    const options = [...(interaction.screenOptions || []), ...(interaction.options || [])];
    const option = isNo
      ? options.find(o => /\bno\b|拒绝|取消|不允许|否/i.test(o.label))
      : options.find(o => /\byes\b|同意|允许|执行/i.test(o.label));
    const number = option?.number || (isNo ? '3' : '1');
    return {
      mode: 'text',
      value: number,
      label: option ? `${number}. ${option.label}` : (isNo ? '3. No' : '1. Yes'),
    };
  }

  return isNo
    ? { mode: 'text', value: 'n', label: '拒绝' }
    : { mode: 'text', value: 'y', label: '同意' };
}

function parseQuestionGroups(choice) {
  const text = String(choice).trim();
  if (!/^(?:\[[\d\s,，、]+\]\s*)+$/.test(text)) return [];
  return [...text.matchAll(/\[([^\]]+)\]/g)]
    .map(match => parseChoiceList(match[1]))
    .filter(group => group.length);
}

function parseBareQuestionChoice(choice, interaction) {
  if (interaction?.type !== 'ask_user_question') return [];
  const choices = parseChoiceList(String(choice).trim());
  if (choices.length !== 1) return [];

  const selected = choices[0];
  const exists = [...(interaction.screenOptions || []), ...(interaction.options || [])]
    .some(option => option.number === selected);
  return exists ? [choices] : [];
}

function buildQuestionGroupReply(groups, interaction) {
  const questions = interaction.questions || [];
  if (!questions.length || groups.length > questions.length) return null;

  const startIndex = Math.max(0, interaction.activeQuestionIndex || 0);
  const keys = [];
  let currentQuestionIndex = startIndex;
  let currentOption = interaction.screenOptions?.find(o => o.cursor)
    || interaction.screenOptions?.[0]
    || makeStructuredOptions(questions[startIndex] || questions[0])[0];

  for (let targetQuestionIndex = 0; targetQuestionIndex < groups.length; targetQuestionIndex++) {
    while (currentQuestionIndex < targetQuestionIndex) {
      keys.push('right');
      currentQuestionIndex++;
      currentOption = makeStructuredOptions(questions[currentQuestionIndex])[0];
    }
    while (currentQuestionIndex > targetQuestionIndex) {
      keys.push('left');
      currentQuestionIndex--;
      currentOption = makeStructuredOptions(questions[currentQuestionIndex])[0];
    }

    const question = questions[targetQuestionIndex];
    const visibleOptions = targetQuestionIndex === startIndex && interaction.screenOptions?.length
      ? mergeOptionDetails(interaction.screenOptions, question.options)
      : makeStructuredOptions(question);
    const questionKeys = question.multiSelect
      ? buildMultiSelectKeys(groups[targetQuestionIndex], visibleOptions, currentOption)
      : buildSingleSelectKeys(groups[targetQuestionIndex], visibleOptions, currentOption);
    if (!questionKeys) return null;

    keys.push(...questionKeys.keys);
    currentOption = questionKeys.currentOption;
  }

  keys.push('right', 'enter');

  return {
    mode: 'keys',
    value: keys,
    label: groups.map(group => `[${group.join(', ')}]`).join(''),
  };
}

function buildSingleQuestionGroupReply(choices, interaction) {
  if (interaction.selectionMode === 'multi' && interaction.screenOptions?.length) {
    return buildMultiSelectReply(choices, interaction);
  }

  if (interaction.selectionMode === 'multi' && interaction.options?.length) {
    const selectedOptions = choices
      .map(n => interaction.options.find(o => o.number === n))
      .filter(Boolean);
    if (selectedOptions.length !== choices.length) return null;
    return {
      mode: 'text',
      value: selectedOptions.map(o => o.value || o.label).join(', '),
      label: `[${choices.join(' ')}]`,
    };
  }

  if (choices.length !== 1) return null;
  const selected = choices[0];
  const screenOption = interaction.screenOptions?.find(o => o.number === selected);
  if (screenOption) {
    const current = interaction.screenOptions.find(o => o.cursor) || interaction.screenOptions[0];
    return {
      mode: 'keys',
      value: [...navigationKeys(current, screenOption), 'enter'],
      label: `[${selected}] ${screenOption.label}`,
    };
  }

  const option = interaction.options?.find(o => o.number === selected);
  if (option) {
    return {
      mode: 'text',
      value: option.value || option.label,
      label: `[${selected}] ${option.label}`,
    };
  }

  return null;
}

function makeStructuredOptions(question = {}) {
  return (question.options || []).map((option, index) => ({
    ...option,
    number: option.number || String(index + 1),
    value: option.value || option.label,
    row: index,
    col: 0,
    checkbox: Boolean(question.multiSelect),
    checked: false,
    cursor: index === 0,
  }));
}

function buildMultiSelectKeys(choices, options, currentOption) {
  const targetNumbers = new Set(choices);
  if (choices.some(n => !options.some(o => o.number === n))) return null;

  const keys = [];
  let current = currentOption || options[0];
  for (const option of options.filter(o => targetNumbers.has(o.number))) {
    keys.push(...navigationKeys(current, option));
    keys.push('space');
    current = option;
  }
  return { keys, currentOption: current };
}

function buildSingleSelectKeys(choices, options, currentOption) {
  if (choices.length !== 1) return null;
  const option = options.find(o => o.number === choices[0]);
  if (!option) return null;
  return {
    keys: [...navigationKeys(currentOption || options[0], option), 'enter'],
    currentOption: option,
  };
}

function buildMultiSelectReply(choices, interaction) {
  const options = interaction.screenOptions || [];
  const targetNumbers = new Set(choices);
  const unknown = choices.filter(n => !options.some(o => o.number === n));
  if (unknown.length) return null;

  const nonCheckboxTargets = options.filter(o => targetNumbers.has(o.number) && !o.checkbox);
  if (nonCheckboxTargets.length) {
    if (choices.length !== 1) return null;
    const target = nonCheckboxTargets[0];
    const current = options.find(o => o.cursor) || options[0];
    return {
      mode: 'keys',
      value: [...navigationKeys(current, target), 'enter'],
      label: `${target.number}. ${target.label}`,
    };
  }

  const hasCheckedState = options.some(o => o.checkbox);
  const toggles = hasCheckedState
    ? options.filter(o => o.checkbox && Boolean(o.checked) !== targetNumbers.has(o.number))
    : options.filter(o => targetNumbers.has(o.number));
  const keys = [];
  let current = options.find(o => o.cursor) || options[0];

  for (const option of toggles) {
    keys.push(...navigationKeys(current, option));
    keys.push('space');
    current = option;
  }

  return {
    mode: 'keys',
    value: keys,
    label: choices.join(', '),
  };
}

function navigationKeys(from, to) {
  const keys = [];
  const rowDelta = (to.row || 0) - (from.row || 0);
  const colDelta = (to.col || 0) - (from.col || 0);
  const rowKey = rowDelta > 0 ? 'down' : 'up';
  const colKey = colDelta > 0 ? 'right' : 'left';

  for (let i = 0; i < Math.abs(rowDelta); i++) keys.push(rowKey);
  for (let i = 0; i < Math.abs(colDelta); i++) keys.push(colKey);
  return keys;
}

function isDividerLine(line) {
  return /^[\s─━═\-]{8,}$/.test(line);
}

function isHelpLine(line) {
  return /\b(Enter to select|to navigate|Esc to cancel)\b/i.test(line);
}

function isOptionDescription(rawLine, line) {
  if (!line) return false;
  if (extractLineOptions(line, 0).length) return false;
  if (isDividerLine(line) || isHelpLine(line)) return false;
  return /^[\s│┃║]{2,}\S/.test(String(rawLine));
}
