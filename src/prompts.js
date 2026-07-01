import readline from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { confirm as inquirerConfirm, input as inquirerInput, select as inquirerSelect, Separator } from '@inquirer/prompts';
import { SelectionCancelledError } from './errors.js';

const ANSI_INVERSE = '\x1b[7m';
const ANSI_INVERSE_OFF = '\x1b[27m';
const ANSI_CLEAR_LINE = '\x1b[2K';
const ANSI_HIDE_CURSOR = '\x1b[?25l';
const ANSI_SHOW_CURSOR = '\x1b[?25h';

function promptOutput(runtime) {
  return runtime.stderr || runtime.stdout;
}

function promptContext(runtime, { signal } = {}) {
  return {
    input: runtime.stdin,
    output: promptOutput(runtime),
    signal
  };
}

function canUseInteractivePrompt(runtime) {
  return Boolean(runtime.stdin.isTTY && promptOutput(runtime).isTTY && typeof runtime.stdin.setRawMode === 'function');
}

function isPromptCancellation(error) {
  return error?.name === 'AbortPromptError' || error?.name === 'CancelPromptError' || error?.name === 'ExitPromptError';
}

function highlightedSelection(text) {
  return `${ANSI_INVERSE}${text}${ANSI_INVERSE_OFF}`;
}

function menuLines(label, choices, selectedIndex, { header } = {}) {
  return [
    `? ${label}`,
    ...(header ? [`  ${header}`] : []),
    ...choices.map((choice, index) => `  ${index === selectedIndex ? highlightedSelection(choice.label) : choice.label}`),
    '  Enter switch  n new  r remove  c config'
  ];
}

function writeMenu(output, lines, previousLineCount) {
  if (previousLineCount > 0) {
    output.write(`\x1b[${previousLineCount}A`);
  }

  for (const line of lines) {
    output.write(`${ANSI_CLEAR_LINE}\r${line}\n`);
  }

  return lines.length;
}

function runMenuPrompt(runtime, label, choices, options = {}) {
  const output = promptOutput(runtime);
  let selectedIndex = 0;
  let renderedLineCount = 0;
  let settled = false;
  const previousRawMode = runtime.stdin.isRaw;

  emitKeypressEvents(runtime.stdin);
  runtime.stdin.resume();
  runtime.stdin.setRawMode(true);
  output.write(ANSI_HIDE_CURSOR);

  return new Promise((resolve, reject) => {
    function render() {
      renderedLineCount = writeMenu(output, menuLines(label, choices, selectedIndex, options), renderedLineCount);
    }

    function cleanup() {
      runtime.stdin.off('keypress', onKeypress);
      runtime.stdin.setRawMode(Boolean(previousRawMode));
      runtime.stdin.pause();
      output.write(ANSI_SHOW_CURSOR);
    }

    function settle(callback, value) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback(value);
    }

    function onKeypress(character, key = {}) {
      if (key.ctrl && key.name === 'c') {
        settle(reject, new SelectionCancelledError());
        return;
      }

      if (key.name === 'escape') {
        settle(reject, new SelectionCancelledError());
        return;
      }

      if (key.name === 'up') {
        selectedIndex = selectedIndex === 0 ? choices.length - 1 : selectedIndex - 1;
        render();
        return;
      }

      if (key.name === 'down') {
        selectedIndex = selectedIndex === choices.length - 1 ? 0 : selectedIndex + 1;
        render();
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        settle(resolve, { action: 'switch', value: choices[selectedIndex].value });
        return;
      }

      const shortcut = String(character || key.name || '').toLowerCase();

      if (shortcut === 'n') {
        settle(resolve, { action: 'new' });
        return;
      }

      if (shortcut === 'r') {
        settle(resolve, { action: 'remove', value: choices[selectedIndex].value });
        return;
      }

      if (shortcut === 'c') {
        settle(resolve, { action: 'config' });
      }
    }

    runtime.stdin.on('keypress', onKeypress);
    render();
  });
}

async function runPrompt(runtime, prompt) {
  const controller = new AbortController();
  let escaped = false;

  function onKeypress(character, key = {}) {
    if (key.name === 'escape') {
      escaped = true;
      controller.abort();
    }
  }

  emitKeypressEvents(runtime.stdin);
  runtime.stdin.on('keypress', onKeypress);

  try {
    return await prompt(controller.signal);
  } catch (error) {
    if (escaped || isPromptCancellation(error)) {
      throw new SelectionCancelledError();
    }

    throw error;
  } finally {
    runtime.stdin.off('keypress', onKeypress);
  }
}

