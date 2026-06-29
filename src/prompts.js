import readline from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { confirm as inquirerConfirm, input as inquirerInput, select as inquirerSelect } from '@inquirer/prompts';
import { SelectionCancelledError } from './errors.js';

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

    async select(label, choices) {
      if (choices.length === 0) {
        throw new Error('no choices available');
      }

      const output = promptOutput(runtime);

      if (canUseInteractivePrompt(runtime)) {
        return runPrompt(runtime, (signal) =>
          inquirerSelect(
            {
              message: label,
              choices: choices.map((choice) => ({
                name: choice.label,
                value: choice.value
              }))
            },
            promptContext(runtime, { signal })
          )
        );
      }

      output.write(`${label}\n`);
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
    }
  };
}
