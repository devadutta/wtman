import readline from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { SelectionCancelledError } from './errors.js';

function formatDefault(defaultValue) {
  return defaultValue ? ` (${defaultValue})` : '';
}

function renderMenu(output, label, choices, selectedIndex, hasRendered) {
  if (hasRendered) {
    output.write(`\x1B[${choices.length + 1}F\x1B[0J`);
  }

  output.write(`${label}\n`);
  choices.forEach((choice, index) => {
    const marker = index === selectedIndex ? '>' : ' ';
    output.write(`${marker} ${choice.label}\n`);
  });
}

export function createPromptAdapter(runtime) {
  async function question(message) {
    const rl = readline.createInterface({
      input: runtime.stdin,
      output: runtime.stdout
    });

    try {
      return await rl.question(message);
    } finally {
      rl.close();
    }
  }

  return {
    async ask(label, { defaultValue = '', validate } = {}) {
      while (true) {
        const answer = (await question(`${label}${formatDefault(defaultValue)}: `)).trim();
        const value = answer || defaultValue;

        try {
          return validate ? validate(value) : value;
        } catch (error) {
          runtime.stderr.write(`${error.message}\n`);
        }
      }
    },

    async confirm(label, { defaultValue = false } = {}) {
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

      const output = runtime.stderr || runtime.stdout;

      if (!runtime.stdin.isTTY || !output.isTTY || typeof runtime.stdin.setRawMode !== 'function') {
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

      return new Promise((resolve, reject) => {
        let selectedIndex = 0;
        let hasRendered = false;
        const wasRaw = runtime.stdin.isRaw;

        function cleanup() {
          runtime.stdin.off('keypress', onKeypress);
          runtime.stdin.setRawMode(wasRaw);
          runtime.stdin.pause();
          output.write('\x1B[?25h');
        }

        function rerender() {
          renderMenu(output, label, choices, selectedIndex, hasRendered);
          hasRendered = true;
        }

        function onKeypress(character, key = {}) {
          if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
            cleanup();
            output.write('\n');
            reject(new SelectionCancelledError());
            return;
          }

          if (key.name === 'up' || character === 'k') {
            selectedIndex = (selectedIndex - 1 + choices.length) % choices.length;
            rerender();
            return;
          }

          if (key.name === 'down' || character === 'j') {
            selectedIndex = (selectedIndex + 1) % choices.length;
            rerender();
            return;
          }

          if (key.name === 'return' || key.name === 'enter') {
            const selected = choices[selectedIndex].value;
            cleanup();
            output.write('\n');
            resolve(selected);
          }
        }

        emitKeypressEvents(runtime.stdin);
        runtime.stdin.on('keypress', onKeypress);
        runtime.stdin.setRawMode(true);
        runtime.stdin.resume();
        output.write('\x1B[?25l');
        rerender();
      });
    }
  };
}