export function createPromptAdapter(runtime) {
  async function question(message, { output = promptOutput(runtime) } = {}) {
    const rl = readline.createInterface({
      input: runtime.stdin,
      output
    });

    try {
      return await rl.question(message);
    } finally {
      rl.close();
    }
  }

  return {
    async ask(label, { defaultValue = '', validate } = {}) {
      if (canUseInteractivePrompt(runtime)) {
        let validatedValue;
        let hasValidated = false;
        const answer = await runPrompt(runtime, (signal) =>
          inquirerInput(
            {
              message: label,
              default: defaultValue,
              validate: validate
                ? (value) => {
                    try {
                      validatedValue = validate(value);
                      hasValidated = true;
                      return true;
                    } catch (error) {
                      return error.message;
                    }
                  }
                : undefined
            },
            promptContext(runtime, { signal })
          )
        );

        return hasValidated ? validatedValue : answer;
      }

      while (true) {
        const defaultLabel = defaultValue ? ` (${defaultValue})` : '';
        const answer = (await question(`${label}${defaultLabel}: `)).trim();
        const value = answer || defaultValue;

        try {
          return validate ? validate(value) : value;
        } catch (error) {
          runtime.stderr.write(`${error.message}\n`);
        }
      }
    },

    async confirm(label, { defaultValue = false } = {}) {
      if (canUseInteractivePrompt(runtime)) {
        return runPrompt(runtime, (signal) => inquirerConfirm({ message: label, default: defaultValue }, promptContext(runtime, { signal })));
      }

      const suffix = defaultValue ? 'Y/n' : 'y/N';
      const answer = (await question(`${label} (${suffix}): `)).trim().toLowerCase();

      if (!answer) {
        return defaultValue;
      }

      return answer === 'y' || answer === 'yes';
    },

    async select(label, choices, { header } = {}) {
      if (choices.length === 0) {
        throw new Error('no choices available');
      }

      const output = promptOutput(runtime);

      if (canUseInteractivePrompt(runtime)) {
        return runPrompt(runtime, (signal) =>
          inquirerSelect(
            {
              message: label,
              choices: [
                ...(header ? [new Separator(header)] : []),
                ...choices.map((choice) => ({
                  name: choice.label,
                  value: choice.value
                }))
              ],
              theme: {
                style: {
                  highlight: highlightedSelection
                }
              }
            },
            promptContext(runtime, { signal })
          )
        );
      }

      output.write(`${label}\n`);
      if (header) {
        output.write(`  ${header}\n`);
      }

      choices.forEach((choice, index) => {
        output.write(`  ${index + 1}. ${choice.label}\n`);
      });

      while (true) {
        const answer = (await question('Select a number: ')).trim();
        const selectedIndex = Number.parseInt(answer, 10) - 1;

        if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < choices.length) {
          return choices[selectedIndex].value;
        }

        runtime.stderr.write('Enter a valid selection number.\n');
      }
    },

    async worktreeMenu(label, choices, { header } = {}) {
      if (choices.length === 0) {
        throw new Error('no choices available');
      }

      const output = promptOutput(runtime);

      if (canUseInteractivePrompt(runtime)) {
        return runMenuPrompt(runtime, label, choices, { header });
      }

      output.write(`${label}\n`);
      if (header) {
        output.write(`  ${header}\n`);
      }

      choices.forEach((choice, index) => {
        output.write(`  ${index + 1}. ${choice.label}\n`);
      });
      output.write('  n. New worktree\n');
      output.write('  r. Remove first listed worktree\n');
      output.write('  c. Config\n');

      while (true) {
        const answer = (await question('Select a number, n, r, or c: ')).trim().toLowerCase();

        if (!answer) {
          return { action: 'switch', value: choices[0].value };
        }

        if (answer === 'n') {
          return { action: 'new' };
        }

        if (answer === 'r') {
          return { action: 'remove', value: choices[0].value };
        }

        if (answer === 'c') {
          return { action: 'config' };
        }

        const selectedIndex = Number.parseInt(answer, 10) - 1;

        if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < choices.length) {
          return { action: 'switch', value: choices[selectedIndex].value };
        }

        runtime.stderr.write('Enter a valid selection number or action.\n');
      }
    }
  };
}
